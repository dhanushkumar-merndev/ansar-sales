import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createUser, one, recordObject, rows, type Db } from "./harness";

let db: Db;
let admin: string, manager: string, designer: string, outsider: string, account: string;
let project: string, gfc: string, proofs: string;

const upload = async (by: string, folder: string, size = 1000, fileId: string | null = null, ext = "dwg") => {
  const path = await recordObject(db, `${project}/${randomUUID()}.${ext}`, size, "application/acad", { bucket: "projects" as never });
  return asUser(db, by, async (tx) => (await one<{ r: { file_id: string; version_id: string; version_no: number } }>(tx,
    "select public.register_project_file($1, $2, 'Master plan.dwg', $3) as r", [folder, path, fileId])).r);
};
const status = (by: string, version: string, s: string) => asUser(db, by, (tx) => tx.query("select public.set_file_version_status($1, $2, null)", [version, s]));

beforeAll(async () => {
  db = await createDb();
  const gardens = await createCompany(db, "Star Gardens");
  await db.query("update public.companies set features = array['projects'] where id = $1", [gardens]);
  admin = await createUser(db, "pf_admin", "admin", "Admin", gardens);
  manager = await createUser(db, "pf_am", "architect_manager" as never, "Raj", gardens);
  designer = await createUser(db, "pf_ld", "landscape_designer" as never, "Diny", gardens);
  outsider = await createUser(db, "pf_ld2", "landscape_designer" as never, "Abhi", gardens);
  account = await createUser(db, "pf_acc", "account", "Prema", gardens);
  project = await asUser(db, admin, async (tx) => (await one<{ id: string }>(tx,
    `select public.create_project(p_name => 'Hari', p_client_name => 'Hari', p_start => '2026-10-01', p_end => '2026-11-01', p_members => $1::jsonb) as id`,
    [JSON.stringify([{ user_id: manager, role: "architect_manager" }, { user_id: designer, role: "landscape_designer" }])])).id);
  gfc = (await one<{ id: string }>(db, "select id from public.project_folders where project_id = $1 and system_key = 'gfc'", [project])).id;
  proofs = (await one<{ id: string }>(db, "select id from public.project_folders where project_id = $1 and system_key = 'payment_proofs'", [project])).id;
});

describe("project files", () => {
  it("creates the default folders and hides payment proofs from the design team", async () => {
    const names = (uid: string) => asUser(db, uid, (tx) => rows<{ name: string }>(tx, "select name from public.project_folders where project_id = $1 order by position", [project])).then((r) => r.map((x) => x.name));
    expect(await names(designer)).toEqual(["Site images", "Layout & deck", "BOQ", "GFC drawings (DWG)", "3D / SketchUp", "Execution photos", "Handover"]);
    expect(await names(account)).toEqual(["Payment proofs"]);
    expect(await names(outsider)).toEqual([]);
    await expect(upload(designer, proofs)).rejects.toThrow(/folder_not_found/);
    await expect(upload(account, proofs, 500, null, "png")).resolves.toMatchObject({ version_no: 1 });
  });

  it("uploads versions, refuses unconfirmed objects, and runs the approval flow", async () => {
    const v1 = await upload(designer, gfc);
    expect(v1.version_no).toBe(1);
    const path = `${project}/${randomUUID()}.dwg`;
    await expect(asUser(db, designer, (tx) => tx.query("select public.register_project_file($1, $2, 'x.dwg')", [gfc, path]))).rejects.toThrow(/file_not_uploaded/);
    await status(designer, v1.version_id, "submitted");
    await expect(status(designer, v1.version_id, "approved")).rejects.toThrow(/forbidden/);
    await status(manager, v1.version_id, "approved");
    const v2 = await upload(designer, gfc, 2000, v1.file_id);
    expect(v2.version_no).toBe(2);
    await status(manager, v2.version_id, "approved");
    const vs = await rows<{ version_no: number; status: string }>(db, "select version_no, status from public.project_file_versions where file_id = $1 order by version_no", [v1.file_id]);
    expect(vs).toEqual([{ version_no: 1, status: "superseded" }, { version_no: 2, status: "approved" }]);
    const detail = await asUser(db, designer, async (tx) => (await one<{ d: { events: { type: string }[] } }>(tx, "select public.project_file_detail($1) as d", [v1.file_id])).d);
    expect(detail.events.map((e) => e.type)).toEqual(expect.arrayContaining(["uploaded", "submitted", "approved", "superseded"]));
  });

  it("enforces the per-project quota", async () => {
    await db.query("update public.projects set storage_quota_bytes = 10000 where id = $1", [project]);
    await expect(upload(designer, gfc, 9000)).rejects.toThrow(/storage_full/);
    const usage = await asUser(db, designer, async (tx) => (await one<{ u: { used: number; quota: number } }>(tx, "select public.project_storage_usage($1) as u", [project])).u);
    expect(Number(usage.used)).toBe(3500);
    await db.query("update public.projects set storage_quota_bytes = 107374182400 where id = $1", [project]);
  });

  it("lists a folder and keeps outsiders out", async () => {
    const list = await asUser(db, designer, async (tx) => (await one<{ l: { total: number; items: { current: { version_no: number }; client_version: { version_no: number } }[] } }>(tx,
      "select public.list_project_folder($1, $2) as l", [project, gfc])).l);
    expect(list.total).toBe(1);
    expect(list.items[0].current.version_no).toBe(2);
    expect(list.items[0].client_version.version_no).toBe(2);
    expect((await asUser(db, outsider, async (tx) => (await one<{ l: { total: number } }>(tx, "select public.list_project_folder($1, $2) as l", [project, gfc])).l)).total).toBe(0);
  });
});

