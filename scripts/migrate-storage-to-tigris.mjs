// One-time copy of every file from Supabase Storage to the Tigris bucket:
//   library/<path>        ← Supabase bucket "library"
//   logos/<path>          ← Supabase bucket "company-logos"
// Paths stored in the database don't change. Safe to re-run: objects already in Tigris with
// the same size are skipped. Supabase objects are only read, never deleted.
//
//   pnpm storage:migrate
//
// When the 20261007000200_tigris_storage migration is already applied, each object is also
// recorded in the object ledger (the migration itself records everything present at that time).
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
};

const BUCKETS = [
  { from: "library", to: "library" },
  { from: "company-logos", to: "logos" },
];

const supabase = createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });
const bucket = need("TIGRIS_STORAGE_BUCKET");
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.TIGRIS_STORAGE_ENDPOINT || "https://t3.storage.dev",
  credentials: { accessKeyId: need("TIGRIS_STORAGE_ACCESS_KEY_ID"), secretAccessKey: need("TIGRIS_STORAGE_SECRET_ACCESS_KEY") },
});

/** Every object under a Supabase bucket (folders are listed recursively, 1000 per page). */
async function listAll(from, prefix = "") {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(from).list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`list ${from}/${prefix}: ${error.message}`);
    for (const o of data) {
      const name = prefix ? `${prefix}/${o.name}` : o.name;
      if (o.id === null) out.push(...(await listAll(from, name)));
      else out.push({ name, size: Number(o.metadata?.size ?? 0), mime: o.metadata?.mimetype || "application/octet-stream" });
    }
    if (data.length < 1000) return out;
  }
}

async function tigrisSize(key) {
  try {
    return Number((await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentLength ?? -1);
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") return null;
    throw e;
  }
}

let ledger = true;
async function record(to, o) {
  if (!ledger) return;
  const { error } = await supabase.rpc("storage_record_object", { p_bucket: to, p_name: o.name, p_size: o.size, p_mime: o.mime });
  if (error) {
    ledger = false;
    console.log("  (ledger not recorded: migration 20261007000200 not applied yet; it records these objects when applied)");
  }
}

let failures = 0;
for (const { from, to } of BUCKETS) {
  const objects = await listAll(from);
  let copied = 0, skipped = 0, bytes = 0;
  console.log(`${from} → ${bucket}/${to}/  (${objects.length} objects)`);
  for (const o of objects) {
    const key = `${to}/${o.name}`;
    try {
      if ((await tigrisSize(key)) === o.size) {
        skipped++;
      } else {
        const { data, error } = await supabase.storage.from(from).download(o.name);
        if (error) throw new Error(error.message);
        const body = Buffer.from(await data.arrayBuffer());
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: o.mime, ContentLength: body.length }));
        if ((await tigrisSize(key)) !== body.length) throw new Error("size mismatch after upload");
        copied++;
      }
      bytes += o.size;
      await record(to, o);
    } catch (e) {
      failures++;
      console.log(`  FAILED ${o.name}: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }
  console.log(`  copied ${copied}, already there ${skipped}, failed ${objects.length - copied - skipped}, ${(bytes / 1048576).toFixed(2)} MB`);
}
if (failures) {
  console.log(`${failures} object(s) failed; re-run to retry.`);
  process.exit(1);
}
console.log("Done. Supabase Storage was left untouched.");
