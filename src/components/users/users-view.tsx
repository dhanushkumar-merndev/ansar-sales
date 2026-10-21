"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { KeyRound, Loader2, MoreHorizontal, Pencil, Plus, Search, UserCheck, UserX } from "lucide-react";
import { toast } from "sonner";
import { ClearFiltersButton } from "@/components/common/clear-filters-button";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataPagination } from "@/components/common/data-pagination";
import Link from "next/link";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { ASSIGNABLE_ROLES, isProjectRole, roleLabel, SEARCH_DEBOUNCE_MS, type AssignableRole } from "@/lib/constants";
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
    role: (ASSIGNABLE_ROLES as readonly string[]).includes(roleParam ?? "") ? roleParam : null,
    inactive: params.get("inactive") === "1",
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
      <PageHeader title="Users" description={`Staff accounts of ${me.company.name}: create users, change roles, reset passwords.`} actions={<Button onClick={() => setCreateOpen(true)}><Plus /> New user</Button>} />
      {me.isSuperAdmin ? (
        <p className="mb-3 text-sm text-muted-foreground">
          Ads managers work across companies, so they&apos;re created in{" "}
          <Link href="/super?tab=ads" className="font-medium text-foreground underline underline-offset-4">Super settings → Ads</Link>.
        </p>
      ) : null}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" className="pl-8" placeholder="Search name or username" value={input} maxLength={100} onChange={(e) => setInput(e.target.value)} aria-label="Search users" />
        </div>
        <Select value={query.role ?? "__all"} onValueChange={(v) => set({ role: v === "__all" ? null : v })}>
          <SelectTrigger className="w-full sm:w-[190px]" aria-label="Role"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All roles</SelectItem>
            {roleChoices(me.features).map((r) => <SelectItem key={r} value={r}>{roleLabel(r, me.features)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Label className="flex shrink-0 items-center gap-2 font-normal">
          <Checkbox checked={query.inactive} onCheckedChange={(c) => set({ inactive: c === true ? "1" : null })} /> Show deactivated
        </Label>
        <ClearFiltersButton loading={isFetching && !isInitialLoading}
          show={!!(query.q || query.role || query.inactive)}
          onClear={() => { setInput(""); set({ q: null, role: null, inactive: null }); }}
        />
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
                        <Badge variant="outline">{roleLabel(u.role, me.features)}</Badge>
                        {(u.extra_roles ?? []).map((r) => <Badge key={r} variant="secondary" className="font-normal">{roleLabel(r, me.features)}</Badge>)}
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
                          <DropdownMenuItem onSelect={() => setEditing(u)}><Pencil /> Edit name / roles</DropdownMenuItem>
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

/** Roles this company can assign: project roles only where the projects module is on. */
function roleChoices(features: readonly string[]) {
  // An ads client's CRM is leads only: no finance, so no Account role.
  if (features.includes("client_workspace")) return ASSIGNABLE_ROLES.filter((r) => r === "admin" || r === "sales");
  return ASSIGNABLE_ROLES.filter((r) => !isProjectRole(r) || features.includes("projects"));
}

/** Admin already covers these, so they're never offered as extra roles for an admin. */
const COVERED_BY_ADMIN: AssignableRole[] = ["admin", "account"];

/**
 * Main role plus optional extra roles, hidden until "Also works as" is ticked. Each extra role is
 * ticked on purpose; the person gets the permissions of all of them.
 */
function RoleFields({ idPrefix, role, extraRoles, special, displayName, onChange, onSpecialChange }: {
  idPrefix: string; role: AssignableRole; extraRoles: AssignableRole[]; special: boolean; displayName: string;
  onChange: (v: { role: AssignableRole; extraRoles: AssignableRole[] }) => void;
  onSpecialChange: (on: boolean) => void;
}) {
  const me = useProfile();
  const choices = roleChoices(me.features);
  // Admin is given as a main role only. Keep roles the person already has even if no longer offered.
  const offered = choices.filter((r) => r !== "admin" && !(role === "admin" && COVERED_BY_ADMIN.includes(r)));
  const extraChoices = [...new Set([...offered, ...extraRoles])].filter((r) => r !== role);
  const summary = [role, ...extraChoices.filter((r) => extraRoles.includes(r))].map((r) => roleLabel(r, me.features)).join(" + ");
  const changeMain = (v: AssignableRole) =>
    onChange({ role: v, extraRoles: extraRoles.filter((r) => r !== v && !(v === "admin" && COVERED_BY_ADMIN.includes(r))) });
  return (
    <Field>
      <FieldLabel htmlFor={`${idPrefix}-role`}>Role</FieldLabel>
      <Select value={role} onValueChange={(v) => changeMain(v as AssignableRole)}>
        <SelectTrigger id={`${idPrefix}-role`} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{choices.map((r) => <SelectItem key={r} value={r}>{roleLabel(r, me.features)}</SelectItem>)}</SelectContent>
      </Select>
      {role === "admin" ? <FieldDescription>Admins can see and do everything.</FieldDescription> : null}
      {extraChoices.length ? (
        <label htmlFor={`${idPrefix}-special`} className="mt-1 flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox id={`${idPrefix}-special`} checked={special} onCheckedChange={(on) => {
            onSpecialChange(!!on);
            if (!on) onChange({ role, extraRoles: [] });
          }} />
          Also works as another role
        </label>
      ) : null}
      {special ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            {extraChoices.map((r) => {
              const id = `${idPrefix}-extra-${r}`;
              return (
                <label key={r} htmlFor={id} className="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-sm has-[[data-state=checked]]:border-primary/40 has-[[data-state=checked]]:bg-primary/5">
                  <Checkbox id={id} checked={extraRoles.includes(r)} onCheckedChange={(on) => onChange({ role, extraRoles: on ? [...extraRoles, r] : extraRoles.filter((x) => x !== r) })} />
                  {roleLabel(r, me.features)}
                </label>
              );
            })}
          </div>
          <FieldDescription>
            {role === "admin" ? "Tick a role so they can be picked for that work, e.g. a project team." : "Tick each role they should also have."}
          </FieldDescription>
        </>
      ) : null}
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{displayName.trim() || "This person"}</span> works as {summary}
      </p>
    </Field>
  );
}

function CreateUserDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [form, setForm] = useState({ username: "", displayName: "", role: "sales" as AssignableRole, extraRoles: [] as AssignableRole[], password: "" });
  const [special, setSpecial] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();
  const [wasOpen, setWasOpen] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) { setForm({ username: "", displayName: "", role: "sales", extraRoles: [], password: "" }); setSpecial(false); setErrors({}); }
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
            <Field data-invalid={!!errors.username?.length}>
              <FieldLabel htmlFor="u-username">Username</FieldLabel>
              <Input id="u-username" autoCapitalize="none" autoComplete="off" spellCheck={false} value={form.username} onChange={(e) => { setForm({ ...form, username: e.target.value }); if (errors.username) setErrors({ ...errors, username: [] }); }} aria-invalid={!!errors.username?.length} />
              {errors.username?.length
                ? <FieldError>{errors.username[0] === "Already taken" ? "This username is already used. Pick another, or edit the existing user to give them more roles." : errors.username[0]}</FieldError>
                : <FieldDescription>3–32 characters: letters, numbers, dot, dash or underscore.</FieldDescription>}
            </Field>
            <Field data-invalid={!!errors.displayName}>
              <FieldLabel htmlFor="u-name">Display name</FieldLabel>
              <Input id="u-name" value={form.displayName} maxLength={80} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            </Field>
            <RoleFields idPrefix="u" role={form.role} extraRoles={form.extraRoles} special={special} displayName={form.displayName} onChange={(v) => setForm({ ...form, ...v })} onSpecialChange={setSpecial} />
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
  const [roles, setRoles] = useState<{ role: AssignableRole; extraRoles: AssignableRole[] }>({ role: "sales", extraRoles: [] });
  const [special, setSpecial] = useState(false);
  const [pending, start] = useTransition();
  const [shownFor, setShownFor] = useState(user);
  if (shownFor !== user) {
    setShownFor(user);
    if (user) { setName(user.display_name); setRoles({ role: user.role, extraRoles: user.extra_roles ?? [] }); setSpecial((user.extra_roles ?? []).length > 0); }
  }
  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Edit @{user?.username}</DialogTitle><DialogDescription>Role changes apply to their next request.</DialogDescription></DialogHeader>
        <FieldGroup className="gap-4">
          <Field><FieldLabel htmlFor="e-name">Display name</FieldLabel><Input id="e-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
          <RoleFields idPrefix="e" role={roles.role} extraRoles={roles.extraRoles} special={special} displayName={name} onChange={setRoles} onSpecialChange={setSpecial} />
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button disabled={pending || !name.trim()} onClick={() => start(async () => {
            const r = await updateUser({ id: user!.id, displayName: name, role: roles.role, extraRoles: roles.extraRoles });
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
