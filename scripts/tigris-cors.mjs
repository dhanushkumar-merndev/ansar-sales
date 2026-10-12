// Sets the Tigris bucket's CORS rules so browsers can PUT uploads and GET files with
// presigned URLs. Run once per bucket, and again when the app's domain changes:
//   pnpm storage:cors                       (origins: APP_URL, NEXT_PUBLIC_APP_URL, localhost)
//   pnpm storage:cors https://crm.example   (extra origins as arguments)
import { GetBucketCorsCommand, PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
};

const bucket = need("TIGRIS_STORAGE_BUCKET");
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.TIGRIS_STORAGE_ENDPOINT || "https://t3.storage.dev",
  credentials: { accessKeyId: need("TIGRIS_STORAGE_ACCESS_KEY_ID"), secretAccessKey: need("TIGRIS_STORAGE_SECRET_ACCESS_KEY") },
});

const origins = [
  ...new Set(
    [process.env.APP_URL, process.env.NEXT_PUBLIC_APP_URL, "http://localhost:3000", "http://localhost:3001", ...process.argv.slice(2)]
      .filter(Boolean)
      .map((u) => new URL(u).origin),
  ),
];

await s3.send(
  new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: origins,
          // POST/DELETE: multipart uploads of big project files (create, complete, abort).
          AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
          AllowedHeaders: ["content-type", "content-length"],
          ExposeHeaders: ["etag", "content-length", "content-type"],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  }),
);
const { CORSRules } = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }));
console.log(`CORS on ${bucket}:`, JSON.stringify(CORSRules?.[0]?.AllowedOrigins ?? []));
