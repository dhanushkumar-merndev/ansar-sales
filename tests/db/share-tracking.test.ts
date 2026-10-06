import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createLead, createUser, one, rows, type Db } from "./harness";

let db: Db;
let admin: string, salesA: string, salesB: string;
let folder: string;
let fileA: string, fileB: string, fileC: string;

type ShareResult = { share_id: string; token: string; expires_at: string | null; created: boolean; added: number };
type Summary = {
  link: { share_id: string; token: string; expires_at: string | null } | null;
  files: { id: string; name: string; views: number; downloads: number }[];
  older_links: unknown[];
};

async function addFile(name: string) {
  const path = `${folder}/${randomUUID()}.pdf`;
  await asUser(db, salesA, (tx) =>
    tx.query("insert into storage.objects (bucket_id, name, metadata) values ('library', $1, $2)", [path, { size: 100, mimetype: "application/pdf" }]),
  );
  return asUser(db, salesA, async (tx) =>
    (await one<{ id: string }>(tx, "insert into public.library_files (folder_id, name, storage_path) values ($1, $2, $3) returning id", [folder, name, path])).id,
  );
}

const share = (userId: string, leadId: string, files: string[], expiry = "7d") =>
  asUser(db, userId, async (tx) => (await one<{ r: ShareResult }>(tx, "select public.share_lead_files($1, $2::uuid[], $3) as r", [leadId, files, expiry])).r);
const summary = (userId: string, leadId: string) =>
  asUser(db, userId, async (tx) => (await one<{ r: Summary }>(tx, "select public.lead_share_summary($1) as r", [leadId])).r);
const open = (token: string, device = "Android · Chrome") =>
  asUser(db, null, async (tx) =>
    (await one<{ r: { files: { id: string }[]; notify_share_id: string | null } | null }>(tx, "select public.open_lead_share($1, true, $2) as r", [token, device])).r,
  );
const track = (token: string, fileId: string, kind: "view" | "download") =>
  asUser(db, null, async (tx) => (await one<{ r: { name: string } | null }>(tx, "select public.track_share_file($1, $2, $3, 'iPhone · Safari') as r", [token, fileId, kind])).r);
const events = (leadId: string) =>
  rows<{ type: string; file_name: string | null; actor_id: string | null; device: string | null }>(
    db, "select type, file_name, actor_id, device from public.share_events where lead_id = $1 order by created_at, id", [leadId],
  );
/** Moves a lead's customer events into the past so throttling windows have passed. */
const age = (leadId: string, interval: string) =>
  asService(db, (tx) => tx.query(`update public.share_events set created_at = created_at - $2::interval where lead_id = $1`, [leadId, interval]));

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin");
  salesA = await createUser(db, "sales_a", "sales", "Sales A");
  salesB = await createUser(db, "sales_b", "sales", "Sales B");
  folder = await asUser(db, salesA, async (tx) => (await one<{ id: string }>(tx, "insert into public.library_folders (name) values ('Docs') returning id")).id);
  fileA = await addFile("A.pdf");
  fileB = await addFile("B.pdf");
  fileC = await addFile("C.pdf");
});

describe("one link per lead", () => {
  it("adds documents to the same link and resets its expiry", async () => {
    const lead = await createLead(db, salesA);
    const first = await share(salesA, lead, [fileA, fileB], "24h");
    expect(first).toMatchObject({ created: true, added: 2 });

    const second = await share(salesA, lead, [fileB, fileC], "never");
    expect(second.share_id).toBe(first.share_id);
    expect(second.token).toBe(first.token);
    expect(second).toMatchObject({ created: false, added: 1, expires_at: null });

    const page = await open(first.token);
    expect(page!.files.map((f) => f.id)).toEqual([fileA, fileB, fileC]);
    expect((await events(lead)).map((e) => e.type)).toEqual(["link_created", "files_added", "expiry_changed", "files_added", "opened"]);

    const s = await summary(salesA, lead);
    expect(s.link!.token).toBe(first.token);
    expect(s.files.map((f) => f.name)).toEqual(["A.pdf", "B.pdf", "C.pdf"]);
  });

  it("revives an expired link with the same URL, and starts a new one after revoke", async () => {
    const lead = await createLead(db, salesA);
    const first = await share(salesA, lead, [fileA], "24h");
    await asService(db, (tx) => tx.query("update public.lead_shares set expires_at = now() - interval '1 minute' where id = $1", [first.share_id]));
    expect(await open(first.token)).toBeNull();
    const revived = await share(salesA, lead, [fileB], "7d");
    expect(revived.token).toBe(first.token);
    expect(await open(first.token)).not.toBeNull();

    await asUser(db, salesA, (tx) => tx.query("select public.revoke_lead_share($1)", [first.share_id]));
    expect(await open(first.token)).toBeNull();
    const next = await share(salesA, lead, [fileA], "7d");
    expect(next.created).toBe(true);
    expect(next.token).not.toBe(first.token);
    expect((await events(lead)).map((e) => e.type)).toContain("revoked");
  });

  it("removes a document from the link and can add it back", async () => {
    const lead = await createLead(db, salesA);
    const s = await share(salesA, lead, [fileA, fileB]);
    await asUser(db, salesA, (tx) => tx.query("select public.remove_share_file($1, $2)", [s.share_id, fileB]));
    expect((await open(s.token))!.files.map((f) => f.id)).toEqual([fileA]);
    expect(await track(s.token, fileB, "view")).toBeNull();
    expect((await events(lead)).at(-2)).toMatchObject({ type: "file_removed", file_name: "B.pdf", actor_id: salesA });

    const again = await share(salesA, lead, [fileB]);
    expect(again.added).toBe(1);
    expect((await open(s.token))!.files.map((f) => f.id)).toEqual([fileA, fileB]);
  });
});