describe("folders inside folders", () => {
  // The statements the Files tab's server actions run (createProjectFolder, renameProjectFolder, archiveProjectFolder).
  it("lets the team nest folders and upload into them, but never inside payment proofs", async () => {
    const mk = (by: string, parent: string | null, name: string) => asUser(db, by, async (tx) => (await one<{ id: string }>(tx,
      "insert into public.project_folders (project_id, parent_id, name, position) values ($1, $2, $3, 100) returning id", [project, parent, name])).id);
    const drone = await mk(designer, gfc, "Drone survey");
    const day1 = await mk(designer, drone, "Day 1");
    await expect(mk(designer, drone, "day 1 ")).rejects.toThrow(/project_folders_name_key/); // same name in the same place
    await mk(designer, gfc, "Day 1"); // the same name elsewhere is fine

    const up = await upload(designer, day1);
    const list = await asUser(db, designer, async (tx) => (await one<{ l: { total: number; items: { id: string; folder_id: string }[] } }>(tx,
      "select public.list_project_folder($1, $2) as l", [project, day1])).l);
    expect(list.items.map((f) => [f.id, f.folder_id])).toEqual([[up.file_id, day1]]);

    // Payment proofs stays flat and money-only; the standard folders keep their names.
    await expect(mk(account, proofs, "October")).rejects.toThrow(/row-level security/);
    await expect(mk(designer, proofs, "October")).rejects.toThrow(/row-level security/);
    expect((await asUser(db, manager, (tx) => tx.query("update public.project_folders set name = 'X' where id = $1", [gfc]))).affectedRows).toBe(0);
    // A manager renames and removes folders someone made; a designer can't.
    expect((await asUser(db, designer, (tx) => tx.query("update public.project_folders set name = 'X' where id = $1", [drone]))).affectedRows).toBe(0);
    expect((await asUser(db, manager, (tx) => tx.query("update public.project_folders set name = 'Drone survey 2026' where id = $1", [drone]))).affectedRows).toBe(1);
    // An outsider sees none of it.
    expect(await asUser(db, outsider, (tx) => rows(tx, "select id from public.project_folders where id = $1", [day1]))).toEqual([]);
  });
});

