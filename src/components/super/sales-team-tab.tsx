"use client";

import { useState, useTransition } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { ErrorState, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLiveQuery } from "@/hooks/use-live-query";
import type { CompanyBrand } from "@/lib/companies";
import { createClient } from "@/lib/supabase/client";
import { setUserCompanyAccess } from "@/server/actions/companies";

type AccessRole = "sales" | "admin";
type TeamUser = {
  id: string; display_name: string; username: string; company_id: string; company_name: string;
  can_sales: boolean; can_admin: boolean; access: { company_id: string; role: AccessRole }[];
};
type Picked = Record<string, AccessRole>;

const toPicked = (u: TeamUser): Picked => Object.fromEntries(u.access.map((a) => [a.company_id, a.role]));
const sameAccess = (a: Picked, b: Picked) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

/** Super admin: the other companies of ours each salesperson or admin also works in, and as what. */
export function SalesTeamTab() {
  const { companies } = useProfile();
  const users = useLiveQuery({
    queryKey: "super-team-access",
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("super_list_team_access").abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as unknown as TeamUser[];
    },
    tables: ["profiles", "companies"],
    pollMs: 0,
  });
  if (users.error && !users.data) return <ErrorState message={users.error} onRetry={users.refetch} />;
  if (!users.data) return <ListSkeleton rows={6} />;

  return (
    <Card className="max-w-4xl">
      <CardHeader>
        <CardTitle>Team across companies</CardTitle>
        <CardDescription>
          Pick the other companies a person also works in. They switch there at the top left.
          As <span className="font-medium text-foreground">Sales</span> they work their own and assigned leads, follow-ups and dashboard.
          As <span className="font-medium text-foreground">Admin</span> they are a full admin of that company: all leads, finance,
          settings and its users (creating users, roles, passwords), and they get its admin alerts. Client CRMs are not included.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {users.data.length === 0 ? <p className="text-sm text-muted-foreground">No sales users or admins yet.</p>
          : users.data.map((u) => (
            <TeamUserRow key={`${u.id}:${u.access.map((a) => `${a.company_id}=${a.role}`).join()}`} user={u} companies={companies} onChanged={users.refetch} />
          ))}
      </CardContent>
    </Card>
  );
}

function TeamUserRow({ user, companies, onChanged }: { user: TeamUser; companies: CompanyBrand[]; onChanged: () => void }) {
  const saved = toPicked(user);
  const [picked, setPicked] = useState<Picked>(saved);
  const [pending, start] = useTransition();
  const others = companies.filter((c) => c.id !== user.company_id);
  const dirty = !sameAccess(picked, saved);
  const removed = Object.keys(saved).some((id) => !picked[id]);

  const setRole = (companyId: string, value: string) => setPicked((cur) => {
    const next = { ...cur };
    if (value === "sales" || value === "admin") next[companyId] = value;
    else delete next[companyId];
    return next;
  });

  const save = () => start(async () => {
    const access = Object.entries(picked).map(([companyId, role]) => ({ companyId, role }));
    const r = await setUserCompanyAccess({ id: user.id, access });
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
        {user.can_admin ? <Badge variant="secondary">Admin</Badge> : null}
        {user.can_sales ? <Badge variant="secondary">Sales</Badge> : null}
        <Badge variant="outline">{user.company_name}</Badge>
      </div>
      {others.length === 0 ? <p className="text-xs text-muted-foreground">No other companies yet.</p> : (
        <div className="grid gap-2 sm:grid-cols-2">
          {others.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm" id={`a-${user.id}-${c.id}`}>{c.name}</span>
              <Select value={picked[c.id] ?? "none"} onValueChange={(v) => setRole(c.id, v)}>
                <SelectTrigger size="sm" className="w-32 shrink-0" aria-labelledby={`a-${user.id}-${c.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No access</SelectItem>
                  {user.can_sales ? <SelectItem value="sales">Sales</SelectItem> : null}
                  {user.can_admin ? <SelectItem value="admin">Admin</SelectItem> : null}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}
      {dirty ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={save} disabled={pending}>{pending ? <Loader2 className="animate-spin" /> : <Save />} Save companies</Button>
          {removed ? (
            <span className="text-xs text-muted-foreground">Leads they own in a company they leave stay theirs; that company&apos;s admin can reassign them.</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
