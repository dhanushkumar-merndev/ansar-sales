"use client";

import { Eye, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The strip above the staff preview of the customer's page. */
export function PreviewBar({ who }: { who: string }) {
  return (
    <div className="sticky top-0 z-10 border-b border-amber-400/30 bg-amber-500/15 text-amber-100">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2 text-sm sm:px-6">
        <span className="flex min-w-0 items-center gap-2">
          <Eye className="size-4 shrink-0" aria-hidden />
          <span className="truncate">Preview: this is what {who} will see. Nothing has been sent.</span>
        </span>
        <Button size="sm" variant="ghost" className="shrink-0 text-amber-100 hover:bg-amber-500/20" onClick={() => window.close()}>
          <X /> Close
        </Button>
      </div>
    </div>
  );
}
