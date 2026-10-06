"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { KeyRound, Loader2, MoreHorizontal, Pencil, Plus, Search, UserCheck, UserX } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataPagination } from "@/components/common/data-pagination";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { ROLE_LABELS, ROLES, SEARCH_DEBOUNCE_MS, type AppRole } from "@/lib/constants";
import { lastPage, parsePaging } from "@/lib/pagination";
import { fetchUsers } from "@/lib/queries";
import { cleanSearch } from "@/lib/search";
import { formatDate } from "@/lib/time";
import type { UserListItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { createUser, resetUserPassword, updateUser } from "@/server/actions/users";

export function UsersView() {
  const me = useProfile();
  const { params, set } = useUrlState();
  const roleParam = params.get("role");
  const query = useMemo(() => ({
    ...parsePaging(params),
    q: cleanSearch(params.get("q")),
    role: ROLES.includes(roleParam as AppRole) ? roleParam : null,
  }), [params, roleParam]);
  const [input, setInput] = useState(query.q);
  const debounced = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    if (debounced !== query.q) set({ q: debounced }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const { data, error, isFetching, isInitialLoading, isStale, refetch } = useLiveQuery({
    queryKey: `users:${JSON.stringify(query)}`,
    fetcher: (s) => fetchUsers(query, s),
    tables: ["profiles"],
  });
  useEffect(() => {
    if (data && !isStale && data.items.length === 0 && data.total > 0 && query.page > 1) set({ page: String(lastPage(data.total, query.pageSize)) }, { replace: true });
  }, [data, isStale, query.page, query.pageSize, set]);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<UserListItem | null>(null);
  const [resetting, setResetting] = useState<UserListItem | null>(null);

  const toggleActive = async (u: UserListItem) => {
    const r = await updateUser({ id: u.id, isActive: !u.is_active });
    if (!r.ok) { toast.error(r.error); return false; }
    toast.success(u.is_active ? "User deactivated" : "User reactivated");
    refetch();
  };

  return (
    <>
      <PageHeader title="Users" description="Create staff accounts, change roles, reset passwords." actions={<Button onClick={() => setCreateOpen(true)}><Plus /> New user</Button>} />
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" className="pl-8" placeholder="Search name or username" value={input} maxLength={100} onChange={(e) => setInput(e.target.value)} aria-label="Search users" />
        </div>
        <Select value={query.role ?? "__all"} onValueChange={(v) => set({ role: v === "__all" ? null : v })}>
          <SelectTrigger className="w-full sm:w-[150px]" aria-label="Role"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All roles</SelectItem>
            {ROLES.map((r) => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}
          </SelectContent>
        </Select>
        <FetchingIndicator show={isFetching && !isInitialLoading} />
      </div>
      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : isInitialLoading ? <ListSkeleton /> : !data?.total ? (
        <EmptyState title="No users found" />
      ) : (
        <div className={cn(isStale && "opacity-60")}>
          <Card className="py-0">
            <Table>
              <TableHeader><TableRow><TableHead>User</TableHead><TableHead>Role</TableHead><TableHead className="hidden md:table-cell">Active leads</TableHead><TableHead className="hidden md:table-cell">Created</TableHead><TableHead className="w-10" /></TableRow></TableHeader>
              <TableBody>
                {data.items.map((u) => (
                  <TableRow key={u.id} className={cn(!u.is_active && "text-muted-foreground")}>
                    <TableCell>
                      <div className="font-medium">{u.display_name}{u.id === me.id ? <span className="ml-1 text-xs text-muted-foreground">(you)</span> : null}</div>
                      <div className="text-xs text-muted-foreground">@{u.username}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant="outline">{ROLE_LABELS[u.role]}</Badge>
                        {!u.is_active ? <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">Deactivated</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="hidden tabular-nums md:table-cell">{u.owned_active_leads}</TableCell>
                    <TableCell className="hidden md:table-cell">{formatDate(u.created_at)}</TableCell>
                    <TableCell>
                      {u.id === me.id ? null : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.display_name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setEditing(u)}><Pencil /> Edit name / role</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setResetting(u)}><KeyRound /> Reset password</DropdownMenuItem>
                          <ConfirmDialog
                            trigger={<DropdownMenuItem onSelect={(e) => e.preventDefault()}>{u.is_active ? <><UserX /> Deactivate</> : <><UserCheck /> Reactivate</>}</DropdownMenuItem>}
                            title={u.is_active ? `Deactivate ${u.display_name}?` : `Reactivate ${u.display_name}?`}
                            description={u.is_active ? "They are signed out of data access immediately and cannot sign in. Their records are kept. Reassign their leads separately." : "They can sign in again with their existing password."}
                            confirmLabel={u.is_active ? "Deactivate" : "Reactivate"}
                            destructive={u.is_active}
                            onConfirm={() => toggleActive(u)}
                          />
                        </DropdownMenuContent>
                      </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <DataPagination page={query.page} pageSize={query.pageSize} total={data.total} disabled={isFetching}
            onPageChange={(p) => set({ page: String(p) })} onPageSizeChange={(s) => set({ pageSize: String(s) })} />
        </div>
      )}
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} onDone={refetch} />
      <EditUserDialog user={editing} onClose={() => setEditing(null)} onDone={refetch} />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />
    </>
  );
}

function CreateUserDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [form, setForm] = useState({ username: "", displayName: "", role: "sales" as AppRole, password: "" });
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();
  const [wasOpen, setWasOpen] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) { setForm({ username: "", displayName: "", role: "sales", password: "" }); setErrors({}); }
  }
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await createUser(form);
      if (!r.ok) {
        setErrors(r.fieldErrors ?? {});
        toast.error(r.error);
        return;
      }
      toast.success(`User @${form.username.trim().toLowerCase()} created`);
      onOpenChange(false);
      onDone();
    });
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>New user</DialogTitle><DialogDescription>Share the username and password with the person directly. Usernames cannot be changed later.</DialogDescription></DialogHeader>
        <form id="create-user" onSubmit={submit} noValidate>
          <FieldGroup className="gap-4">
            <Field data-invalid={!!errors.username}>
              <FieldLabel htmlFor="u-username">Username</FieldLabel>
              <Input id="u-username" autoCapitalize="none" autoComplete="off" spellCheck={false} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} aria-invalid={!!errors.username} />
              <FieldDescription>3–32 characters: letters, numbers, dot, dash or underscore.</FieldDescription>
            </Field>
            <Field data-invalid={!!errors.displayName}>
              <FieldLabel htmlFor="u-name">Display name</FieldLabel>
              <Input id="u-name" value={form.displayName} maxLength={80} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="u-role">Role</FieldLabel>
              <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as AppRole })}>
                <SelectTrigger id="u-role" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{ROLES.map((r) => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field data-invalid={!!errors.password}>
              <FieldLabel htmlFor="u-password">Initial password</FieldLabel>
              <Input id="u-password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button type="submit" form="create-user" disabled={pending}>{pending && <Loader2 className="animate-spin" />}Create user</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({ user, onClose, onDone }: { user: UserListItem | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<AppRole>("sales");
  const [pending, start] = useTransition();
  const [shownFor, setShownFor] = useState(user);
  if (shownFor !== user) {
    setShownFor(user);
    if (user) { setName(user.display_name); setRole(user.role); }
  }
  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Edit @{user?.username}</DialogTitle><DialogDescription>Role changes apply to their next request.</DialogDescription></DialogHeader>
        <FieldGroup className="gap-4">
          <Field><FieldLabel htmlFor="e-name">Display name</FieldLabel><Input id="e-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
          <Field>
            <FieldLabel htmlFor="e-role">Role</FieldLabel>
            <Select value={role} onValueChange={(v) => setRole(v as AppRole)}>
              <SelectTrigger id="e-role" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{ROLES.map((r) => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button disabled={pending || !name.trim()} onClick={() => start(async () => {
            const r = await updateUser({ id: user!.id, displayName: name, role });
            if (!r.ok) return void toast.error(r.error);
            toast.success("User updated");
            onClose();
            onDone();
          })}>{pending && <Loader2 className="animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: UserListItem | null; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [pending, start] = useTransition();
  const [shownFor, setShownFor] = useState(user);
  if (shownFor !== user) {
    setShownFor(user);
    setPassword("");
  }
  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Reset password</DialogTitle><DialogDescription>Set a new password for @{user?.username} and share it with them directly.</DialogDescription></DialogHeader>
        <Field>
          <FieldLabel htmlFor="r-pass">New password</FieldLabel>
          <Input id="r-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button disabled={pending || password.length < 8} onClick={() => start(async () => {
            const r = await resetUserPassword({ id: user!.id, password });
            if (!r.ok) return void toast.error(r.error);
            toast.success("Password reset");
            onClose();
          })}>{pending && <Loader2 className="animate-spin" />}Reset</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
