import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createLead, createUser, one, rows, type Db } from "./harness";

let db: Db;
let admin: string, sales: string, account: string;
let brochures: string, photos: string;

type Usage = {
  database_bytes: number; storage_bytes: number; storage_objects: number;
  library: { active_files: number; active_bytes: number; archived_files: number; archived_bytes: number; unregistered_files: number; unregistered_bytes: number };
  by_folder: { name: string; bytes: number; files: number }[];
  by_type: { pdf_bytes: number; image_bytes: number };
  shares: { active_links: number; total_opens: number };
};

async function folder(name: string) {
  return asUser(db, admin, async (tx) => (await one<{ id: string }>(tx, "insert into public.library_folders (name) values ($1) returning id", [name])).id);
}

/** Uploads an object (optionally backdated) and, unless `register` is false, registers it. */
async function addFile(folderId: string, size: number, opts: { mime?: string; register?: boolean; ageHours?: number } = {}) {
  const mime = opts.mime ?? "application/pdf";
  const path = `${folderId}/${randomUUID()}.${mime === "application/pdf" ? "pdf" : "png"}`;
  await asUser(db, sales, (tx) =>
    tx.query("insert into storage.objects (bucket_id, name, owner, metadata) values ('library', $1, $2, $3)", [path, sales, { size, mimetype: mime }]),
  );
  if (opts.ageHours) {
    await asService(db, (tx) => tx.query(`update storage.objects set created_at = now() - make_interval(hours => $2) where name = $1`, [path, opts.ageHours]));
  }
  if (opts.register === false) return { path, id: null as string | null };
  const id = await asUser(db, sales, async (tx) =>
    (await one<{ id: string }>(tx, "insert into public.library_files (folder_id, name, storage_path) values ($1, 'File', $2) returning id", [folderId, path])).id,
  );
  return { path, id };
}

const archive = (id: string) => asUser(db, admin, (tx) => tx.query("update public.library_files set archived_at = now() where id = $1", [id]));
const usage = () => asUser(db, admin, async (tx) => (await one<{ r: Usage }>(tx, "select public.admin_usage() as r")).r);
const deleteObject = (userId: string, path: string) =>
  asUser(db, userId, async (tx) => (await tx.query("delete from storage.objects where bucket_id = 'library' and name = $1", [path])).affectedRows);

let activePdf: { path: string; id: string | null };
let archivedPdf: { path: string; id: string | null };
let oldOrphan: { path: string };
let newOrphan: { path: string };

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin");
  sales = await createUser(db, "sales", "sales");
  account = await createUser(db, "account", "account");
  brochures = await folder("Brochures");
  photos = await folder("Photos");
  activePdf = await addFile(brochures, 3000);
  await addFile(photos, 500, { mime: "image/png" });
  archivedPdf = await addFile(brochures, 7000);
  await archive(archivedPdf.id!);
  oldOrphan = await addFile(brochures, 400, { register: false, ageHours: 2 });
  newOrphan = await addFile(brochures, 100, { register: false });
});

describe("admin usage", () => {
  it("is admin only", async () => {
    await expect(asUser(db, sales, (tx) => tx.query("select public.admin_usage()"))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, account, (tx) => tx.query("select public.admin_usage()"))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, sales, (tx) => tx.query("select public.admin_unregistered_uploads()"))).rejects.toThrow(/forbidden/);
  });

  it("reports storage, library breakdown, folders, types and shares", async () => {
    const lead = await createLead(db, sales);
    await asUser(db, sales, (tx) => tx.query("select public.share_lead_files($1, $2::uuid[], '7d')", [lead, [activePdf.id]]));
    const u = await usage();
    expect(Number(u.database_bytes)).toBeGreaterThan(0);
    expect(Number(u.storage_bytes)).toBe(3000 + 500 + 7000 + 400 + 100);
    expect(Number(u.storage_objects)).toBe(5);
    expect(u.library).toEqual({ active_files: 2, active_bytes: 3500, archived_files: 1, archived_bytes: 7000, unregistered_files: 2, unregistered_bytes: 500 });
    expect(u.by_folder).toEqual([{ name: "Brochures", bytes: 3000, files: 1 }, { name: "Photos", bytes: 500, files: 1 }]);
    expect(u.by_type).toEqual({ pdf_bytes: 10000, image_bytes: 500 });
    expect(u.shares).toEqual({ active_links: 1, total_opens: 0 });
  });

  it("lists only unregistered uploads older than an hour", async () => {
    const list = await asUser(db, admin, async (tx) => (await one<{ r: { path: string; bytes: number }[] }>(tx, "select public.admin_unregistered_uploads() as r")).r);
    expect(list).toEqual([{ path: oldOrphan.path, bytes: 400 }]);
  });
});

