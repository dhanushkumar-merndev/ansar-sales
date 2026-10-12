"use client";

import { useState, useTransition } from "react";
import { KeyRound, Loader2, Plus, UserCheck, UserX } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useLiveQuery } from "@/hooks/use-live-query";
import { createClient } from "@/lib/supabase/client";
import { formatRelative } from "@/lib/time";
import { createProjectClientLogin, resetProjectClientPassword, setProjectClientActive } from "@/server/actions/project-portal";

type Login = { id: string; username: string; display_name: string; is_active: boolean; created_at: string; last_seen_at: string | null };

/** Portal logins for the client (managers): they see approved files, the timeline and payments. */
export function ClientAccessCard({ projectId, clientName }: { projectId: string; clientName: string }) {
  const q = useLiveQuery({
    queryKey: `project-client-logins:${projectId}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("project_client_logins", { p_project_id: projectId }).abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as unknown as Login[];
    },
    tables: ["profiles", "project_members"],
  });
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "reset"; login: Login } | null>(null);
  const [form, setForm] = useState({ username: "", displayName: clientName, password: "" });
  const [pending, start] = useTransition();
  const openCreate = () => { setForm({ username: "", displayName: clientName, password: "" }); setDialog({ mode: "create" }); };
  const toggle = (l: Login) => start(async () => {
    const r = await setProjectClientActive({ projectId, userId: l.id, isActive: !l.is_active });
    if (!r.ok) return void toast.error(r.error);
    toast.success(l.is_active ? "Portal login switched off" : "Portal login switched on");
    q.refetch();
  });
  return (
    <Card className="gap-0">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">Client portal</CardTitle>
        <Button size="sm" variant="outline" onClick={openCreate}><Plus /> Login</Button>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-xs text-muted-foreground">The client sees the timeline, approved files (never drafts) and the payment schedule, and can approve or ask for changes.</p>
        {!q.data?.length ? <p className="text-muted-foreground">No client login yet.</p> : q.data.map((l) => (
          <div key={l.id} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{l.display_name} <span className="font-normal text-muted-foreground">@{l.username}</span></div>
              <div className="text-xs text-muted-foreground">{l.last_seen_at ? `Last active ${formatRelative(l.last_seen_at)}` : "Not opened yet"}</div>
            </div>
            {!l.is_active ? <Badge variant="outline">Off</Badge> : null}
            <Button size="icon-sm" variant="ghost" aria-label="Reset password" onClick={() => { setForm({ ...form, password: "" }); setDialog({ mode: "reset", login: l }); }}><KeyRound /></Button>
            <Button size="icon-sm" variant="ghost" disabled={pending} aria-label={l.is_active ? "Switch off" : "Switch on"} onClick={() => toggle(l)}>{l.is_active ? <UserX /> : <UserCheck />}</Button>
          </div>
        ))}
      </CardContent>
      <Dialog open={!!dialog} onOpenChange={(o) => !o && !pending && setDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{dialog?.mode === "reset" ? `New password for @${dialog.login.username}` : "Client portal login"}</DialogTitle>
            <DialogDescription>Share the username and password with the client directly (e.g. on WhatsApp).</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-3">
            {dialog?.mode === "create" ? (
              <>
                <Field><FieldLabel htmlFor="cl-user">Username</FieldLabel><Input id="cl-user" autoCapitalize="none" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                  <FieldDescription>e.g. hari.residence</FieldDescription></Field>
                <Field><FieldLabel htmlFor="cl-name">Name</FieldLabel><Input id="cl-name" value={form.displayName} maxLength={80} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
              </>
            ) : null}
            <Field><FieldLabel htmlFor="cl-pass">Password</FieldLabel><Input id="cl-pass" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)} disabled={pending}>Cancel</Button>
            <Button disabled={pending || form.password.length < 8} onClick={() => start(async () => {
              const r = dialog?.mode === "reset"
                ? await resetProjectClientPassword({ projectId, userId: dialog.login.id, password: form.password })
                : await createProjectClientLogin({ projectId, ...form });
              if (!r.ok) return void toast.error(r.error);
              toast.success(dialog?.mode === "reset" ? "Password changed" : "Client login created");
              setDialog(null);
              q.refetch();
            })}>{pending && <Loader2 className="animate-spin" />}Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
