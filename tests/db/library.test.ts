import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createLead, createUser, one, rows, type Db } from "./harness";

let db: Db;
let admin: string, salesA: string, salesB: string, account: string;
let folder: string;
let pdf: string, png: string;
let leadA: string, leadB: string;

/** Simulates a Storage upload (the object row Supabase Storage writes after the upload). */
async function upload(userId: string, folderId: string, ext: string, mimetype: string, size = 1234) {
  const path = `${folderId}/${randomUUID()}.${ext}`;
  await asUser(db, userId, (tx) =>
    tx.query("insert into storage.objects (bucket_id, name, owner, metadata) values ('library', $1, $2, $3)", [path, userId, { size, mimetype }]),
  );
  return path;
}

async function register(userId: string, folderId: string, path: string, name = "Brochure.pdf") {
  return asUser(db, userId, async (tx) =>
    (await one<{ id: string }>(tx, "insert into public.library_files (folder_id, name, storage_path) values ($1, $2, $3) returning id", [folderId, name, path])).id,
  );
}

async function share(userId: string, leadId: string, fileIds: string[], expiry = "7d") {
  return asUser(db, userId, async (tx) =>
    (await one<{ r: { token: string; share_id: string } }>(tx, "select public.share_lead_files($1, $2::uuid[], $3) as r", [leadId, fileIds, expiry])).r,
  );
}

const openShare = (token: string, count = true) =>
  asUser(db, null, async (tx) => (await one<{ r: { shared_by: string; files: { id: string; name: string }[] } | null }>(tx, "select public.open_lead_share($1, $2) as r", [token, count])).r);

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales_a", "sales", "Sales A");
  salesB = await createUser(db, "sales_b", "sales", "Sales B");
  account = await createUser(db, "account", "account");
  folder = await asUser(db, salesA, async (tx) => (await one<{ id: string }>(tx, "insert into public.library_folders (name) values ('  Brochures  ') returning id")).id);
  pdf = await register(salesA, folder, await upload(salesA, folder, "pdf", "application/pdf", 2048));
  png = await register(salesA, folder, await upload(salesA, folder, "png", "image/png"), "Price list.png");
  leadA = await createLead(db, salesA, { name: "Customer A" });
  leadB = await createLead(db, salesB, { name: "Customer B" });
});

describe("library", () => {
  it("lets sales create folders and register uploaded files with storage metadata", async () => {
    const f = await asUser(db, salesB, async (tx) => one<{ name: string; created_by: string }>(tx, "select name, created_by from public.library_folders where id = $1", [folder]));
    expect(f).toEqual({ name: "Brochures", created_by: salesA });
    const file = await asUser(db, salesA, (tx) => one<{ size_bytes: string; mime_type: string }>(tx, "select size_bytes, mime_type from public.library_files where id = $1", [pdf]));
    expect(Number(file.size_bytes)).toBe(2048);
    expect(file.mime_type).toBe("application/pdf");
  });

  it("rejects duplicate active folder names", async () => {
    await expect(asUser(db, salesB, (tx) => tx.query("insert into public.library_folders (name) values ('brochures')"))).rejects.toThrow(/library_folders_active_name_key/);
  });

  it("rejects file rows without a matching upload, outside the folder, or of a disallowed type", async () => {
    await expect(register(salesA, folder, `${folder}/${randomUUID()}.pdf`)).rejects.toThrow(/file_not_uploaded/);
    const other = await asUser(db, admin, async (tx) => (await one<{ id: string }>(tx, "insert into public.library_folders (name) values ('Other') returning id")).id);
    const elsewhere = await upload(salesA, other, "pdf", "application/pdf");
    await expect(register(salesA, folder, elsewhere)).rejects.toThrow(/invalid_file/);
    const svg = await upload(salesA, folder, "png", "image/svg+xml");
    await expect(register(salesA, folder, svg)).rejects.toThrow(/invalid_file_type/);
  });

  it("only allows uploads into an active folder, by lead users", async () => {
    await expect(upload(salesA, randomUUID(), "pdf", "application/pdf")).rejects.toThrow(/row-level security/);
    await expect(upload(account, folder, "pdf", "application/pdf")).rejects.toThrow(/row-level security/);
  });

  it("hides the library from account users and lets only admin rename or archive", async () => {
    expect(await asUser(db, account, (tx) => rows(tx, "select id from public.library_folders"))).toHaveLength(0);
    expect(await asUser(db, account, (tx) => rows(tx, "select id from public.library_files"))).toHaveLength(0);
    expect(await asUser(db, account, (tx) => rows(tx, "select id from storage.objects"))).toHaveLength(0);
    const r = await asUser(db, salesA, (tx) => tx.query("update public.library_files set archived_at = now() where id = $1", [pdf]));
    expect(r.affectedRows).toBe(0);
    await asUser(db, admin, (tx) => tx.query("update public.library_folders set name = 'Sales brochures' where id = $1", [folder]));
    expect((await one<{ name: string }>(db, "select name from public.library_folders where id = $1", [folder])).name).toBe("Sales brochures");
  });
});

