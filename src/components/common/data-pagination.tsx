"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PAGE_SIZES } from "@/lib/constants";
import { formatCount } from "@/lib/format";
import { lastPage } from "@/lib/pagination";
import { cn } from "@/lib/utils";

/**
 * Page bar. By default it is pinned to the bottom of the viewport (beside the
 * sidebar) and a spacer keeps the last rows visible. Lists nested inside a card
 * pass `inline` so several bars never stack.
 */
export function DataPagination({
  page, pageSize, total, onPageChange, onPageSizeChange, disabled, inline,
}: {
  page: number; pageSize: number; total: number;
  onPageChange: (page: number) => void; onPageSizeChange?: (size: number) => void; disabled?: boolean; inline?: boolean;
}) {
  const pages = lastPage(total, pageSize);
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const bar = (
    <div
      className={cn(
        "flex flex-col-reverse items-center justify-between gap-3 text-sm sm:flex-row",
        inline
          ? "pt-3"
          : "fixed inset-x-0 bottom-0 z-20 border-t border-white/[0.08] bg-background/95 px-4 py-2.5 backdrop-blur transition-[left] duration-200 ease-linear supports-[backdrop-filter]:bg-background/80 sm:px-6 md:left-(--sidebar-width) lg:px-8 md:group-has-[[data-state=collapsed]]/sidebar-wrapper:left-(--sidebar-width-icon)",
      )}
    >
      <p className="text-muted-foreground">
        {total === 0 ? "No results" : `${formatCount(from)}–${formatCount(to)} of ${formatCount(total)}`}
      </p>
      <div className="flex items-center gap-2">
        {onPageSizeChange ? (
          <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))} disabled={disabled}>
            <SelectTrigger size="sm" className="w-[110px]" aria-label="Rows per page"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((s) => <SelectItem key={s} value={String(s)}>{s} / page</SelectItem>)}
            </SelectContent>
          </Select>
        ) : null}
        <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft />
        </Button>
        <span className="min-w-16 text-center tabular-nums text-muted-foreground">{page} / {pages}</span>
        <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={disabled || page >= pages} onClick={() => onPageChange(page + 1)}>
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
  if (inline) return bar;
  return (
    <>
      <div className="h-24 sm:h-14" aria-hidden />
      {bar}
    </>
  );
}