describe("freeing space", () => {
  it("lets admin delete only archived files' objects and old unregistered uploads", async () => {
    expect(await deleteObject(sales, archivedPdf.path)).toBe(0);
    expect(await deleteObject(admin, activePdf.path)).toBe(0);
    expect(await deleteObject(admin, newOrphan.path)).toBe(0);
    expect(await deleteObject(admin, oldOrphan.path)).toBe(1);
    expect(await deleteObject(admin, archivedPdf.path)).toBe(1);
  });

  it("purges an archived file's records, keeps shares working, and audits it", async () => {
    const lead = await createLead(db, sales);
    const extra = await addFile(brochures, 50);
    const share = await asUser(db, sales, async (tx) =>
      (await one<{ r: { token: string } }>(tx, "select public.share_lead_files($1, $2::uuid[], 'never') as r", [lead, [activePdf.id, extra.id]])).r,
    );
    await archive(extra.id!);

    await expect(asUser(db, admin, (tx) => tx.query("select public.admin_purge_library_file($1)", [activePdf.id]))).rejects.toThrow(/file_not_archived/);
    await expect(asUser(db, sales, (tx) => tx.query("select public.admin_purge_library_file($1)", [extra.id]))).rejects.toThrow(/forbidden/);
    await asUser(db, admin, (tx) => tx.query("select public.admin_purge_library_file($1)", [extra.id]));

    expect(await rows(db, "select 1 from public.library_files where id = $1", [extra.id])).toHaveLength(0);
    expect(await rows(db, "select 1 from public.lead_share_files where file_id = $1", [extra.id])).toHaveLength(0);
    const audit = await one<{ meta: { name: string; size_bytes: number } }>(db, "select meta from public.admin_audit_log where action = 'library_file_deleted' and meta ->> 'file_id' = $1", [extra.id]);
    expect(audit.meta.size_bytes).toBe(50);

    const page = await asUser(db, null, async (tx) => (await one<{ r: { files: { id: string }[] } }>(tx, "select public.open_lead_share($1, false) as r", [share.token])).r);
    expect(page.files.map((f) => f.id)).toEqual([activePdf.id]);
    await expect(asUser(db, admin, (tx) => tx.query("select public.admin_purge_library_file($1)", [extra.id]))).rejects.toThrow(/not_found/);
  });
});

describe("thumbnails and usage", () => {
  it("counts a thumbnail as part of its file and lets admin delete it with the archived file", async () => {
    const f = await addFile(photos, 1000);
    const thumb = `${photos}/thumbs/${randomUUID()}.webp`;
    await asUser(db, sales, (tx) => tx.query("insert into storage.objects (bucket_id, name, metadata) values ('library', $1, $2)", [thumb, { size: 10, mimetype: "image/webp" }]));
    await asService(db, (tx) => tx.query("update storage.objects set created_at = now() - interval '2 hours' where name = $1", [thumb]));
    await asUser(db, sales, (tx) => tx.query("select public.set_library_thumbnail($1, $2)", [f.id, thumb]));

    const before = await usage();
    const list = await asUser(db, admin, async (tx) => (await one<{ r: { path: string }[] }>(tx, "select public.admin_unregistered_uploads() as r")).r);
    expect(list.map((x) => x.path)).not.toContain(thumb);
    expect(await deleteObject(admin, thumb)).toBe(0);

    await archive(f.id!);
    expect(await deleteObject(admin, thumb)).toBe(1);
    expect(before.library.unregistered_files).toBe((await usage()).library.unregistered_files);
  });
});