describe("lead shares", () => {
  it("creates a share for an owned lead and opens it publicly without customer details", async () => {
    const s = await share(salesA, leadA, [png, pdf]);
    expect(s.token).toMatch(/^[a-f0-9]{64}$/);
    const page = await openShare(s.token);
    expect(page!.shared_by).toBe("Sales A");
    expect(page!.files.map((f) => f.id)).toEqual([png, pdf]);
    expect(JSON.stringify(page)).not.toContain("Customer A");
    const stored = await one<{ view_count: number; token_hash: string }>(db, "select view_count, token_hash from public.lead_shares where id = $1", [s.share_id]);
    expect(stored.view_count).toBe(1);
    expect(stored.token_hash).not.toBe(s.token);
    await openShare(s.token, false);
    expect((await one<{ view_count: number }>(db, "select view_count from public.lead_shares where id = $1", [s.share_id])).view_count).toBe(1);

    const activity = await asUser(db, salesA, (tx) => one<{ meta: { files: string[] } }>(tx, "select meta from public.lead_activities where lead_id = $1 and type = 'files_shared'", [leadA]));
    expect(activity.meta.files).toEqual(["Brochure.pdf", "Price list.png"]);

    const file = await asUser(db, null, (tx) => one<{ r: { storage_path: string } | null }>(tx, "select public.resolve_share_file($1, $2) as r", [s.token, pdf]));
    expect(file.r!.storage_path).toMatch(new RegExp(`^${folder}/`));
    const notShared = await asUser(db, null, (tx) => one<{ r: unknown }>(tx, "select public.resolve_share_file($1, $2) as r", [s.token, randomUUID()]));
    expect(notShared.r).toBeNull();
  });

  it("keeps sales scoped to their own leads", async () => {
    await expect(share(salesB, leadA, [pdf])).rejects.toThrow(/not_found/);
    await expect(share(account, leadA, [pdf])).rejects.toThrow(/not_found/);
    await share(salesA, leadA, [pdf]);
    expect(await asUser(db, salesB, (tx) => rows(tx, "select id from public.lead_shares where lead_id = $1", [leadA]))).toHaveLength(0);
    expect(await asUser(db, salesB, (tx) => rows(tx, "select id from public.lead_shares where lead_id = $1", [leadB]))).toHaveLength(0);
  });

  it("validates files and expiry", async () => {
    await expect(share(salesA, leadA, [])).rejects.toThrow(/invalid_share_files/);
    await expect(share(salesA, leadA, [pdf, pdf])).rejects.toThrow(/invalid_share_files/);
    await expect(share(salesA, leadA, [randomUUID()])).rejects.toThrow(/share_file_unavailable/);
    await expect(share(salesA, leadA, [pdf], "1y")).rejects.toThrow(/invalid_expiry/);
  });

  it("stops working when revoked or expired, and never for 'never'", async () => {
    const revoked = await share(salesA, leadA, [pdf]);
    await asUser(db, salesA, (tx) => tx.query("select public.revoke_lead_share($1)", [revoked.share_id]));
    expect(await openShare(revoked.token)).toBeNull();

    const expired = await share(salesA, leadA, [pdf], "24h");
    await asService(db, (tx) => tx.query("update public.lead_shares set expires_at = now() - interval '1 minute' where id = $1", [expired.share_id]));
    expect(await openShare(expired.token)).toBeNull();

    const forever = await share(salesA, leadA, [pdf], "never");
    expect((await one<{ expires_at: string | null }>(db, "select expires_at from public.lead_shares where id = $1", [forever.share_id])).expires_at).toBeNull();
    expect(await openShare(forever.token)).not.toBeNull();
    expect(await openShare("0".repeat(64))).toBeNull();
    expect(await openShare("not-a-token")).toBeNull();
  });

  it("drops archived files from an open share", async () => {
    const extra = await register(salesA, folder, await upload(salesA, folder, "webp", "image/webp"), "Photo.webp");
    const s = await share(salesA, leadA, [pdf, extra]);
    await asUser(db, admin, (tx) => tx.query("update public.library_files set archived_at = now() where id = $1", [extra]));
    expect((await openShare(s.token))!.files.map((f) => f.id)).toEqual([pdf]);
    await expect(share(salesA, leadA, [extra])).rejects.toThrow(/share_file_unavailable/);
  });

  it("gives anon no direct table access", async () => {
    for (const table of ["lead_shares", "library_files", "library_folders", "lead_share_files"]) {
      await expect(asUser(db, null, (tx) => tx.query(`select * from public.${table}`))).rejects.toThrow(/permission denied/);
    }
    await expect(asUser(db, salesA, (tx) => tx.query("select token_hash from public.lead_shares"))).rejects.toThrow(/permission denied/);
  });
});

