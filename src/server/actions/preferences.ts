"use server";

import { z } from "zod";
import { dbError } from "@/lib/errors";
import { COLUMN_TABLES, TABLE_COLUMNS, type ColumnTable } from "@/lib/table-columns";
import { runAction } from "@/server/action-utils";

/** Saves which columns the signed-in person hides on one list. */
export async function setTableColumns(input: unknown) {
  const schema = z
    .object({ table: z.enum(COLUMN_TABLES as [ColumnTable, ...ColumnTable[]]), hidden: z.array(z.string()).max(20) })
    .refine((d) => d.hidden.every((c) => TABLE_COLUMNS[d.table].some((col) => col.id === c)), { message: "Unknown column" });
  return runAction(["admin", "sales"], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_table_columns", { p_table: d.table, p_hidden: d.hidden });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}
