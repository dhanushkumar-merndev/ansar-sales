"use client";

import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Small red X at the end of a filter bar: resets search and filters (not the page's tab, view or sort).
 * Also the bar's loading indicator: the X spins while the list refetches, or a plain spinner shows when nothing is filtered.
 */
export function ClearFiltersButton({ show, loading = false, onClear, className }: { show: boolean; loading?: boolean; onClear: () => void; className?: string }) {
  if (!show) {
    return loading ? (
      <span role="status" aria-label="Updating" className={cn("inline-flex size-8 shrink-0 items-center justify-center", className)}>
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </span>
    ) : null;
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClear}
      title="Clear search and filters"
      aria-label={loading ? "Updating. Clear search and filters" : "Clear search and filters"}
      className={cn("size-8 shrink-0 rounded-full border border-red-400/30 bg-red-500/15 text-red-300 hover:bg-red-500/30 hover:text-white", className)}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
    </Button>
  );
}