describe("calls", () => {
  it("logs a call and lets only the caller set its outcome within a day", async () => {
    const id = await asUser(db, salesA, async (tx) => (await one<{ id: string }>(tx, "select public.log_call($1) as id", [leadA])).id);
    await expect(asUser(db, salesB, (tx) => tx.query("select public.log_call($1)", [leadA]))).rejects.toThrow(/not_found/);
    await expect(asUser(db, admin, (tx) => tx.query("select public.set_call_outcome($1, 'busy')", [id]))).rejects.toThrow(/not_found/);
    await expect(asUser(db, salesA, (tx) => tx.query("select public.set_call_outcome($1, 'maybe')", [id]))).rejects.toThrow(/invalid_outcome/);
    await asUser(db, salesA, (tx) => tx.query("select public.set_call_outcome($1, 'no_answer', '  Try evening  ')", [id]));
    const a = await one<{ meta: { outcome: string; phone: string }; body: string; edited_at: string | null }>(db, "select meta, body, edited_at from public.lead_activities where id = $1", [id]);
    expect(a.meta.outcome).toBe("no_answer");
    expect(a.meta.phone).toBeTruthy();
    expect(a.body).toBe("Try evening");
    expect(a.edited_at).toBeNull();

    await asService(db, (tx) => tx.query("update public.lead_activities set created_at = now() - interval '25 hours' where id = $1", [id]));
    await expect(asUser(db, salesA, (tx) => tx.query("select public.set_call_outcome($1, 'connected')", [id]))).rejects.toThrow(/call_outcome_closed/);
  });
});

