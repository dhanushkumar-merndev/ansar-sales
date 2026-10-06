import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createUser, one, type Db } from "./harness";

type Item = { kind: "folder" | "file"; id: string; name: string; position: number; file_count?: number; subfolder_count?: number };
type Page = { items: Item[]; total: number };

let db: Db;
let admin: string, sales: string;
let root: string;

async function folder(userId: string, name: string, parentId: string | null = null) {
  return asUser(db, userId, async (tx) =>
    (await one<{ id: string }>(tx, "insert into public.library_folders (name, parent_id) values ($1, $2) returning id", [name, parentId])).id);
}

/** Simulates a Storage upload, then registers the file row. */
async function file(userId: string, folderId: string, name: string) {
  const path = `${folderId}/${randomUUID()}.pdf`;
  return asUser(db, userId, async (tx) => {
    await tx.query("insert into storage.objects (bucket_id, name, owner, metadata) values ('library', $1, $2, $3)", [path, userId, { size: 100, mimetype: "application/pdf" }]);
    return (await one<{ id: string }>(tx, "insert into public.library_files (folder_id, name, storage_path) values ($1, $2, $3) returning id", [folderId, name, path])).id;
  });
}

async function list(userId: string, args: Record<string, unknown>): Promise<Page> {
  const keys = Object.keys(args);
  const named = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
  return asUser(db, userId, async (tx) =>
    (await one<{ r: Page }>(tx, `select public.list_library_items(${named}) as r`, Object.values(args))).r);
}

const names = (p: Page) => p.items.map((i) => i.name);

function reorder(userId: string, parentId: string | null, items: Item[]) {
  return asUser(db, userId, (tx) =>
    tx.query("select public.reorder_library_items($1, $2::jsonb)", [parentId, JSON.stringify(items.map(({ kind, id }) => ({ kind, id })))]));
}

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin");
  sales = await createUser(db, "sales", "sales");
  root = await folder(sales, "Root");
  // Created in this order, each in its own transaction, so created_at increases.
  await file(sales, root, "beta.pdf");
  await folder(sales, "Zeta", root);
  await file(sales, root, "alpha.pdf");
  await folder(sales, "Alpha folder", root);
});

describe("list_library_items", () => {
  it("lists folders first by default, in the order items were added", async () => {
    const r = await list(sales, { p_parent_id: root });
    expect(r.total).toBe(4);
    expect(names(r)).toEqual(["Zeta", "Alpha folder", "beta.pdf", "alpha.pdf"]);
  });

  it("sorts by name and date, with folders first or mixed in", async () => {
    expect(names(await list(sales, { p_parent_id: root, p_sort: "name", p_dir: "asc" }))).toEqual(["Alpha folder", "Zeta", "alpha.pdf", "beta.pdf"]);
    expect(names(await list(sales, { p_parent_id: root, p_sort: "name", p_dir: "asc", p_folders_first: false })))
      .toEqual(["Alpha folder", "alpha.pdf", "beta.pdf", "Zeta"]);
    expect(names(await list(sales, { p_parent_id: root, p_sort: "name", p_dir: "desc", p_folders_first: false })))
      .toEqual(["Zeta", "beta.pdf", "alpha.pdf", "Alpha folder"]);
    expect(names(await list(sales, { p_parent_id: root, p_sort: "created", p_dir: "desc", p_folders_first: false })))
      .toEqual(["Alpha folder", "alpha.pdf", "Zeta", "beta.pdf"]);
    expect(names(await list(sales, { p_parent_id: root, p_sort: "created", p_dir: "asc" }))).toEqual(["Zeta", "Alpha folder", "beta.pdf", "alpha.pdf"]);
  });

  it("pages, searches and lists only folders at the top level", async () => {
    const p1 = await list(sales, { p_parent_id: root, p_sort: "name", p_folders_first: false, p_limit: 3 });
    const p2 = await list(sales, { p_parent_id: root, p_sort: "name", p_folders_first: false, p_limit: 3, p_offset: 3 });
    expect([...names(p1), ...names(p2)]).toEqual(["Alpha folder", "alpha.pdf", "beta.pdf", "Zeta"]);
    expect(p2.total).toBe(4);
    expect(names(await list(sales, { p_parent_id: root, p_search: "ALPHA" }))).toEqual(["Alpha folder", "alpha.pdf"]);
    expect((await list(sales, { p_parent_id: root, p_search: "%" })).total).toBe(0);
    const top = await list(sales, {});
    expect(top.items).toEqual([expect.objectContaining({ kind: "folder", name: "Root", file_count: 2, subfolder_count: 2 })]);
  });

  it("rejects unknown sorts and bad paging", async () => {
    await expect(list(sales, { p_parent_id: root, p_sort: "size" })).rejects.toThrow(/invalid_sort/);
    await expect(list(sales, { p_parent_id: root, p_dir: "up" })).rejects.toThrow(/invalid_sort/);
    await expect(list(sales, { p_parent_id: root, p_limit: 101 })).rejects.toThrow(/invalid_limit/);
  });
});

