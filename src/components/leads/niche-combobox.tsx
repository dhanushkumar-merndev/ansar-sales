"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { searchNiches, searchSources } from "@/lib/queries";
import { cleanSearch } from "@/lib/search";
import type { NicheOption } from "@/lib/types";
import { cn } from "@/lib/utils";

export type NicheValue = { id?: string; newName?: string; label: string } | null;

/** The same picker serves niches and lead sources (both: a saved option or a new name, created on save). */
const KINDS = {
  niche: { search: searchNiches, table: "niches", noun: "niche", plural: "niches", any: "Any niche", max: 60, placeholder: "Select niche" },
  source: { search: searchSources, table: "lead_sources", noun: "source", plural: "sources", any: "No source", max: 40, placeholder: "Select source" },
} as const;

/**
 * Searchable niche picker with a "Create" option. A new niche is only persisted
 * when the lead is saved (the server upserts it by normalized name).
 */
export function NicheCombobox({
  value, onChange, initialOptions, allowCreate = true, placeholder, id, invalid, className, kind = "niche", clearable,
}: {
  value: NicheValue; onChange: (v: NicheValue) => void; initialOptions: NicheOption[]; allowCreate?: boolean;
  placeholder?: string; id?: string; invalid?: boolean; className?: string; kind?: keyof typeof KINDS;
  /** Offer an option that clears the choice (always on when creating isn't allowed, i.e. as a filter). */
  clearable?: boolean;
}) {
  const k = KINDS[kind];
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const term = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  const typing = cleanSearch(input) !== term;

  const { data, isFetching, error } = useLiveQuery({
    queryKey: `${k.plural}:${term}`,
    fetcher: (signal) => k.search(term, signal),
    tables: [k.table],
    enabled: open,
    pollMs: 0,
  });
  useEffect(() => {
    if (error) toast.error(error, { id: `${kind}-search-error` });
  }, [error, kind]);

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
            {value ? value.label : placeholder ?? k.placeholder}
            {value?.newName ? <span className="ml-1 text-xs text-muted-foreground">(new)</span> : null}
          </span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={`Search ${k.plural}…`} value={input} onValueChange={setInput} maxLength={k.max} />
          <CommandList>
            {(typing || isFetching) && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Searching…</div>
            )}
            {!typing && !isFetching && options.length === 0 && !showCreate ? <CommandEmpty>No {k.plural} found.</CommandEmpty> : null}
            {exact && (exact.archived_at || exact.merged_into_id) && !options.some((o) => o.id === exact.id) ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">“{exact.name}” is archived. Choose another {k.noun}.</div>
            ) : null}
            <CommandGroup>
              {(!allowCreate || clearable) && value ? (
                <CommandItem value="__clear" onSelect={() => { onChange(null); setOpen(false); }}>
                  <span className="text-muted-foreground">{k.any}</span>
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
