"use client";

import { useState, useTransition } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { ErrorState, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useLiveQuery } from "@/hooks/use-live-query";
import type { CompanyBrand } from "@/lib/companies";
import { createClient } from "@/lib/supabase/client";
import { setSalesUserCompanies } from "@/server/actions/companies";

type SalesUser = { id: string; display_name: string; username: string; company_id: string; company_name: string; company_ids: string[] };

/** Super admin: the other companies of ours each sales user also works in. */
export function SalesTeamTab() {
  const { companies } = useProfile();
  const users = useLiveQuery({
    queryKey: "super-sales-users",
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("super_list_sales_users").abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as unknown as SalesUser[];
    },
    tables: ["profiles", "companies"],
    pollMs: 0,
  });
  if (users.error && !users.data) return <ErrorState message={users.error} onRetry={users.refetch} />;
  if (!users.data) return <ListSkeleton rows={6} />;

  return (
    <Card className="max-w-4xl">
      <CardHeader>
        <CardTitle>Sales team across companies</CardTitle>
        <CardDescription>
          Tick the other companies a salesperson also works in. They switch there at the top left and work as Sales: their own
          and assigned leads, follow-ups and dashboard. That company&apos;s admin can then assign them leads and add them to
          Facebook lead routing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {users.data.length === 0 ? <p className="text-sm text-muted-foreground">No sales users yet.</p>
          : users.data.map((u) => <SalesUserRow key={`${u.id}:${u.company_ids.join()}`} user={u} companies={companies} onChanged={users.refetch} />)}
      </CardContent>
    </Card>
  );
}

function SalesUserRow({ user, companies, onChanged }: { user: SalesUser; companies: CompanyBrand[]; onChanged: () => void }) {
  const [picked, setPicked] = useState(user.company_ids);
  const [pending, start] = useTransition();
  const others = companies.filter((c) => c.id !== user.company_id);
  const dirty = [...picked].sort().join() !== [...user.company_ids].sort().join();
  const save = () => start(async () => {
    const r = await setSalesUserCompanies({ id: user.id, companyIds: picked });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(`Saved. ${user.display_name}'s access changes at once.`);
    onChanged();
  });
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{user.display_name}</div>
          <div className="text-xs text-muted-foreground">@{user.username}</div>
        </div>
        <Badge variant="outline">{user.company_name}</Badge>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <span className="text-xs text-muted-foreground">Also works in:</span>
        {others.map((c) => (
          <Label key={c.id} htmlFor={`s-${user.id}-${c.id}`} className="flex items-center gap-2 font-normal">
            <Checkbox id={`s-${user.id}-${c.id}`} checked={picked.includes(c.id)}
              onCheckedChange={(v) => setPicked(v === true ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
            {c.name}
          </Label>
        ))}
      </div>
      {dirty ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={save} disabled={pending}>{pending ? <Loader2 className="animate-spin" /> : <Save />} Save companies</Button>
          {user.company_ids.some((id) => !picked.includes(id)) ? (
            <span className="text-xs text-muted-foreground">Leads they own in an unticked company stay theirs; that company&apos;s admin can reassign them.</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
