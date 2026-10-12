"use client";

import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { STAGE_COLORS, STAGE_HEX, type StageColor } from "@/lib/stages";
import { cn } from "@/lib/utils";

/** Plain names for the shared palette. */
export const COLOR_NAMES: Record<StageColor, string> = {
  slate: "Grey", blue: "Blue", sky: "Sky", violet: "Violet", amber: "Amber", orange: "Orange", pink: "Pink", emerald: "Green", red: "Red",
};

/** A small swatch button that opens the shared colour palette. */
export function ColorSwatchPicker({ value, onChange, label = "Colour", disabled, id }: {
  value: StageColor; onChange: (c: StageColor) => void; label?: string; disabled?: boolean; id?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" size="sm" disabled={disabled} aria-label={`${label}: ${COLOR_NAMES[value]}`} className="gap-2">
          <span className="size-3.5 rounded-full" style={{ background: STAGE_HEX[value] }} />
          {COLOR_NAMES[value]}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <div className="grid grid-cols-5 gap-1.5" role="listbox" aria-label={label}>
          {STAGE_COLORS.map((c) => (
            <button key={c} type="button" role="option" aria-selected={c === value} title={COLOR_NAMES[c]} onClick={() => onChange(c)}
              className={cn("flex size-8 items-center justify-center rounded-md border border-transparent hover:border-border focus-visible:outline-2 focus-visible:outline-ring", c === value && "border-foreground/40")}>
              <span className="flex size-5 items-center justify-center rounded-full" style={{ background: STAGE_HEX[c] }}>
                {c === value ? <Check className="size-3 text-black/70" /> : null}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
