"use client";

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { BrandMark, BrandName } from "@/components/app/brand";
import { useProfile } from "@/components/providers/profile-provider";
import type { ReportRange } from "@/components/reports/report-range-picker";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { switchCompany } from "@/server/actions/companies";

/**
 * Super admin: choose which company to present. The current company opens at once; another one is
 * switched to first (like the sidebar switcher, with a full load so every query and Realtime channel
 * belongs to it) and the deck opens there automatically.
 */
export function PresentCompanyDialog({ open, onOpenChange, range, onPresent }: {
  open: boolean; onOpenChange: (open: boolean) => void; range: ReportRange; onPresent: () => void;
}) {
  const profile = useProfile();
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const choose = (id: string) => {
    if (pending) return;
    if (id === profile.company.id) {
      onOpenChange(false);
      onPresent();
      return;
    }
    setPicked(id);
    startTransition(async () => {
      const res = await switchCompany({ id });
      if (!res.ok) {
        toast.error(res.error);
        setPicked(null);
        return;
      }
      const qs = new URLSearchParams({ present: "1", from: range.from, to: range.to });
      // A full load: every query, cache and Realtime channel then belongs to the chosen company.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/reports?${qs}`);
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Present a company</DialogTitle>
          <DialogDescription>Choose the company for the slideshow. Another company opens with its own data.</DialogDescription>
        </DialogHeader>
        <ul className="-mx-1 max-h-80 space-y-1 overflow-y-auto">
          {profile.companies.map((c) => {
            const current = c.id === profile.company.id;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => choose(c.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06] focus-visible:border-ring focus-visible:outline-none disabled:opacity-60",
                    current && "border-white/10 bg-white/[0.04]",
                  )}
                >
                  <BrandMark size={28} logoUrl={c.logoUrl} />
                  <BrandName name={c.name} highlight={c.brandHighlight} className="flex-1 truncate text-sm font-medium" />
                  {picked === c.id ? <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    : current ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5" /> Current</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