describe("reorder_library_items", () => {
  it("lets admin interleave folders and files, keeping the same position slots", async () => {
    const before = await list(admin, { p_parent_id: root, p_folders_first: false });
    const slots = before.items.map((i) => i.position).sort((a, b) => a - b);
    const wanted = [before.items[3], before.items[0], before.items[2], before.items[1]];
    await reorder(admin, root, wanted);
    const after = await list(sales, { p_parent_id: root, p_folders_first: false });
    expect(after.items.map((i) => i.id)).toEqual(wanted.map((i) => i.id));
    expect(after.items.map((i) => i.position)).toEqual(slots);
    // Folders first still applies on top of the custom order.
    expect(after.items.length).toBe(4);
    const grouped = await list(sales, { p_parent_id: root });
    expect(grouped.items.map((i) => i.kind)).toEqual(["folder", "folder", "file", "file"]);
  });

  it("adds new items at the end of the custom order", async () => {
    await file(sales, root, "gamma.pdf");
    const r = await list(sales, { p_parent_id: root, p_folders_first: false });
    expect(r.items.at(-1)?.name).toBe("gamma.pdf");
  });

  it("is admin-only and rejects items from another folder or duplicates", async () => {
    const r = await list(admin, { p_parent_id: root, p_folders_first: false });
    await expect(reorder(sales, root, r.items)).rejects.toThrow(/forbidden/);
    await expect(reorder(admin, null, r.items)).rejects.toThrow(/invalid_order/);
    await expect(reorder(admin, root, [r.items[0], r.items[0]])).rejects.toThrow(/invalid_order/);
    await expect(reorder(admin, root, [])).rejects.toThrow(/invalid_order/);
    const top = await list(admin, {});
    await reorder(admin, null, top.items);
  });
});

describe("move_library_items", () => {
  const move = (userId: string, target: string | null, items: { kind: "folder" | "file"; id: string }[]) =>
    asUser(db, userId, async (tx) =>
      (await one<{ n: number }>(tx, "select public.move_library_items($1, $2::jsonb) as n", [target, JSON.stringify(items)])).n);
  const parentOf = (id: string) => asUser(db, admin, async (tx) =>
    (await one<{ parent_id: string | null }>(tx, "select parent_id from public.library_folders where id = $1", [id])).parent_id);

  it("moves files and folders, appending them to the target's custom order", async () => {
    const a = await folder(sales, "Move A");
    const b = await folder(sales, "Move B");
    const sub = await folder(sales, "Inner", a);
    const f1 = await file(sales, a, "one.pdf");
    await file(sales, b, "already.pdf");
    expect(await move(admin, b, [{ kind: "file", id: f1 }, { kind: "folder", id: sub }])).toBe(2);
    const inB = await list(sales, { p_parent_id: b, p_folders_first: false });
    expect(names(inB)).toEqual(["already.pdf", "one.pdf", "Inner"]);
    expect((await list(sales, { p_parent_id: a })).total).toBe(0);
    // The moved file still points at its original object.
    const path = await asUser(db, admin, async (tx) => (await one<{ storage_path: string }>(tx, "select storage_path from public.library_files where id = $1", [f1])).storage_path);
    expect(path.startsWith(`${a}/`)).toBe(true);
    // A folder can go back to the top level; files can't.
    expect(await move(admin, null, [{ kind: "folder", id: sub }])).toBe(1);
    expect(await parentOf(sub)).toBeNull();
    await expect(move(admin, null, [{ kind: "file", id: f1 }])).rejects.toThrow(/invalid_move/);
  });

  it("refuses cycles, too-deep nesting, name clashes, and non-admins", async () => {
    const top = await folder(admin, "Deep 1");
    let parent = top;
    const chain = [top];
    for (let i = 2; i <= 5; i++) chain.push((parent = await folder(admin, `Deep ${i}`, parent)));
    await expect(move(admin, chain[3], [{ kind: "folder", id: chain[1] }])).rejects.toThrow(/invalid_move/);
    await expect(move(admin, chain[0], [{ kind: "folder", id: chain[0] }])).rejects.toThrow(/invalid_move/);
    const two = await folder(admin, "Two levels");
    await folder(admin, "Child", two);
    await expect(move(admin, chain[3], [{ kind: "folder", id: two }])).rejects.toThrow(/folder_too_deep/);
    const twin = await folder(admin, "Deep 2"); // same name as chain[1], at the top level
    await expect(move(admin, chain[0], [{ kind: "folder", id: twin }])).rejects.toThrow(/library_folders_active_name_key/);
    await expect(move(sales, top, [{ kind: "folder", id: two }])).rejects.toThrow(/forbidden/);
    await expect(move(admin, top, [{ kind: "folder", id: two }, { kind: "folder", id: two }])).rejects.toThrow(/invalid_move/);
  });

  it("keeps parents fixed for ordinary updates", async () => {
    const x = await folder(admin, "Fixed X");
    const y = await folder(admin, "Fixed Y");
    // Even with full table rights, the trigger pins the parent outside move_library_items.
    await asService(db, (tx) => tx.query("update public.library_folders set parent_id = $1 where id = $2", [x, y]));
    expect(await parentOf(y)).toBeNull();
  });
});
