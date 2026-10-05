"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PAGE_SIZES } from "@/lib/constants";
import { formatCount } from "@/lib/format";
import { lastPage } from "@/lib/pagination";

export function DataPagination({
  page, pageSize, total, onPageChange, onPageSizeChange, disabled,
}: {
  page: number; pageSize: number; total: number;
  onPageChange: (page: number) => void; onPageSizeChange?: (size: number) => void; disabled?: boolean;
}) {
  const pages = lastPage(total, pageSize);
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex flex-col-reverse items-center justify-between gap-3 pt-3 text-sm sm:flex-row">
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
}
