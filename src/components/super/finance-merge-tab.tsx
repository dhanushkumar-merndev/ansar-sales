"use client";

import { useState, useTransition } from "react";
import { BookOpen, Loader2, Merge, Split } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorState, ListSkeleton } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useLiveQuery } from "@/hooks/use-live-query";
import { createClient } from "@/lib/supabase/client";
import { mergeBooks, setBookEditors, splitBooks } from "@/server/actions/books";

type BooksGroup = { id: string; companies: { id: string; name: string; can_edit: boolean }[] };

async function fetchGroups(signal: AbortSignal) {
  const { data, error } = await createClient().rpc("super_finance_groups").abortSignal(signal);
  if (error) throw error;
  return (data ?? []) as BooksGroup[];
}

/** Super admin: which companies share one set of books, and which of them may edit. */
export function FinanceMergeTab() {
  const groups = useLiveQuery({ queryKey: "super-finance-groups", fetcher: fetchGroups, tables: ["companies"], pollMs: 0 });
  if (groups.error && !groups.data) return <ErrorState message={groups.error} onRetry={groups.refetch} />;
  if (!groups.data) return <ListSkeleton rows={4} />;
  const merged = groups.data.filter((g) => g.companies.length > 1);
  const all = groups.data.flatMap((g) => g.companies);
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <MergeCard companies={all} onDone={groups.refetch} />
      <div className="space-y-4">
        {merged.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Every company has its own books.</CardContent></Card>
        ) : merged.map((g) => <GroupCard key={g.id} group={g} onDone={groups.refetch} />)}
      </div>
    </div>
  );
}

function MergeCard({ companies, onDone }: { companies: BooksGroup["companies"]; onDone: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [editors, setEditors] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));

  const submit = () => start(async () => {
    const r = await mergeBooks({ companyIds: picked, editorIds: editors.filter((e) => picked.includes(e)) });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success("Books merged");
    setPicked([]); setEditors([]);
    onDone();
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Merge className="size-4" /> Merge books</CardTitle>
        <CardDescription>
          Merged companies share one finance account: their admins and accounts all see every entry, tagged with its company.
          Categories with the same name become one.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="divide-y rounded-lg border">
          {companies.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-3 py-2.5">
              <Checkbox id={`m-${c.id}`} checked={picked.includes(c.id)} onCheckedChange={(v) => setPicked((p) => toggle(p, c.id, v === true))} />
              <Label htmlFor={`m-${c.id}`} className="flex-1 font-normal">{c.name}</Label>
              <Label className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
                <Checkbox disabled={!picked.includes(c.id)} checked={picked.includes(c.id) && editors.includes(c.id)}
                  onCheckedChange={(v) => setEditors((e) => toggle(e, c.id, v === true))} />
                Can edit
              </Label>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Companies that can&apos;t edit see the books but can&apos;t add, change or archive entries. You can always edit.</p>
        <Button onClick={submit} disabled={pending || picked.length < 2 || !editors.some((e) => picked.includes(e))}>
          {pending ? <Loader2 className="animate-spin" /> : <Merge />} Merge {picked.length >= 2 ? `${picked.length} companies` : ""}
        </Button>
      </CardContent>
    </Card>
  );
}

function GroupCard({ group, onDone }: { group: BooksGroup; onDone: () => void }) {
  const [pending, start] = useTransition();
  const setEditor = (id: string, on: boolean) => start(async () => {
    const next = group.companies.filter((c) => (c.id === id ? on : c.can_edit)).map((c) => c.id);
    if (next.length === 0) { toast.error("Keep at least one company that can edit."); return; }
    const r = await setBookEditors({ companyIds: next });
    if (!r.ok) toast.error(r.error);
    onDone();
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><BookOpen className="size-4" /> Shared books</CardTitle>
        <CardDescription>{group.companies.map((c) => c.name).join(" · ")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="divide-y rounded-lg border">
          {group.companies.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="flex-1 text-sm">{c.name}</span>
              <Badge variant="outline" className={c.can_edit ? "border-emerald-400/30 text-emerald-300" : "text-muted-foreground"}>{c.can_edit ? "Can edit" : "View only"}</Badge>
              <Checkbox aria-label={`${c.name} can edit`} checked={c.can_edit} disabled={pending} onCheckedChange={(v) => setEditor(c.id, v === true)} />
              <ConfirmDialog
                trigger={<Button variant="ghost" size="sm"><Split /> Split out</Button>}
                title={`Give ${c.name} its own books?`}
                description="Its entries move with it and it keeps the category list. The others keep sharing their books."
                confirmLabel="Split out"
                onConfirm={async () => {
                  const r = await splitBooks({ companyId: c.id });
                  if (!r.ok) { toast.error(r.error); return false; }
                  toast.success(`${c.name} has its own books again`);
                  onDone();
                }}
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
