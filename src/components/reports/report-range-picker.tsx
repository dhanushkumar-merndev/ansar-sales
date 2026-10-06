"use client";

import { MAX_RANGE_DAYS, pastPresets, RangePicker, type DayRange } from "@/components/common/range-picker";

export type ReportRange = DayRange;
export { MAX_RANGE_DAYS, pastPresets as presets };

export function ReportRangePicker({ value, onChange }: { value: ReportRange; onChange: (r: ReportRange) => void }) {
  return <RangePicker value={value} onChange={(r) => r && onChange(r)} presets={pastPresets()} ariaLabel="Report date range" />;
}
