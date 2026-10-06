"use client";

import { useState } from "react";
import { CalendarIcon, ChevronDown, X } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { addDays, formatCalendarDate, istToday } from "@/lib/time";
import { cn } from "@/lib/utils";

/** Inclusive IST calendar-day range, as YYYY-MM-DD strings. */
export type DayRange = { from: string; to: string };
export type RangePreset = DayRange & { key: string; label: string };

/** Longest range the list/report RPCs are asked for (about three years). */
export const MAX_RANGE_DAYS = 1100;

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (d: string) => addDays(monthStart(addDays(monthStart(d), 32)), -1);
const quarterStart = (d: string) => `${d.slice(0, 4)}-${String(Math.floor((Number(d.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;

/** Past-looking presets in IST calendar days (reports, lead creation dates). */
export function pastPresets(today = istToday()): RangePreset[] {
  const lastMonthEnd = addDays(monthStart(today), -1);
  const year = Number(today.slice(0, 4));
  return [
    { key: "today", label: "Today", from: today, to: today },
    { key: "7d", label: "Last 7 days", from: addDays(today, -6), to: today },
    { key: "30d", label: "Last 30 days", from: addDays(today, -29), to: today },
    { key: "90d", label: "Last 90 days", from: addDays(today, -89), to: today },
    { key: "month", label: "This month", from: monthStart(today), to: today },
    { key: "last-month", label: "Last month", from: monthStart(lastMonthEnd), to: lastMonthEnd },
    { key: "quarter", label: "This quarter", from: quarterStart(today), to: today },
    { key: "fy", label: "This financial year", from: Number(today.slice(5, 7)) >= 4 ? `${year}-04-01` : `${year - 1}-04-01`, to: today },
    { key: "year", label: "This year", from: `${year}-01-01`, to: today },
    { key: "last-year", label: "Last year", from: `${year - 1}-01-01`, to: `${year - 1}-12-31` },
  ];
}

/** Presets for due dates, which run both ways from today. */
export function duePresets(today = istToday()): RangePreset[] {
  const lastMonthEnd = addDays(monthStart(today), -1);
  return [
    { key: "today", label: "Today", from: today, to: today },
    { key: "tomorrow", label: "Tomorrow", from: addDays(today, 1), to: addDays(today, 1) },
    { key: "next-7d", label: "Next 7 days", from: today, to: addDays(today, 6) },
    { key: "next-30d", label: "Next 30 days", from: today, to: addDays(today, 29) },
    { key: "month", label: "This month", from: monthStart(today), to: monthEnd(today) },
    { key: "7d", label: "Last 7 days", from: addDays(today, -6), to: today },
    { key: "30d", label: "Last 30 days", from: addDays(today, -29), to: today },
    { key: "last-month", label: "Last month", from: monthStart(lastMonthEnd), to: lastMonthEnd },
  ];
}

const toIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromIso = (s: string) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const rangeLabel = (r: DayRange) => (r.from === r.to ? formatCalendarDate(r.from) : `${formatCalendarDate(r.from)} – ${formatCalendarDate(r.to)}`);

/**
 * Preset list + two-month calendar in a popover. Picking a preset or a full
 * range applies it at once; a single day applies with the footer button.
 * `onChange(null)` (only when `placeholder` is set) clears the range.
 */
export function RangePicker({
  value,
  onChange,
  presets,
  placeholder,
  allowFuture = false,
  align = "end",
  className,
  ariaLabel = "Date range",
}: {
  value: DayRange | null;
  onChange: (r: DayRange | null) => void;
  presets: RangePreset[];
  /** Trigger text when no range is set; also enables clearing. */
  placeholder?: string;
  allowFuture?: boolean;
  align?: "start" | "end";
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>();
  const today = istToday();
  const active = value ? presets.find((p) => p.from === value.from && p.to === value.to) : undefined;

  const pick = (r: DayRange | null) => {
    onChange(r);
    setOpen(false);
  };
  const commit = (from: string, to: string) => pick({ from, to: daysBetween(from, to) > MAX_RANGE_DAYS ? addDays(from, MAX_RANGE_DAYS) : to });

  const onSelect = (r: DateRange | undefined) => {
    setDraft(r);
    if (r?.from && r?.to && r.from.getTime() !== r.to.getTime()) commit(toIso(r.from), toIso(r.to));
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setDraft(value ? { from: fromIso(value.from), to: fromIso(value.to) } : undefined); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-9 justify-start text-xs font-normal", className)} aria-label={ariaLabel}>
          <CalendarIcon className="size-3.5 text-muted-foreground" />
          {value ? (
            <>
              {active ? <strong className="font-medium">{active.label}</strong> : null}
              <span className="truncate text-muted-foreground">{rangeLabel(value)}</span>
            </>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronDown className="ml-auto size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto max-w-[calc(100vw-2rem)] overflow-hidden p-0" align={align}>
        <div className="flex flex-col sm:flex-row">
          <div className="flex flex-row gap-1 overflow-x-auto border-b p-2 sm:flex-col sm:border-r sm:border-b-0">
            {presets.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => pick({ from: p.from, to: p.to })}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-left text-xs whitespace-nowrap transition-colors",
                  active?.key === p.key ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="p-2">
            <Calendar
              mode="range"
              numberOfMonths={2}
              defaultMonth={draft?.from ?? fromIso(allowFuture ? today : addDays(today, -31))}
              selected={draft}
              onSelect={onSelect}
              disabled={allowFuture ? undefined : (d) => toIso(d) > today}
            />
            <div className="flex items-center justify-between gap-2 px-3 pb-1">
              <p className="text-xs text-muted-foreground">Pick a start and end day (IST).</p>
              <div className="flex gap-1">
                {draft?.from && draft.to && draft.from.getTime() === draft.to.getTime() ? (
                  <Button size="xs" variant="secondary" onClick={() => commit(toIso(draft.from!), toIso(draft.from!))}>
                    Use {formatCalendarDate(toIso(draft.from))}
                  </Button>
                ) : null}
                {placeholder && value ? (
                  <Button size="xs" variant="ghost" onClick={() => pick(null)}>
                    <X /> Clear
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
