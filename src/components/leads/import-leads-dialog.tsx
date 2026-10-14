"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { CheckCircle2, Download, FileSpreadsheet, Loader2, TriangleAlert, Upload } from "lucide-react";
import { toast } from "sonner";
import { NicheCombobox, type NicheValue } from "@/components/leads/niche-combobox";
import { StaffSelect } from "@/components/leads/staff-select";
import { useProfile } from "@/components/providers/profile-provider";
import { useStages } from "@/components/providers/stages-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useShowMore } from "@/hooks/use-show-more";
import { formatCount } from "@/lib/format";
import {
  type CheckedRow, checkLeadRows, IMPORT_ROW_ERRORS, leadImportTemplate, MAX_IMPORT_ROWS, type ParsedRow, parseLeadFile, problemRowsWorkbook,
} from "@/lib/lead-import";
import { normalizePhone } from "@/lib/phone";
import { fetchStaff } from "@/lib/queries";
import { createClient } from "@/lib/supabase/client";
import type { NicheOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { importLeads } from "@/server/actions/leads";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function saveFile(data: ArrayBuffer, name: string) {
  const url = URL.createObjectURL(new Blob([data], { type: XLSX }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

type Loaded = { fileName: string; rows: ParsedRow[]; inCrm: Set<string> };
type Done = { imported: number; notImported: { values: ParsedRow["values"]; error: string }[] };

/**
 * Leads from an Excel file, up to 500 at a time: download the template, pick the filled file, see every
 * row checked here in the browser, then import the good ones. The server checks every row again.
 */
export function ImportLeadsDialog({ open, onOpenChange, initialNiches, onImported }: {
  open: boolean; onOpenChange: (o: boolean) => void; initialNiches: NicheOption[]; onImported: () => void;
}) {
  const me = useProfile();
  const isAdmin = me.role === "admin";
  const { stages } = useStages();
  const staff = useLiveQuery({ queryKey: "staff", fetcher: fetchStaff, tables: ["profiles"], enabled: open && isAdmin, pollMs: 0 });
  const [niche, setNiche] = useState<NicheValue>(null);
  const [ownerId, setOwnerId] = useState<string | null>(me.id);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [importing, startImport] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const checked = useMemo<CheckedRow[]>(() => loaded ? checkLeadRows(loaded.rows, {
    defaultNiche: niche ? (niche.id ? { id: niche.id } : { newName: niche.newName }) : null,
    stages,
    owners: isAdmin ? (staff.data ?? []).filter((s) => s.role === "admin" || s.role === "sales") : null,
    defaultOwnerId: ownerId ?? me.id,
    inCrm: loaded.inCrm,
  }) : [], [loaded, niche, stages, isAdmin, staff.data, ownerId, me.id]);

  const problems = checked.filter((r) => r.errors.length);
  const duplicates = checked.filter((r) => !r.errors.length && r.inCrm);
  const ready = checked.filter((r) => r.lead && (!r.inCrm || allowDuplicates));
  const shown = problemsOnly ? checked.filter((r) => r.errors.length || r.inCrm) : checked;
  const paging = useShowMore(shown.length, `${loaded?.fileName}:${problemsOnly}`);

  const reset = () => {
    setLoaded(null); setFileError(null); setAllowDuplicates(false); setProblemsOnly(false); setDone(null);
    if (inputRef.current) inputRef.current.value = "";
  };
  const close = (o: boolean) => {
    if (importing) return;
    onOpenChange(o);
    if (!o) reset();
  };

  const downloadTemplate = async () => {
    try {
      saveFile(await leadImportTemplate({ stages: stages.map((s) => s.name), admin: isAdmin }), "leads-import-template.xlsx");
    } catch {
      toast.error("Couldn't make the template. Try again.");
    }
  };

  const readFile = async (file: File) => {
    setFileError(null);
    if (!/\.xlsx$/i.test(file.name)) { setFileError("Choose an Excel .xlsx file (in Excel: File → Save as → Excel Workbook)."); return; }
    if (file.size > MAX_FILE_BYTES) { setFileError("That file is larger than 5 MB. Keep only the lead columns and rows."); return; }
    setReading(true);
    try {
      const parsed = await parseLeadFile(await file.arrayBuffer());
      if (parsed.missingColumns.length) {
        setFileError(`The first row needs the column headings ${parsed.missingColumns.map((c) => (c === "name" ? "Name" : "Phone")).join(" and ")}. Start from the template.`);
        return;
      }
      if (parsed.tooMany) { setFileError(`The file has more than ${MAX_IMPORT_ROWS} leads. Split it into files of ${MAX_IMPORT_ROWS} or fewer.`); return; }
      if (!parsed.rows.length) { setFileError("The file has no leads under the heading row."); return; }
      const phones = [...new Set(parsed.rows.map((r) => (r.values.phone ? normalizePhone(r.values.phone)?.e164 : null)).filter((p): p is string => Boolean(p)))];
      const { data, error } = await createClient().rpc("lead_phones_in_crm", { p_phones: phones });
      if (error) throw error;
      setLoaded({ fileName: file.name, rows: parsed.rows, inCrm: new Set(data ?? []) });
    } catch {
      setFileError("Couldn't read that file. Open it in Excel, save it as .xlsx and try again.");
    } finally {
      setReading(false);
    }
  };

  const runImport = () => startImport(async () => {
    const sending = ready;
    const r = await importLeads({ rows: sending.map((x) => x.lead!), allowDuplicates });
    if (!r.ok) { toast.error(r.error); return; }
    const failed = new Map(r.data.filter((x) => x.error).map((x) => [x.index, IMPORT_ROW_ERRORS[x.error!] ?? "Couldn't be imported"]));
    const notImported = [
      ...problems.map((x) => ({ values: x.values, error: x.errors.join("; ") })),
      ...(allowDuplicates ? [] : duplicates.map((x) => ({ values: x.values, error: "Already in the CRM (skipped)" }))),
      ...sending.flatMap((x, i) => (failed.has(i) ? [{ values: x.values, error: failed.get(i)! }] : [])),
    ];
    setDone({ imported: sending.length - failed.size, notImported });
    onImported();
  });

  const downloadNotImported = async (rows: { values: ParsedRow["values"]; error: string }[]) => {
    try {
      saveFile(await problemRowsWorkbook(rows, isAdmin), "leads-not-imported.xlsx");
    } catch {
      toast.error("Couldn't make the file. Try again.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[90svh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import leads from Excel</DialogTitle>
          <DialogDescription>
            Up to {MAX_IMPORT_ROWS} leads per file. Every row is checked here before anything is saved; only the good rows are imported.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="space-y-4 py-2">
            <p className="flex items-center gap-2 text-base font-medium">
              <CheckCircle2 className="size-5 text-emerald-400" /> Imported {formatCount(done.imported)} {done.imported === 1 ? "lead" : "leads"}
            </p>
            {done.notImported.length ? (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
                <span className="flex-1">{formatCount(done.notImported.length)} {done.notImported.length === 1 ? "row was" : "rows were"} not imported. Download them with the reason, fix them and import again.</span>
                <Button variant="outline" size="sm" onClick={() => void downloadNotImported(done.notImported)}><Download /> Rows not imported</Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1" onScroll={loaded ? paging.onScroll : undefined}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="import-niche">Niche for rows without one</FieldLabel>
                <NicheCombobox id="import-niche" value={niche} onChange={setNiche} initialOptions={initialNiches} />
              </Field>
              {isAdmin ? (
                <Field>
                  <FieldLabel htmlFor="import-owner">Owner for rows without one</FieldLabel>
                  <StaffSelect id="import-owner" value={ownerId} onChange={setOwnerId} />
                </Field>
              ) : null}
            </div>

            {!loaded ? (
              <>
                <div
                  className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-6 text-center"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void readFile(f); }}
                >
                  <FileSpreadsheet className="size-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Drop the filled template here, or</p>
                  <Button onClick={() => inputRef.current?.click()} disabled={reading}>
                    {reading ? <Loader2 className="animate-spin" /> : <Upload />} Choose Excel file
                  </Button>
                  <input ref={inputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); }} />
                  {fileError ? <p className="flex items-start gap-1.5 text-sm text-red-300"><TriangleAlert className="mt-0.5 size-4 shrink-0" /> {fileError}</p> : null}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                  <span className="text-muted-foreground">
                    Columns: Name and Phone are required; Email, Company, Niche, Stage{isAdmin ? ", Owner" : ""} and Note are optional.
                  </span>
                  <Button variant="outline" size="sm" onClick={() => void downloadTemplate()}><Download /> Download template</Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="mr-1 font-medium">{loaded.fileName}</span>
                  <Badge variant="outline" className="border-emerald-400/30 text-emerald-300">{formatCount(checked.length - problems.length - duplicates.length)} ready</Badge>
                  {problems.length ? <Badge variant="outline" className="border-red-400/30 text-red-300">{formatCount(problems.length)} with problems</Badge> : null}
                  {duplicates.length ? <Badge variant="outline" className="border-amber-400/30 text-amber-300">{formatCount(duplicates.length)} already in the CRM</Badge> : null}
                  <Button variant="link" size="sm" className="ml-auto px-0" onClick={reset}>Choose another file</Button>
                </div>
                {problems.length || duplicates.length ? (
                  <Label className="flex items-center gap-2 font-normal">
                    <Checkbox checked={problemsOnly} onCheckedChange={(v) => setProblemsOnly(v === true)} /> Show only rows that need attention
                  </Label>
                ) : null}
                <ul className="divide-y rounded-lg border">
                  {shown.slice(0, paging.count).map((r) => (
                    <li key={r.row} className="flex gap-3 px-3 py-2 text-sm">
                      <span className="w-10 shrink-0 text-xs text-muted-foreground tabular-nums">#{r.row}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate"><span className="font-medium">{r.values.name || "—"}</span> <span className="text-muted-foreground">· {r.values.phone || "no phone"}</span></div>
                        {r.errors.length ? <p className="text-xs text-red-300">{r.errors.join(" · ")}</p>
                          : r.inCrm ? <p className="text-xs text-amber-300">This phone is already a lead{allowDuplicates ? ": imported anyway" : ": skipped"}</p> : null}
                      </div>
                      <span className={cn("shrink-0 text-xs", r.errors.length ? "text-red-300" : r.inCrm && !allowDuplicates ? "text-amber-300" : "text-emerald-300")}>
                        {r.errors.length ? "Problem" : r.inCrm && !allowDuplicates ? "Skip" : "Ready"}
                      </span>
                    </li>
                  ))}
                </ul>
                {paging.more ? <p className="text-center text-xs text-muted-foreground">Scroll for {formatCount(paging.more)} more</p> : null}
              </>
            )}
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          {done ? (
            <Button className="sm:ml-auto" onClick={() => close(false)}>Done</Button>
          ) : loaded ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                {duplicates.length ? (
                  <Label className="flex items-center gap-2 font-normal">
                    <Checkbox checked={allowDuplicates} onCheckedChange={(v) => setAllowDuplicates(v === true)} />
                    Import the {formatCount(duplicates.length)} already in the CRM anyway
                  </Label>
                ) : null}
                {problems.length ? (
                  <Button variant="ghost" size="sm" onClick={() => void downloadNotImported(problems.map((x) => ({ values: x.values, error: x.errors.join("; ") })))}>
                    <Download /> Rows with problems
                  </Button>
                ) : null}
              </div>
              <Button onClick={runImport} disabled={importing || !ready.length}>
                {importing ? <Loader2 className="animate-spin" /> : <Upload />} Import {formatCount(ready.length)} {ready.length === 1 ? "lead" : "leads"}
              </Button>
            </>
          ) : (
            <Button variant="outline" className="sm:ml-auto" onClick={() => close(false)}>Cancel</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
