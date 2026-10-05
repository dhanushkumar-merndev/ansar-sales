"use client";

import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { searchNiches } from "@/lib/queries";
import { cleanSearch } from "@/lib/search";
import type { NicheOption } from "@/lib/types";
import { cn } from "@/lib/utils";

export type NicheValue = { id?: string; newName?: string; label: string } | null;

/**
 * Searchable niche picker with a "Create" option. A new niche is only persisted
 * when the lead is saved (the server upserts it by normalized name).
 */
export function NicheCombobox({
  value, onChange, initialOptions, allowCreate = true, placeholder = "Select niche", id, invalid, className,
}: {
  value: NicheValue; onChange: (v: NicheValue) => void; initialOptions: NicheOption[]; allowCreate?: boolean;
  placeholder?: string; id?: string; invalid?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const term = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  const typing = cleanSearch(input) !== term;

  const { data, isFetching, error } = useLiveQuery({
    queryKey: `niches:${term}`,
    fetcher: (signal) => searchNiches(term, signal),
    tables: ["niches"],
    enabled: open,
    pollMs: 0,
  });

  const options = useMemo(() => {
    const list = data?.options ?? (term ? [] : initialOptions.slice(0, 20));
    // Keep the current selection visible even if it is outside the latest results.
    if (value?.id && !list.some((o) => o.id === value.id) && !term) return [{ id: value.id, name: value.label }, ...list];
    return list;
  }, [data, term, initialOptions, value]);

  const normalizedInput = cleanSearch(input).toLowerCase();
  const exact = data?.exact && cleanSearch(data.exact.name).toLowerCase() === normalizedInput ? data.exact : null;
  const showCreate = allowCreate && normalizedInput.length > 0 && !typing && !isFetching && data !== undefined && !exact
    && !options.some((o) => o.name.toLowerCase() === normalizedInput);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid}
          className={cn("w-full justify-between font-normal", !value && "text-muted-foreground", className)}
        >
          <span className="truncate">
            {value ? value.label : placeholder}
            {value?.newName ? <span className="ml-1 text-xs text-muted-foreground">(new)</span> : null}
          </span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search niches…" value={input} onValueChange={setInput} maxLength={60} />
          <CommandList>
            {(typing || isFetching) && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Searching…</div>
            )}
            {error ? <div className="px-3 py-2 text-xs text-destructive">{error}</div> : null}
            {!typing && !isFetching && options.length === 0 && !showCreate ? <CommandEmpty>No niches found.</CommandEmpty> : null}
            {exact && (exact.archived_at || exact.merged_into_id) && !options.some((o) => o.id === exact.id) ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">“{exact.name}” is archived. Choose another niche.</div>
            ) : null}
            <CommandGroup>
              {!allowCreate && value ? (
                <CommandItem value="__clear" onSelect={() => { onChange(null); setOpen(false); }}>
                  <span className="text-muted-foreground">Any niche</span>
                </CommandItem>
              ) : null}
              {options.map((o) => (
                <CommandItem key={o.id} value={o.id} onSelect={() => { onChange({ id: o.id, label: o.name }); setOpen(false); setInput(""); }}>
                  <Check className={cn("size-4", value?.id === o.id ? "opacity-100" : "opacity-0")} />
                  {o.name}
                </CommandItem>
              ))}
              {showCreate ? (
                <CommandItem value={`create:${normalizedInput}`} onSelect={() => { onChange({ newName: cleanSearch(input), label: cleanSearch(input) }); setOpen(false); setInput(""); }}>
                  <Plus className="size-4" /> Create “{cleanSearch(input)}”
                </CommandItem>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
