"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, FileSpreadsheet, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLiveQuery } from "@/hooks/use-live-query";
import { formatCount } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/time";
import { purgeAdsClient, restoreAdsClient } from "@/server/actions/ads";

type DeletedClient = {
  id: string; name: string; company_name: string | null; business: string | null; agency_name: string;
  deleted_at: string; deleted_by: string | null; exported_at: string | null;
  /** An Excel export was made since the deletion. */
  can_purge: boolean;
  crm_leads: number; crm_users: number; ad_accounts: number; logins: number;
};

const EXPORT_ERRORS: Record<number, string> = {
  403: "You don't have permission to do that.",
  404: "That client is no longer in the Deleted list.",
  413: "This client has too much data for one file. Ask for help to export it.",
};

/**
 * Super admin: deleted ads clients. Each can be restored, or downloaded as Excel and then removed for
 * good; the permanent delete unlocks only after a download made since the deletion.
 */
export function DeletedClientsView() {
  const list = useLiveQuery({
    queryKey: "deleted-ads-clients",
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("super_deleted_ads_clients").abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as unknown as DeletedClient[];
    },
    pollMs: 0,
  });

  return (
    <>
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2"><Link href="/ads/clients"><ArrowLeft /> All clients</Link></Button>
      <PageHeader
        title="Deleted clients"
        description="Restore a client, or download everything of it as Excel and then delete it for good. The permanent delete removes the client, its ad history, its logins and its client CRM with every lead."
      />
      {list.error && !list.data ? <ErrorState message={list.error} onRetry={list.refetch} />
        : !list.data ? <ListSkeleton rows={4} />
        : !list.data.length ? <EmptyState title="No deleted clients" description="Clients deleted from their page appear here." />
        : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead className="hidden md:table-cell">What it holds</TableHead>
                  <TableHead>Deleted</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.map((c) => <DeletedRow key={c.id} client={c} onChanged={list.refetch} />)}
              </TableBody>
            </Table>
          </Card>
        )}
    </>
  );
}

function DeletedRow({ client: c, onChanged }: { client: DeletedClient; onChanged: () => void }) {
  const [downloading, setDownloading] = useState(false);
  const [restoring, startRestore] = useTransition();
  const name = c.company_name ?? c.name;
  const holds = [
    `${formatCount(c.crm_leads)} CRM ${c.crm_leads === 1 ? "lead" : "leads"}`,
    `${formatCount(c.crm_users + c.logins)} ${c.crm_users + c.logins === 1 ? "login" : "logins"}`,
    `${formatCount(c.ad_accounts)} ad ${c.ad_accounts === 1 ? "account" : "accounts"}`,
  ].join(" · ");

  const download = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`/api/ads-clients/${c.id}/export`, { cache: "no-store" });
      if (!res.ok) { toast.error(EXPORT_ERRORS[res.status] ?? "The download failed. Try again."); return; }
      const file = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "deleted-client.xlsx";
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: file });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success("Downloaded. Keep the file safe: Delete for good is now available.");
    } catch {
      toast.error("The download failed. Check your connection and try again.");
    } finally {
      setDownloading(false);
      onChanged();
    }
  };

  const restore = () => startRestore(async () => {
    const r = await restoreAdsClient({ id: c.id });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(`${name} is back under Clients, closed. Reopen it and turn its logins on from its page.`);
    onChanged();
  });

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{name}</div>
        <div className="text-xs text-muted-foreground">{[c.company_name ? c.name : null, c.business, c.agency_name].filter(Boolean).join(" · ")}</div>
      </TableCell>
      <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{holds}</TableCell>
      <TableCell className="text-sm">
        <div>{formatDateTime(c.deleted_at)}</div>
        <div className="text-xs text-muted-foreground">
          {c.deleted_by ? `by ${c.deleted_by}` : null}
          {c.can_purge && c.exported_at ? <Badge variant="outline" className="ml-1 border-emerald-400/30 text-emerald-300">Exported {formatDateTime(c.exported_at)}</Badge> : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={restore} disabled={restoring}>{restoring ? <Loader2 className="animate-spin" /> : <RotateCcw />} Restore</Button>
          <Button size="sm" variant="outline" onClick={download} disabled={downloading}>
            {downloading ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />} Download Excel
          </Button>
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="destructive" disabled={!c.can_purge} title={c.can_purge ? undefined : "Download the Excel file first"}>
                <Trash2 /> Delete for good
              </Button>
            }
            title={`Delete ${name} for good?`}
            description={<>
              This removes {name}, its ad accounts with all synced history, its logins, and its client CRM with {holds.toLowerCase()}.
              It can&apos;t be undone. Your Excel file from {c.exported_at ? formatDateTime(c.exported_at) : "the download"} is the only copy left.
            </>}
            confirmLabel="Delete for good"
            destructive
            onConfirm={async () => {
              const r = await purgeAdsClient({ id: c.id });
              if (!r.ok) { toast.error(r.error); return false; }
              if (r.data.authFailed) toast.warning(`${name} was deleted, but ${r.data.authFailed} sign-in ${r.data.authFailed === 1 ? "account" : "accounts"} could not be removed from Auth. They can't open anything; remove them in Supabase → Authentication.`);
              else toast.success(`${name} was deleted for good.`);
              onChanged();
            }}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}