describe("archiving folders", () => {
  const mk = (by: string, parent: string | null, name: string) => asUser(db, by, async (tx) => (await one<{ id: string }>(tx,
    "insert into public.project_folders (project_id, parent_id, name, position) values ($1, $2, $3, 100) returning id", [project, parent, name])).id);
  const call = <T>(by: string, sql: string, args: unknown[]) => asUser(db, by, async (tx) => (await one<{ r: T }>(tx, sql, args)).r);
  const live = (by: string) => asUser(db, by, (tx) => rows<{ name: string }>(tx, "select name from public.project_folders where project_id = $1 and archived_at is null", [project]))
    .then((r) => r.map((x) => x.name));

  it("lets whoever made a folder archive it; managers see it, restore it or delete it for good", async () => {
    await db.query("update public.projects set storage_quota_bytes = 10000000 where id = $1", [project]);
    const visit = await mk(designer, gfc, "Site visit 3");
    const photos = await mk(manager, visit, "Photos");
    const file = await upload(designer, photos);

    // Only the maker (or a manager) archives; the standard folders never.
    const other = await mk(manager, gfc, "Manager's");
    await expect(call(designer, "select public.archive_project_folder($1) as r", [other])).rejects.toThrow(/forbidden/);
    await expect(call(manager, "select public.archive_project_folder($1) as r", [gfc])).rejects.toThrow(/standard_folder/);
    await expect(call(designer, "select public.archived_project_folders($1) as r", [project])).rejects.toThrow(/forbidden/);

    expect(await call(designer, "select public.archive_project_folder($1) as r", [visit])).toEqual({ folders: 2, files: 1 });
    expect(await live(designer)).not.toEqual(expect.arrayContaining(["Site visit 3"]));
    expect(await live(designer)).not.toEqual(expect.arrayContaining(["Photos"]));
    await expect(upload(designer, photos)).rejects.toThrow(/folder_not_found/);

    const archived = await call<{ id: string; name: string; folders: number; files: number; bytes: number; archived_by: string }[]>(manager,
      "select public.archived_project_folders($1) as r", [project]);
    expect(archived).toEqual([expect.objectContaining({ id: visit, name: "Site visit 3", folders: 1, files: 1, bytes: 1000, archived_by: "Diny", parent_name: "GFC drawings (DWG)" })]);

    // Restore brings back the folder and what was archived with it.
    await expect(call(designer, "select public.restore_project_folder($1) as r", [visit])).rejects.toThrow(/forbidden/);
    await call(manager, "select public.restore_project_folder($1) as r", [visit]);
    expect(await live(designer)).toEqual(expect.arrayContaining(["Site visit 3", "Photos"]));

    // Delete for good: only once archived, only managers; the files and versions go too.
    await expect(call(manager, "select public.purge_project_folder($1) as r", [visit])).rejects.toThrow(/folder_not_archived/);
    await call(designer, "select public.archive_project_folder($1) as r", [visit]);
    await expect(call(designer, "select public.purge_project_folder_paths($1) as r", [visit])).rejects.toThrow(/forbidden/);
    const paths = await call<string[]>(manager, "select public.purge_project_folder_paths($1) as r", [visit]);
    expect(paths).toHaveLength(1);
    expect(await call(admin, "select public.purge_project_folder($1) as r", [visit])).toEqual({ folders: 2, files: 1 });
    expect(await rows(db, "select id from public.project_files where id = $1", [file.file_id])).toEqual([]);
    expect(await rows(db, "select id from public.project_folders where id in ($1, $2)", [visit, photos])).toEqual([]);
    expect(await call(manager, "select public.archived_project_folders($1) as r", [project])).toEqual([]);
  });

  it("won't restore over a folder of the same name, or inside an archived folder", async () => {
    const a = await mk(designer, gfc, "Revisions");
    const b = await mk(designer, a, "R1");
    await call(designer, "select public.archive_project_folder($1) as r", [b]);
    await call(designer, "select public.archive_project_folder($1) as r", [a]);
    await expect(call(manager, "select public.restore_project_folder($1) as r", [b])).rejects.toThrow(/parent_archived/);
    await mk(designer, gfc, "revisions");
    await expect(call(manager, "select public.restore_project_folder($1) as r", [a])).rejects.toThrow(/project_folders_name_key/);
    // Both show in the list: R1 was archived on its own, before its parent.
    const names = (await call<{ name: string; parent_archived: boolean }[]>(manager, "select public.archived_project_folders($1) as r", [project])).map((x) => [x.name, x.parent_archived]);
    expect(names).toEqual(expect.arrayContaining([["Revisions", false], ["R1", true]]));
  });
});