describe("subfolders", () => {
  it("creates nested folders with names unique per parent and a breadcrumb path", async () => {
    const parent = await asUser(db, salesA, async (tx) => (await one<{ id: string }>(tx, "insert into public.library_folders (name) values ('Projects') returning id")).id);
    const child = await asUser(db, salesA, async (tx) => (await one<{ id: string }>(tx, "insert into public.library_folders (name, parent_id) values ('2026', $1) returning id", [parent])).id);
    // Same name is fine under another parent, not twice under the same one.
    await asUser(db, salesA, (tx) => tx.query("insert into public.library_folders (name) values ('2026')"));
    await expect(asUser(db, salesB, (tx) => tx.query("insert into public.library_folders (name, parent_id) values ('2026', $1)", [parent]))).rejects.toThrow(/library_folders_active_name_key/);

    const path = await asUser(db, salesB, async (tx) => (await one<{ r: { name: string }[] }>(tx, "select public.library_folder_path($1) as r", [child])).r);
    expect(path.map((p) => p.name)).toEqual(["Projects", "2026"]);
    const options = await asUser(db, salesB, async (tx) => (await one<{ r: { id: string; path: string }[] }>(tx, "select public.library_folder_options() as r")).r);
    expect(options.find((o) => o.id === child)!.path).toBe("Projects / 2026");

    // Archive order: children first; restore order: parent first.
    await expect(asUser(db, admin, (tx) => tx.query("update public.library_folders set archived_at = now() where id = $1", [parent]))).rejects.toThrow(/folder_has_subfolders/);
    await asUser(db, admin, (tx) => tx.query("update public.library_folders set archived_at = now() where id = $1", [child]));
    await asUser(db, admin, (tx) => tx.query("update public.library_folders set archived_at = now() where id = $1", [parent]));
    await expect(asUser(db, admin, (tx) => tx.query("update public.library_folders set archived_at = null where id = $1", [child]))).rejects.toThrow(/parent_folder_archived/);
    await expect(asUser(db, salesA, (tx) => tx.query("insert into public.library_folders (name, parent_id) values ('New', $1)", [parent]))).rejects.toThrow(/folder_not_found/);
  });

  it("limits nesting depth", async () => {
    let parent: string | null = null;
    for (let i = 0; i < 5; i++) {
      parent = await asUser(db, salesA, async (tx) => (await one<{ id: string }>(tx, "insert into public.library_folders (name, parent_id) values ($1, $2) returning id", [`Deep ${i}`, parent])).id);
    }
    await expect(asUser(db, salesA, (tx) => tx.query("insert into public.library_folders (name, parent_id) values ('Too deep', $1)", [parent]))).rejects.toThrow(/folder_too_deep/);
  });
});

describe("thumbnails", () => {
  const setThumb = (userId: string, fileId: string, path: string) =>
    asUser(db, userId, (tx) => tx.query("select public.set_library_thumbnail($1, $2)", [fileId, path]));

  it("links a webp thumbnail in the file's folder once, and exposes it to share pages", async () => {
    const file = await register(salesA, folder, await upload(salesA, folder, "pdf", "application/pdf"), "Catalog.pdf");
    const thumbPath = `${folder}/thumbs/${randomUUID()}.webp`;
    await expect(setThumb(salesA, file, thumbPath)).rejects.toThrow(/file_not_uploaded/);
    await asUser(db, salesA, (tx) => tx.query("insert into storage.objects (bucket_id, name, metadata) values ('library', $1, $2)", [thumbPath, { size: 900, mimetype: "image/webp" }]));
    await expect(setThumb(account, file, thumbPath)).rejects.toThrow(/forbidden/);
    await expect(setThumb(salesA, file, `${randomUUID()}/thumbs/${randomUUID()}.webp`)).rejects.toThrow(/invalid_file/);
    const png = `${folder}/thumbs/${randomUUID()}.webp`;
    await asUser(db, salesA, (tx) => tx.query("insert into storage.objects (bucket_id, name, metadata) values ('library', $1, $2)", [png, { size: 900, mimetype: "image/png" }]));
    await expect(setThumb(salesA, file, png)).rejects.toThrow(/invalid_file_type/);

    await setThumb(salesB, file, thumbPath);
    await expect(setThumb(salesA, file, thumbPath)).rejects.toThrow(/thumbnail_exists/);

    const s = await share(salesA, leadA, [file]);
    const r = await asUser(db, null, (tx) => one<{ r: { thumb_path: string } }>(tx, "select public.resolve_share_file($1, $2) as r", [s.token, file]));
    expect(r.r.thumb_path).toBe(thumbPath);
  });
});
