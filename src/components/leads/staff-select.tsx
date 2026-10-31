"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLiveQuery } from "@/hooks/use-live-query";
import { fetchStaff } from "@/lib/queries";

/** Active sales/admin users (bounded list). Admin-only usage; RLS limits profile reads to active staff. */
export function StaffSelect({
  value, onChange, id, placeholder = "Select owner", allowAny, anyLabel = "All owners", className, ariaLabel,
}: {
  value: string | null; onChange: (v: string | null) => void; id?: string; placeholder?: string; allowAny?: boolean;
  /** The text of the "no one picked" option. */
  anyLabel?: string; className?: string; ariaLabel?: string;
}) {
  const { data } = useLiveQuery({ queryKey: "staff", fetcher: fetchStaff, tables: ["profiles"], pollMs: 0 });
  return (
    <Select value={value ?? (allowAny ? "__any" : "")} onValueChange={(v) => onChange(v === "__any" ? null : v)}>
      <SelectTrigger id={id} className={className ?? "w-full"} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allowAny ? <SelectItem value="__any">{anyLabel}</SelectItem> : null}
        {(data ?? []).map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.display_name}{s.role === "admin" ? " (admin)" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
