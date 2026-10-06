"use client";

import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLiveQuery } from "@/hooks/use-live-query";
import { cleanSearch } from "@/lib/search";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export type BooksCompany = { id: string; name: string; can_edit: boolean };
export type ExpenseCategoryOption = { id: string; name: string; archived_at: string | null };
export type FinanceBooks = {
  /** This user may add and change entries (their company edits these books). */
  canEdit: boolean;
  currentCompanyId: string;
  /** Every company whose entries are in these books (more than one when merged). */
  companies: BooksCompany[];
  merged: boolean;
  categories: ExpenseCategoryOption[];
};

async function fetchBooks(signal: AbortSignal): Promise<FinanceBooks> {
  const sb = createClient();
  const [ctx, cats] = await Promise.all([
    sb.rpc("finance_context").abortSignal(signal),
    sb.from("expense_categories").select("id, name, archived_at").order("normalized_name").limit(200).abortSignal(signal),
  ]);
  if (ctx.error) throw ctx.error;
  if (cats.error) throw cats.error;
  const c = ctx.data as { can_edit: boolean; current_company_id: string; companies: BooksCompany[] } | null;
  const companies = c?.companies ?? [];
  return {
    canEdit: Boolean(c?.can_edit), currentCompanyId: c?.current_company_id ?? "", companies,
    merged: companies.length > 1, categories: cats.data,
  };
}

/** The signed-in user's books: merged companies, edit rights and expense categories. Live. */
export function useFinanceBooks() {
  const { company } = useProfile();
  return useLiveQuery({ queryKey: `finance-books:${company.id}`, fetcher: fetchBooks, tables: ["expense_categories", "companies"], pollMs: 0 });
}

export type CategoryValue = { id?: string; newName?: string; label: string } | null;

/** Pick a category of these books, or type a new one (created when the expense is saved). */
export function CategoryCombobox({ value, onChange, categories, allowCreate, id, invalid }: {
  value: CategoryValue; onChange: (v: CategoryValue) => void; categories: ExpenseCategoryOption[]; allowCreate: boolean;
  id?: string; invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const term = cleanSearch(input).toLowerCase();
  const active = useMemo(() => categories.filter((c) => !c.archived_at), [categories]);
  const options = term ? active.filter((c) => c.name.toLowerCase().includes(term)) : active;
  const exact = categories.find((c) => c.name.toLowerCase() === term);
  const showCreate = allowCreate && term.length > 0 && !exact;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} aria-invalid={invalid}
          className={cn("w-full justify-between font-normal", !value && "text-muted-foreground")}>
          <span className="truncate">
            {value ? value.label : "Choose category"}
            {value?.newName ? <span className="ml-1 text-xs text-muted-foreground">(new)</span> : null}
          </span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-56 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={allowCreate ? "Search or add…" : "Search…"} value={input} onValueChange={setInput} maxLength={40} />
          <CommandList>
            {options.length === 0 && !showCreate ? <CommandEmpty>No categories found.</CommandEmpty> : null}
            {exact?.archived_at ? <div className="px-3 py-2 text-xs text-muted-foreground">“{exact.name}” is archived. Typing it again brings it back.</div> : null}
            <CommandGroup>
              {options.map((c) => (
                <CommandItem key={c.id} value={c.id} onSelect={() => { onChange({ id: c.id, label: c.name }); setOpen(false); setInput(""); }}>
                  <Check className={cn("size-4", value?.id === c.id ? "opacity-100" : "opacity-0")} />
                  {c.name}
                </CommandItem>
              ))}
              {showCreate || (allowCreate && exact?.archived_at) ? (
                <CommandItem value={`create:${term}`} onSelect={() => { const name = cleanSearch(input); onChange({ newName: name, label: name }); setOpen(false); setInput(""); }}>
                  <Plus className="size-4" /> {exact?.archived_at ? "Restore" : "Add"} “{cleanSearch(input)}”
                </CommandItem>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Which company of merged books an entry is for. */
export function CompanySelect({ id, value, onChange, companies }: { id?: string; value: string; onChange: (v: string) => void; companies: BooksCompany[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full"><SelectValue placeholder="Company" /></SelectTrigger>
      <SelectContent>{companies.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
    </Select>
  );
}

/** Small company tag on entries of merged books. */
export function CompanyTag({ name }: { name: string | null | undefined }) {
  if (!name) return null;
  return <Badge variant="outline" className="border-white/10 bg-white/5 px-1.5 py-0 text-[11px] font-normal text-muted-foreground">{name}</Badge>;
}
