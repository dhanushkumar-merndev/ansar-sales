import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createUser, one, recordObject, rows, type Db } from "./harness";

let db: Db;
let gardens: string;
let admin: string, manager: string, designer: string, client: string, otherClient: string;
let project: string, other: string, gfc: string, proofs: string;

/** A project client login, created the way provisionLogin does it (app_metadata with crm_project_id). */
async function createProjectClient(username: string, projectId: string) {
  return db.transaction(async (tx) => {
    const id = (await one<{ id: string }>(tx, "insert into auth.users (email, raw_app_meta_data) values ($1, '{}') returning id", [`${username}@login.test`])).id;
    await tx.query("update auth.users set raw_app_meta_data = $2 where id = $1", [id, {
      crm_username: username, crm_display_name: "Mr. Hari", crm_role: "client", crm_company_id: gardens, crm_project_id: projectId, crm_created_by: admin,
    }]);
    return id;
  });
}
const upload = async (by: string, folder: string, fileId: string | null = null) => {
  const path = await recordObject(db, `${project}/${randomUUID()}.pdf`, 1000, "application/pdf", { bucket: "projects" as never });
  return asUser(db, by, async (tx) => (await one<{ r: { file_id: string; version_id: string } }>(tx, "select public.register_project_file($1, $2, 'Layout.pdf', $3) as r", [folder, path, fileId])).r);
};
type Portal = { projects: { id: string; files: { id: string; version_id: string; version_no: number }[]; phases: Record<string, unknown>[]; payments: { received: number } }[] };
const portal = (uid: string) => asUser(db, uid, async (tx) => (await one<{ p: Portal }>(tx, "select public.my_project_portal() as p")).p);

beforeAll(async () => {
  db = await createDb();
  gardens = await createCompany(db, "Star Gardens");
  await db.query("update public.companies set features = array['projects'] where id = $1", [gardens]);
  admin = await createUser(db, "pp_admin", "admin", "Admin", gardens);
  manager = await createUser(db, "pp_am", "architect_manager" as never, "Raj", gardens);
  designer = await createUser(db, "pp_ld", "landscape_designer" as never, "Diny", gardens);
  const make = (name: string) => asUser(db, admin, async (tx) => (await one<{ id: string }>(tx,
    `select public.create_project(p_name => $1, p_client_name => $1, p_start => '2026-10-01', p_end => '2026-11-01', p_members => $2::jsonb,
      p_phases => '[{"category":"Design","name":"Layout","color":"sky","planned_start":"2026-10-01","deadline":"2026-10-05"}]'::jsonb) as id`,
    [name, JSON.stringify([{ user_id: manager, role: "architect_manager" }, { user_id: designer, role: "landscape_designer" }])])).id);
  project = await make("Hari");
  other = await make("Someone else");
  client = await createProjectClient("hari_client", project);
  otherClient = await createProjectClient("other_client", other);
  gfc = (await one<{ id: string }>(db, "select id from public.project_folders where project_id = $1 and system_key = 'layout_deck'", [project])).id;
  proofs = (await one<{ id: string }>(db, "select id from public.project_folders where project_id = $1 and system_key = 'payment_proofs'", [project])).id;
});

