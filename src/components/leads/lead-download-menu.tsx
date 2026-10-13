"use client";

import { useState } from "react";
import { ChevronDown, Download, FileSpreadsheet, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLiveQuery } from "@/hooks/use-live-query";
import { formatCount } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";

/**
 * Admin: download the company's active leads as an Excel file, either all of them or only the ones
 * this admin hasn't downloaded yet. Ignores the list's filters, so "new" always means "since my last
 * download".
 */
export function LeadDownloadMenu() {
  const me = useProfile();
  const [busy, setBusy] = useState(false);
  const pending = useLiveQuery({
    queryKey: `lead-export-pending:${me.id}:${me.company.id}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("lead_export_pending").abortSignal(signal);
      if (error) throw error;
      return data;
    },
    tables: ["leads"],
  });
  const fresh = pending.data ?? null;

  const download = async (onlyNew: boolean) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/export${onlyNew ? "?only=new" : ""}`, { cache: "no-store" });
      if (res.status === 204) {
        toast.info(onlyNew ? "No new leads since your last download." : "There are no leads to download.");
        return;
      }
      if (!res.ok) {
        toast.error(res.status === 403 ? "You don't have permission to do that." : "The download failed. Try again.");
        return;
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "leads.xlsx";
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      const count = Number(res.headers.get("X-Lead-Count") ?? 0);
      toast.success(`Downloaded ${formatCount(count)} lead${count === 1 ? "" : "s"}.`, {
        description: res.headers.get("X-More-Leads") === "1" ? "That's the most one file holds. Download new again for the rest." : undefined,
      });
    } catch {
      toast.error("The download failed. Check your connection and try again.");
    } finally {
      setBusy(false);
      pending.refetch();
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />} Download
          {fresh ? <span className="rounded-full bg-primary/15 px-1.5 text-xs font-medium tabular-nums text-primary">{fresh > 999 ? "999+" : fresh}</span> : null}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Excel file of every active lead (filters not applied)</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void download(false)}>
          <FileSpreadsheet /> All leads
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void download(true)} disabled={fresh === 0}>
          <Sparkles /> New since my last download
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">{fresh === null ? "…" : formatCount(fresh)}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
