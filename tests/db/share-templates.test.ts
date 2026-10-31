import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createLead, createUser, one, recordObject, rows, type Db } from "./harness";

// 20261008005400_share_templates_and_video: share templates, and videos in the Library.

let db: Db;
let admin: string, salesA: string, salesB: string, account: string, farmAdmin: string;
let folder: string, farmFolder: string;
let pdf: string, png: string, farmPdf: string;

const MB = 1024 * 1024;

const upload = (folderId: string, ext: string, mime: string, size = 1234) => recordObject(db, `${folderId}/${randomUUID()}.${ext}`, size, mime);
const register = (userId: string, folderId: string, path: string, name = "File") =>
  asUser(db, userId, async (tx) =>
    (await one<{ id: string }>(tx, "insert into public.library_files (folder_id, name, storage_path) values ($1, $2, $3) returning id", [folderId, name, path])).id);
const newFolder = (userId: string, name: string) =>
  asUser(db, userId, async (tx) => (await one<{ id: string }>(tx, "insert into public.library_folders (name) values ($1) returning id", [name])).id);

type Save = { id?: string | null; name?: string; message?: string; expiry?: string; files?: string[] };
const save = (userId: string | null, s: Save = {}) =>
  asUser(db, userId, async (tx) =>
    (await one<{ id: string }>(tx, "select public.save_share_template($1, $2, $3, $4, $5::uuid[]) as id", [
      s.id ?? null, s.name ?? "Brochure pack", s.message ?? "Hi {name}, here are the documents from {company}:", s.expiry ?? "7d", s.files ?? [pdf],
    ])).id);
const archive = (userId: string, id: string, archived = true) =>
  asUser(db, userId, (tx) => tx.query("select public.set_share_template_archived($1, $2)", [id, archived]));
const visible = (userId: string) =>
  asUser(db, userId, (tx) => rows<{ id: string; name: string; archived_at: string | null }>(tx, "select id, name, archived_at from public.share_templates order by name"));
const filesOf = (userId: string, id: string) =>
  asUser(db, userId, async (tx) => (await rows<{ file_id: string }>(tx, "select file_id from public.share_template_files where template_id = $1 order by position", [id])).map((r) => r.file_id));

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales_a", "sales", "Sales A");
  salesB = await createUser(db, "sales_b", "sales", "Sales B");
  account = await createUser(db, "account", "account");
  const farm = await createCompany(db, "Star Managed Farmlands");
  farmAdmin = await createUser(db, "farm_admin", "admin", "Farm Admin", farm);
  folder = await newFolder(salesA, "Brochures");
  farmFolder = await newFolder(farmAdmin, "Farm brochures");
  pdf = await register(salesA, folder, await upload(folder, "pdf", "application/pdf", 2048), "Brochure.pdf");
  png = await register(salesA, folder, await upload(folder, "png", "image/png"), "Price list.png");
  farmPdf = await register(farmAdmin, farmFolder, await upload(farmFolder, "pdf", "application/pdf"), "Farm.pdf");
});

