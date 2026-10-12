import "server-only";
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand, CreateMultipartUploadCommand, DeleteObjectsCommand,
  GetObjectCommand, HeadObjectCommand, ListPartsCommand, PutObjectCommand, S3Client, UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { storageKey, type StorageBucket } from "@/lib/storage-paths";

// Files live in one private Tigris (S3-compatible) bucket. The browser never holds Tigris
// credentials: the server authorizes the user (RLS) and hands out short-lived presigned URLs.
export { storageKey, type StorageBucket } from "@/lib/storage-paths";

let client: S3Client | null = null;

function s3() {
  client ??= new S3Client({
    region: "auto",
    endpoint: process.env.TIGRIS_STORAGE_ENDPOINT || "https://t3.storage.dev",
    credentials: {
      accessKeyId: serverEnv("TIGRIS_STORAGE_ACCESS_KEY_ID"),
      secretAccessKey: serverEnv("TIGRIS_STORAGE_SECRET_ACCESS_KEY"),
    },
  });
  return client;
}

const bucketName = () => serverEnv("TIGRIS_STORAGE_BUCKET");

/** "attachment" with an ASCII fallback plus the UTF-8 name (RFC 6266). */
function attachment(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Upload URL for one object; Tigris rejects a body whose type or length differs from what was signed. */
export function presignPut(bucket: StorageBucket, name: string, contentType: string, size: number, expiresIn = 300) {
  const cmd = new PutObjectCommand({ Bucket: bucketName(), Key: storageKey(bucket, name), ContentType: contentType, ContentLength: size });
  return getSignedUrl(s3(), cmd, { expiresIn, signableHeaders: new Set(["content-type", "content-length"]) });
}

/** Read URL (signed locally, no network call). With downloadName the browser saves instead of showing. */
export function presignGet(bucket: StorageBucket, name: string, opts: { expiresIn: number; downloadName?: string }) {
  const cmd = new GetObjectCommand({
    Bucket: bucketName(),
    Key: storageKey(bucket, name),
    ...(opts.downloadName ? { ResponseContentDisposition: attachment(opts.downloadName) } : {}),
  });
  return getSignedUrl(s3(), cmd, { expiresIn: opts.expiresIn });
}

/** Size and type as stored in Tigris, or null when the object doesn't exist. */
export async function headObject(bucket: StorageBucket, name: string) {
  try {
    const r = await s3().send(new HeadObjectCommand({ Bucket: bucketName(), Key: storageKey(bucket, name) }));
    return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType ?? "" };
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (e as { name?: string }).name === "NotFound") return null;
    throw e;
  }
}

export async function copyObject(bucket: StorageBucket, from: string, to: string) {
  const b = bucketName();
  await s3().send(new CopyObjectCommand({ Bucket: b, CopySource: `${b}/${storageKey(bucket, from)}`, Key: storageKey(bucket, to) }));
}

/** Deletes objects (missing ones count as deleted). Returns the names that failed. */
export async function deleteObjects(bucket: StorageBucket, names: string[]) {
  if (!names.length) return [];
  const r = await s3().send(
    new DeleteObjectsCommand({ Bucket: bucketName(), Delete: { Objects: names.map((n) => ({ Key: storageKey(bucket, n) })), Quiet: true } }),
  );
  const prefix = `${bucket}/`;
  return (r.Errors ?? []).map((e) => (e.Key ?? "").slice(prefix.length)).filter(Boolean);
}

// The object ledger (private.storage_objects) lets the database verify that a registered
// file really exists. Only the server writes it, after authorizing the user and checking Tigris.

/** Marks an issued upload URL, so an upload that is never registered can be cleaned up later. */
export async function recordPending(bucket: StorageBucket, name: string) {
  const { error } = await createAdminClient().rpc("storage_record_object", { p_bucket: bucket, p_name: name });
  if (error) throw new Error(`storage ledger: ${error.message}`);
}

/** Records an object seen in Tigris, with its real size and type. */
export async function recordConfirmed(bucket: StorageBucket, name: string, size: number, mime: string) {
  const { error } = await createAdminClient().rpc("storage_record_object", { p_bucket: bucket, p_name: name, p_size: size, p_mime: mime });
  if (error) throw new Error(`storage ledger: ${error.message}`);
}

/**
 * After the browser's PUT: checks the object in Tigris and records its real size/type, so the
 * database can register it. A wrong type or size is deleted. Returns a dbError code on failure.
 */
export async function confirmUpload(bucket: StorageBucket, name: string, allowed: { mimes: readonly string[]; maxBytes: number }) {
  const head = await headObject(bucket, name);
  if (!head) return "file_not_uploaded" as const;
  const mime = head.contentType.split(";")[0].trim().toLowerCase();
  if (!allowed.mimes.includes(mime) || head.size <= 0 || head.size > allowed.maxBytes) {
    await deleteObjects(bucket, [name]);
    await forgetObjects(bucket, [name]);
    return "invalid_file_type" as const;
  }
  await recordConfirmed(bucket, name, head.size, mime);
  return null;
}

export async function forgetObjects(bucket: StorageBucket, names: string[]) {
  if (!names.length) return;
  const { error } = await createAdminClient().rpc("storage_forget_objects", { p_bucket: bucket, p_names: names });
  if (error) throw new Error(`storage ledger: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Browser uploads signed request by request (Uppy's S3 plugin): a simple PUT for small files,
// multipart (create → parts → complete, or abort) for big ones. Size and type are checked with
// HEAD afterwards (confirmUpload), because a presigned multipart upload can't bound them.
// ---------------------------------------------------------------------------
export type UploadSignRequest =
  | { op: "put"; contentType: string }
  | { op: "create"; contentType: string }
  | { op: "part"; uploadId: string; partNumber: number }
  | { op: "complete"; uploadId: string }
  | { op: "abort"; uploadId: string }
  | { op: "list"; uploadId: string };

export function presignUploadRequest(bucket: StorageBucket, name: string, r: UploadSignRequest, expiresIn = 900) {
  const Bucket = bucketName();
  const Key = storageKey(bucket, name);
  switch (r.op) {
    case "put":
      return getSignedUrl(s3(), new PutObjectCommand({ Bucket, Key, ContentType: r.contentType }), { expiresIn, signableHeaders: new Set(["content-type"]) });
    case "create":
      return getSignedUrl(s3(), new CreateMultipartUploadCommand({ Bucket, Key, ContentType: r.contentType }), { expiresIn, signableHeaders: new Set(["content-type"]) });
    case "part":
      return getSignedUrl(s3(), new UploadPartCommand({ Bucket, Key, UploadId: r.uploadId, PartNumber: r.partNumber }), { expiresIn });
    case "complete":
      return getSignedUrl(s3(), new CompleteMultipartUploadCommand({ Bucket, Key, UploadId: r.uploadId }), { expiresIn });
    case "abort":
      return getSignedUrl(s3(), new AbortMultipartUploadCommand({ Bucket, Key, UploadId: r.uploadId }), { expiresIn });
    case "list":
      return getSignedUrl(s3(), new ListPartsCommand({ Bucket, Key, UploadId: r.uploadId }), { expiresIn });
  }
}

/** Whether a pending (issued, not yet confirmed) upload exists in the ledger for this name. */
export async function isPendingUpload(bucket: StorageBucket, name: string) {
  const { data } = await createAdminClient().rpc("storage_object_state", { p_bucket: bucket, p_name: name });
  return data === "pending";
}
