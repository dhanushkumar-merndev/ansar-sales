"use client";

import { useState } from "react";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatCalendarDate } from "@/lib/time";
import { cn } from "@/lib/utils";

export type IstDateTime = { date: string; time: string };

const pad = (n: number) => String(n).padStart(2, "0");
// The calendar's Date is only used for its Y/M/D; the chosen day is interpreted in IST.
const toYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromYmd = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** Date + time picker whose value is an IST wall-clock time. */
export function DateField({ value, onChange, id, invalid }: { value: string; onChange: (v: string) => void; id?: string; invalid?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" aria-invalid={invalid} className={cn("w-full justify-start font-normal", !value && "text-muted-foreground")}>
          <CalendarIcon className="size-4" />
          {value ? formatCalendarDate(value) : "Pick a date"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value ? fromYmd(value) : undefined}
          defaultMonth={value ? fromYmd(value) : undefined}
          onSelect={(d) => {
            if (d) onChange(toYmd(d));
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function DateTimeField({ value, onChange, idPrefix, invalid }: { value: IstDateTime; onChange: (v: IstDateTime) => void; idPrefix: string; invalid?: boolean }) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-2">
      <DateField id={`${idPrefix}-date`} value={value.date} onChange={(date) => onChange({ ...value, date })} invalid={invalid} />
      <Input
        id={`${idPrefix}-time`}
        type="time"
        aria-label="Time (IST)"
        className="w-[120px]"
        value={value.time}
        aria-invalid={invalid}
        onChange={(e) => onChange({ ...value, time: e.target.value })}
      />
    </div>
  );
}