describe("share templates", () => {
  it("lets sales create one that every lead user of the company sees, with its files in order", async () => {
    const id = await save(salesA, { name: "  Coorg   pack ", files: [png, pdf] });
    expect((await visible(salesB)).map((t) => t.name)).toContain("Coorg pack");
    expect((await visible(admin)).map((t) => t.id)).toContain(id);
    expect(await filesOf(salesB, id)).toEqual([png, pdf]);
    // Not account, not another company.
    expect(await visible(account)).toEqual([]);
    expect(await visible(farmAdmin)).toEqual([]);
  });

  it("lets only its creator or an admin edit or archive it", async () => {
    const id = await save(salesA, { name: "Edit me" });
    await expect(save(salesB, { id, name: "Hijacked" })).rejects.toThrow(/forbidden/);
    await expect(archive(salesB, id)).rejects.toThrow(/forbidden/);

    await save(salesA, { id, name: "Edit me", message: "New text", expiry: "30d", files: [pdf, png] });
    const t = await asUser(db, salesA, (tx) => one<{ message: string; expiry: string; updated_by: string }>(tx, "select message, expiry, updated_by from public.share_templates where id = $1", [id]));
    expect(t).toEqual({ message: "New text", expiry: "30d", updated_by: salesA });
    expect(await filesOf(salesA, id)).toEqual([pdf, png]);

    await save(admin, { id, name: "Edited by admin" });
    await archive(admin, id);
    expect((await visible(salesA)).find((x) => x.id === id)?.archived_at).toBeTruthy();
    await archive(salesA, id, false);
    expect((await visible(salesA)).find((x) => x.id === id)?.archived_at).toBeNull();
  });

  it("keeps active names unique per company, case-insensitively, but archived ones may repeat", async () => {
    const first = await save(salesA, { name: "Price pack" });
    await expect(save(salesB, { name: "price PACK" })).rejects.toThrow(/template_name_taken/);
    await archive(salesA, first);
    const second = await save(salesB, { name: "price PACK" });
    expect(second).not.toBe(first);
    // Restoring the first would clash with the new one.
    await expect(archive(salesA, first, false)).rejects.toThrow(/template_name_taken/);
    // The other company can use the same name.
    await save(farmAdmin, { name: "Price pack", files: [farmPdf] });
  });

  it("refuses bad input: no files, too many, duplicates, archived or another company's files", async () => {
    await expect(save(salesA, { name: "Empty", files: [] })).rejects.toThrow(/invalid_share_files/);
    await expect(save(salesA, { name: "Dup", files: [pdf, pdf] })).rejects.toThrow(/invalid_share_files/);
    const many = await Promise.all(Array.from({ length: 11 }, async (_, i) => register(salesA, folder, await upload(folder, "pdf", "application/pdf"), `Many ${i}.pdf`)));
    await expect(save(salesA, { name: "Many", files: many })).rejects.toThrow(/invalid_share_files/);
    await expect(save(salesA, { name: "Other co", files: [farmPdf] })).rejects.toThrow(/share_file_unavailable/);
    const old = await register(salesA, folder, await upload(folder, "pdf", "application/pdf"), "Old.pdf");
    await asUser(db, admin, (tx) => tx.query("update public.library_files set archived_at = now() where id = $1", [old]));
    await expect(save(salesA, { name: "Archived file", files: [old] })).rejects.toThrow(/share_file_unavailable/);
    await expect(save(salesA, { name: "", files: [pdf] })).rejects.toThrow(/template_name_required/);
    await expect(save(salesA, { name: "Bad expiry", expiry: "1y" })).rejects.toThrow(/invalid_expiry/);
    await expect(save(salesA, { name: "Long", message: "x".repeat(1001) })).rejects.toThrow(/message_too_long/);
  });

  it("refuses signed-out users, account users and direct writes", async () => {
    await expect(save(null, { name: "Anon" })).rejects.toThrow();
    await expect(save(account, { name: "Account" })).rejects.toThrow(/forbidden/);
    await expect(asUser(db, admin, (tx) => tx.query("insert into public.share_templates (company_id, name, created_by) select company_id, 'x', $1 from public.library_files limit 1", [admin]))).rejects.toThrow();
    // No write policies: a direct delete removes nothing.
    const before = await rows(db, "select 1 from public.share_template_files");
    await asUser(db, admin, (tx) => tx.query("delete from public.share_template_files"));
    expect((await rows(db, "select 1 from public.share_template_files")).length).toBe(before.length);
  });
});

describe("library videos", () => {
  it("registers MP4, WEBM and MOV videos up to 500 MB, while documents stay at 25 MB", async () => {
    const mp4 = await register(salesA, folder, await upload(folder, "mp4", "video/mp4", 300 * MB), "Walkthrough.mp4");
    const row = await asUser(db, salesA, (tx) => one<{ mime_type: string; size_bytes: string }>(tx, "select mime_type, size_bytes from public.library_files where id = $1", [mp4]));
    expect(row.mime_type).toBe("video/mp4");
    expect(Number(row.size_bytes)).toBe(300 * MB);
    await register(salesA, folder, await upload(folder, "webm", "video/webm", 10 * MB), "Clip.webm");
    await register(salesA, folder, await upload(folder, "mov", "video/quicktime", 10 * MB), "Phone.mov");

    await expect(register(salesA, folder, await upload(folder, "mp4", "video/mp4", 600 * MB))).rejects.toThrow(/file_too_large/);
    await expect(register(salesA, folder, await upload(folder, "pdf", "application/pdf", 30 * MB))).rejects.toThrow(/file_too_large/);
    await expect(register(salesA, folder, await upload(folder, "mp4", "video/x-msvideo", MB))).rejects.toThrow(/invalid_file_type/);
  });

  it("can be shared and opened from the customer's link", async () => {
    const video = await register(salesA, folder, await upload(folder, "mp4", "video/mp4", 120 * MB), "Site video.mp4");
    const lead = await createLead(db, salesA, { name: "Video customer" });
    const { token } = await asUser(db, salesA, async (tx) =>
      (await one<{ r: { token: string } }>(tx, "select public.share_lead_files($1, $2::uuid[], '7d') as r", [lead, [video, pdf]])).r);
    const opened = await asUser(db, null, async (tx) => (await one<{ r: { files: { id: string; mime_type: string }[] } }>(tx, "select public.open_lead_share($1, false) as r", [token])).r);
    expect(opened.files.map((f) => f.mime_type)).toContain("video/mp4");
    const file = await asUser(db, null, async (tx) => (await one<{ r: { mime_type: string } }>(tx, "select public.resolve_share_file($1, $2) as r", [token, video])).r);
    expect(file.mime_type).toBe("video/mp4");
  });
});
