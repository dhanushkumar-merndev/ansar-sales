"use client";

import { useProfile } from "@/components/providers/profile-provider";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useHiddenColumns } from "@/hooks/use-hidden-columns";
import { TABLE_COLUMNS, type ColumnTable } from "@/lib/table-columns";

const TITLES: Record<ColumnTable, string> = { leads: "Leads table", follow_ups: "Follow-ups list" };

/** Which columns this person sees on the Leads table and Follow-ups list (saved to their account). */
export function TableColumnsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Table columns</CardTitle>
        <CardDescription>Choose what you see. Saved to your account, so it follows you to every device.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 sm:grid-cols-2">
        <ColumnGroup table="leads" />
        <ColumnGroup table="follow_ups" />
      </CardContent>
    </Card>
  );
}

function ColumnGroup({ table }: { table: ColumnTable }) {
  const isAdmin = useProfile().role === "admin";
  const { hidden, hiddenList, setHidden, loading } = useHiddenColumns(table);
  const columns = TABLE_COLUMNS[table].filter((c) => !("adminOnly" in c && c.adminOnly) || isAdmin);
  return (
    <fieldset className="space-y-2.5">
      <legend className="mb-2 text-sm font-medium">{TITLES[table]}</legend>
      {loading
        ? columns.map((c) => <Skeleton key={c.id} className="h-5 w-32" />)
        : columns.map((c) => (
            <Label key={c.id} className="flex items-center gap-2 font-normal">
              <Checkbox
                checked={!hidden.has(c.id)}
                onCheckedChange={(on) => void setHidden(on === true ? hiddenList.filter((h) => h !== c.id) : [...hiddenList, c.id])}
              />
              {c.label}
            </Label>
          ))}
    </fieldset>
  );
}
