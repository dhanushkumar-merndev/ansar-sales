"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { LEAD_TEMPERATURES, TEMPERATURE_LABELS, type LeadTemperature } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { setLeadTemperature } from "@/server/actions/leads";

const NONE = "__none";

const STYLE: Record<LeadTemperature, { pill: string; text: string }> = {
  hot: { pill: "border-red-400/40 bg-red-500/15 text-red-300 hover:border-red-400/60 hover:bg-red-500/20", text: "text-red-300" },
  medium: { pill: "border-orange-400/40 bg-orange-500/15 text-orange-300 hover:border-orange-400/60 hover:bg-orange-500/20", text: "text-orange-300" },
  cold: { pill: "border-zinc-400/30 bg-zinc-400/10 text-zinc-300 hover:border-zinc-400/50 hover:bg-zinc-400/15", text: "text-zinc-300" },
};

function Label({ value }: { value: LeadTemperature }) {
  return <span className={STYLE[value].text}>{TEMPERATURE_LABELS[value]}</span>;
}

/** Read-only pill (archived leads, or anywhere the lead can't be edited). */
export function TemperatureBadge({ value, className }: { value: LeadTemperature | null; className?: string }) {
  if (!value) return <span className={cn("text-sm text-muted-foreground", className)}>—</span>;
  return <Badge variant="outline" className={cn("font-medium", STYLE[value].pill, className)}><Label value={value} /></Badge>;
}

/** Coloured Hot / Medium / Cold dropdown; saves on pick and reconciles with the server. */
export function TemperatureSelect({ leadId, value, onChanged, className }: { leadId: string; value: LeadTemperature | null; onChanged: () => void; className?: string }) {
  const [optimistic, setOptimistic] = useState<LeadTemperature | null | undefined>(undefined);
  const [pending, start] = useTransition();
  const shown = optimistic === undefined ? value : optimistic;
  return (
    <Select
      value={shown ?? NONE}
      disabled={pending}
      onValueChange={(v) => {
        const next = v === NONE ? null : (v as LeadTemperature);
        if (next === value) return;
        setOptimistic(next);
        start(async () => {
          const r = await setLeadTemperature({ id: leadId, temperature: next });
          setOptimistic(undefined); // reconcile with the server value
          if (!r.ok) toast.error(r.error);
          onChanged();
        });
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Lead temperature"
        className={cn("min-w-[8.5rem] rounded-full text-xs font-medium", shown ? STYLE[shown].pill : "border-dashed text-muted-foreground", className)}
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : null}
        {shown ? <Label value={shown} /> : <span>Set temperature</span>}
      </SelectTrigger>
      <SelectContent>
        {LEAD_TEMPERATURES.map((t) => <SelectItem key={t} value={t}><Label value={t} /></SelectItem>)}
        <SelectItem value={NONE} className="text-muted-foreground">Clear</SelectItem>
      </SelectContent>
    </Select>
  );
}