describe("customer tracking", () => {
  it("records opens, views and downloads with the device, throttled", async () => {
    const lead = await createLead(db, salesA);
    const s = await share(salesA, lead, [fileA]);
    await open(s.token);
    await open(s.token); // within 30 min: not recorded again
    expect(await track(s.token, fileA, "view")).toMatchObject({ name: "A.pdf" });
    await track(s.token, fileA, "view"); // within 2 min: ignored
    await track(s.token, fileA, "download");

    const customer = (await events(lead)).filter((e) => e.actor_id === null);
    expect(customer.map((e) => [e.type, e.file_name, e.device])).toEqual([
      ["opened", null, "Android · Chrome"],
      ["file_viewed", "A.pdf", "iPhone · Safari"],
      ["file_downloaded", "A.pdf", "iPhone · Safari"],
    ]);

    await age(lead, "1 hour");
    await open(s.token);
    await track(s.token, fileA, "view");
    const sum = await summary(salesA, lead);
    expect(sum.files[0]).toMatchObject({ views: 2, downloads: 1 });
    expect((await events(lead)).filter((e) => e.type === "opened")).toHaveLength(2);
  });

  it("caps customer events per link per day", async () => {
    const lead = await createLead(db, salesA);
    const s = await share(salesA, lead, [fileA]);
    await asService(db, (tx) =>
      tx.query(
        "insert into public.share_events (share_id, lead_id, type, created_at) select $1, $2, 'opened', now() - interval '1 hour' from generate_series(1, 500)",
        [s.share_id, lead],
      ),
    );
    await track(s.token, fileA, "download");
    expect((await events(lead)).filter((e) => e.type === "file_downloaded")).toHaveLength(0);
  });

  it("adds one main-timeline entry on the first open and notifies once per day", async () => {
    const lead = await createLead(db, salesA);
    const s = await share(salesA, lead, [fileA]);
    const first = await open(s.token);
    const second = await open(s.token);
    expect(first!.notify_share_id).toBe(s.share_id);
    expect(second!.notify_share_id).toBeNull();
    const opened = await rows(db, "select 1 from public.lead_activities where lead_id = $1 and type = 'share_opened'", [lead]);
    expect(opened).toHaveLength(1);

    await asService(db, (tx) => tx.query("update public.lead_shares set last_notified_on = current_date - 2 where id = $1", [s.share_id]));
    expect((await open(s.token))!.notify_share_id).toBe(s.share_id);
  });

  it("keeps events, tokens and summaries scoped", async () => {
    const lead = await createLead(db, salesA);
    await share(salesA, lead, [fileA]);
    expect(await asUser(db, salesB, (tx) => rows(tx, "select id from public.share_events where lead_id = $1", [lead]))).toHaveLength(0);
    expect(await asUser(db, admin, (tx) => rows(tx, "select id from public.share_events where lead_id = $1", [lead]))).not.toHaveLength(0);
    await expect(summary(salesB, lead)).rejects.toThrow(/not_found/);
    await expect(share(salesB, lead, [fileB])).rejects.toThrow(/not_found/);
    await expect(asUser(db, salesA, (tx) => tx.query("select token from public.lead_shares"))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, null, (tx) => tx.query("select * from public.share_events"))).rejects.toThrow(/permission denied/);
    expect(await asUser(db, null, async (tx) => (await one<{ r: unknown }>(tx, "select public.track_share_file($1, $2, 'view') as r", ["0".repeat(64), fileA])).r)).toBeNull();
  });
});