describe("client portal", () => {
  it("shows the client only their project and never the tables directly", async () => {
    const p = await portal(client);
    expect(p.projects.map((x) => x.id)).toEqual([project]);
    expect(p.projects[0].phases[0]).not.toHaveProperty("owner");
    expect(p.projects[0].phases[0]).not.toHaveProperty("notes");
    await expect(asUser(db, client, (tx) => rows(tx, "select id from public.projects"))).resolves.toEqual([]);
    await expect(asUser(db, client, (tx) => rows(tx, "select id from public.project_file_versions"))).resolves.toEqual([]);
    await expect(asUser(db, admin, (tx) => tx.query("select public.my_project_portal()"))).rejects.toThrow(/forbidden/);
  });

  it("shows only approved versions, and the latest approved one", async () => {
    const v1 = await upload(designer, gfc);
    expect((await portal(client)).projects[0].files).toEqual([]); // draft
    await asUser(db, designer, (tx) => tx.query("select public.set_file_version_status($1, 'submitted')", [v1.version_id]));
    expect((await portal(client)).projects[0].files).toEqual([]); // awaiting review
    await asUser(db, manager, (tx) => tx.query("select public.set_file_version_status($1, 'approved')", [v1.version_id]));
    expect((await portal(client)).projects[0].files.map((f) => f.version_no)).toEqual([1]);
    const v2 = await upload(designer, gfc, v1.file_id); // new draft: client still sees v1
    expect((await portal(client)).projects[0].files.map((f) => f.version_no)).toEqual([1]);
    await expect(asUser(db, client, (tx) => tx.query("select public.portal_file_access($1)", [v2.version_id]))).rejects.toThrow(/not_found/);
    await asUser(db, manager, (tx) => tx.query("select public.set_file_version_status($1, 'approved')", [v2.version_id]));
    expect((await portal(client)).projects[0].files.map((f) => f.version_no)).toEqual([2]);
    await expect(asUser(db, client, (tx) => tx.query("select public.portal_file_access($1)", [v1.version_id]))).rejects.toThrow(/not_found/);
    // Other clients can't reach it.
    await expect(asUser(db, otherClient, (tx) => tx.query("select public.portal_file_access($1)", [v2.version_id]))).rejects.toThrow(/not_found/);
  });

  it("never shows a version the team sent back before approving it", async () => {
    const other = (await one<{ id: string }>(db, "select id from public.project_folders where project_id = $1 and system_key = 'gfc'", [project])).id;
    const v = await upload(designer, other);
    await asUser(db, designer, (tx) => tx.query("select public.set_file_version_status($1, 'submitted')", [v.version_id]));
    await asUser(db, manager, (tx) => tx.query("select public.set_file_version_status($1, 'changes_requested', 'Bollards too close')", [v.version_id]));
    expect((await portal(client)).projects[0].files.some((f) => f.id === v.file_id)).toBe(false);
    await expect(asUser(db, client, (tx) => tx.query("select public.portal_file_access($1)", [v.version_id]))).rejects.toThrow(/not_found/);
  });

  it("never shows payment proofs", async () => {
    const path = await recordObject(db, `${project}/${randomUUID()}.png`, 10, "image/png", { bucket: "projects" as never });
    const r = await asUser(db, admin, async (tx) => (await one<{ r: { version_id: string } }>(tx, "select public.register_project_file($1, $2, 'proof.png') as r", [proofs, path])).r);
    await asUser(db, admin, (tx) => tx.query("select public.set_file_version_status($1, 'approved')", [r.version_id]));
    expect((await portal(client)).projects[0].files.some((f) => f.version_id === r.version_id)).toBe(false);
  });

  it("records views and the client's decision, and tells the team", async () => {
    const f = (await portal(client)).projects[0].files[0];
    await asUser(db, client, (tx) => tx.query("select public.portal_file_access($1, false)", [f.version_id]));
    await asUser(db, client, (tx) => tx.query("select public.portal_file_access($1, false)", [f.version_id])); // within the hour: one event
    await expect(asUser(db, client, (tx) => tx.query("select public.portal_file_decision($1, false, null)", [f.version_id]))).rejects.toThrow(/comment_required/);
    await asUser(db, client, (tx) => tx.query("select public.portal_file_decision($1, false, 'Please add more shade trees')", [f.version_id]));
    const events = await rows<{ type: string }>(db, "select type from public.project_file_events where version_id = $1 and from_client order by created_at", [f.version_id]);
    expect(events.map((e) => e.type)).toEqual(["client_viewed", "client_changes"]);
    const v = await one<{ status: string; client_comment: string }>(db, "select status, client_comment from public.project_file_versions where id = $1", [f.version_id]);
    expect(v).toEqual({ status: "changes_requested", client_comment: "Please add more shade trees" });
    // Still visible to the client (with their request), and the comment is in the notes.
    expect((await portal(client)).projects[0].files[0].version_id).toBe(f.version_id);
    const comments = await asUser(db, client, async (tx) => (await one<{ c: { body: string }[] }>(tx, "select public.portal_file_comments($1) as c", [f.version_id])).c);
    expect(comments.map((c) => c.body)).toEqual(["Please add more shade trees"]);
  });

  it("lets the manager list and switch off client logins", async () => {
    const logins = await asUser(db, manager, async (tx) => (await one<{ l: { id: string }[] }>(tx, "select public.project_client_logins($1) as l", [project])).l);
    expect(logins.map((l) => l.id)).toEqual([client]);
    await asUser(db, manager, (tx) => tx.query("select public.set_project_client_login($1, $2, false)", [project, client]));
    await expect(portal(client)).rejects.toThrow(/forbidden/);
    await expect(asUser(db, designer, (tx) => tx.query("select public.project_client_logins($1)", [project]))).rejects.toThrow(/forbidden/);
  });
});