describe("moving files", () => {
  // What moveProjectFile runs (drag a file row onto a folder).
  const move = (by: string, file: string, to: string) => asUser(db, by, (tx) => tx.query("update public.project_files set folder_id = $2 where id = $1", [file, to]));
  it("lets the uploader or a manager move a file between design folders, never into payment proofs", async () => {
    const boq = (await one<{ id: string }>(db, "select id from public.project_folders where project_id = $1 and system_key = 'boq'", [project])).id;
    const f = await upload(designer, gfc);
    expect((await move(designer, f.file_id, boq)).affectedRows).toBe(1);
    expect((await move(manager, f.file_id, gfc)).affectedRows).toBe(1);
    const theirs = await upload(manager, gfc);
    expect((await move(designer, theirs.file_id, boq)).affectedRows).toBe(0);
    await expect(move(designer, f.file_id, proofs)).rejects.toThrow(/invalid_move|row-level security/);
    await expect(move(admin, f.file_id, proofs)).rejects.toThrow(/invalid_move/);
  });
});

describe("pins on drawings", () => {
  // What addFileComment runs with a drawing point (DWG/DXF viewer).
  it("keeps a drawing pin in drawing coordinates, never mixed with a picture pin", async () => {
    const v = await upload(designer, gfc);
    const pin = (x: number | null, y: number | null, extra = "") => asUser(db, designer, (tx) => tx.query(
      `insert into public.project_file_comments (version_id, project_id, body, cad_x, cad_y, author_id${extra ? ", x_pct, y_pct" : ""})
       values ($1, $2, 'Move this tree', $3, $4, $5${extra})`, [v.version_id, project, x, y, designer]));
    await pin(37775.41, -26837.8);
    expect(await rows(db, "select cad_x, cad_y from public.project_file_comments where version_id = $1", [v.version_id])).toEqual([{ cad_x: 37775.41, cad_y: -26837.8 }]);
    await expect(pin(1, null)).rejects.toThrow(/project_file_comments_cad_point/);
    await expect(pin(1, 2, ", 10, 10")).rejects.toThrow(/project_file_comments_cad_point/);
    await expect(asUser(db, outsider, (tx) => tx.query("insert into public.project_file_comments (version_id, project_id, body, cad_x, cad_y, author_id) values ($1, $2, 'x', 1, 1, $3)",
      [v.version_id, project, outsider]))).rejects.toThrow(/row-level security/);
  });
});

describe("pin colours", () => {
  it("lets the note's writer or a manager change a pin's colour, nobody else", async () => {
    const v = await upload(designer, gfc);
    const id = (await asUser(db, designer, (tx) => one<{ id: string }>(tx,
      "insert into public.project_file_comments (version_id, project_id, body, x_pct, y_pct, pin_color, author_id) values ($1, $2, 'Check level', 10, 20, 'sky', $3) returning id",
      [v.version_id, project, designer]))).id;
    const recolor = (by: string, c: string) => asUser(db, by, (tx) => tx.query("update public.project_file_comments set pin_color = $2 where id = $1", [id, c]));
    await recolor(designer, "amber");
    await recolor(manager, "violet");
    await db.query("insert into public.project_members (project_id, user_id, member_role) values ($1, $2, 'landscape_designer')", [project, outsider]);
    await expect(recolor(outsider, "red")).rejects.toThrow(/forbidden/);
    await expect(recolor(designer, "black")).rejects.toThrow(/pin_color_check/);
    expect((await one<{ pin_color: string }>(db, "select pin_color from public.project_file_comments where id = $1", [id])).pin_color).toBe("violet");
  });
});
