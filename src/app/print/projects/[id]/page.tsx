import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PrintButton } from "@/app/print/projects/[id]/print-button";
import { requireFeature } from "@/lib/auth";
import { readPhaseHistory } from "@/lib/phase-history";
import { daysBetween, PHASE_STATUS_LABELS, type ProjectDetail } from "@/lib/projects";
import { createClient } from "@/lib/supabase/server";
import { formatCalendarDate, formatDateTime, istToday } from "@/lib/time";

export const metadata: Metadata = { title: "Project timeline" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A clean printable timeline in the office's sheet layout (S.No · Description · Stage · dates · Status with history · Remark). */
export default async function PrintProjectPage({ params }: PageProps<"/print/projects/[id]">) {
  const profile = await requireFeature("projects", ["admin", "architect_manager", "landscape_designer", "execution", "account"]);
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("project_detail", { p_project_id: id });
  if (error || !data) notFound();
  const { project: p, phases } = data as unknown as ProjectDetail;
  const history = await readPhaseHistory(supabase, id).catch(() => []);
  const historyOf = (phaseId: string) => history.filter((e) => e.phase_id === phaseId);
  const extendedBy = p.original_end_date && p.original_end_date !== p.end_date ? daysBetween(p.original_end_date, p.end_date) : 0;
  const spans = phases.map((ph, i) => {
    if (i > 0 && phases[i - 1].category === ph.category) return 0;
    let n = 1;
    while (i + n < phases.length && phases[i + n].category === ph.category) n++;
    return n;
  });
  const cell = "border border-black px-2 py-1.5 align-middle";
  return (
    <main className="min-h-screen bg-white p-6 text-black print:p-0" style={{ colorScheme: "light" }}>
      <div className="mx-auto max-w-5xl">
        <div className="mb-4 flex items-center justify-between print:hidden">
          <p className="text-sm text-neutral-600">Print or save as PDF. Printed by {profile.display_name} on {formatCalendarDate(istToday())}.</p>
          <PrintButton />
        </div>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr><th colSpan={8} className={`${cell} py-3 text-center text-lg font-normal`}>{p.name} — Project timeline</th></tr>
            <tr className="bg-yellow-300 text-left">
              <th className={`${cell} w-12 font-normal`}>S.NO</th>
              <th className={`${cell} font-normal`}>Description</th>
              <th className={`${cell} w-32 font-normal`}>Stage</th>
              <th className={`${cell} w-24 font-normal`}>Start</th>
              <th className={`${cell} w-24 font-normal`}>Deadline</th>
              <th className={`${cell} w-24 font-normal`}>Submitted</th>
              <th className={`${cell} w-56 font-normal`}>Status</th>
              <th className={`${cell} w-36 font-normal`}>Remark</th>
            </tr>
          </thead>
          <tbody>
            {phases.map((ph, i) => (
              <tr key={ph.id} className="break-inside-avoid">
                <td className={`${cell} text-center`}>{i + 1}</td>
                <td className={cell}>
                  <div>{ph.name}</div>
                  {ph.items.length ? <ol className="mt-0.5 text-[11px] leading-snug">{ph.items.map((it, n) => <li key={it.id}>{n + 1}. {it.title}{it.done_at ? " ✓" : ""}</li>)}</ol> : null}
                  {ph.owner ? <div className="mt-0.5 text-[11px] text-neutral-600">Owner: {ph.owner.display_name}</div> : null}
                </td>
                {spans[i] ? <td rowSpan={spans[i]} className={`${cell} text-center text-[12px]`}>{ph.category}</td> : null}
                <td className={`${cell} text-[12px] tabular-nums`}>{formatCalendarDate(ph.planned_start)}</td>
                <td className={`${cell} text-[12px] tabular-nums`}>{formatCalendarDate(ph.deadline)}</td>
                <td className={`${cell} text-[12px] tabular-nums`}>{ph.submitted_on ? formatCalendarDate(ph.submitted_on) : ""}</td>
                <td className={`${cell} text-[12px] align-top`}>
                  <div className="font-medium">{PHASE_STATUS_LABELS[ph.status]}{ph.late_days > 0 ? ` · ${ph.overdue ? `${ph.late_days}d late` : `submitted ${ph.late_days}d late`}` : ""}</div>
                  {historyOf(ph.id).length ? (
                    <ol className="mt-0.5 space-y-px text-[10.5px] leading-snug text-neutral-700">
                      {historyOf(ph.id).map((e, n) => (
                        <li key={n}>{PHASE_STATUS_LABELS[e.to]} · {formatDateTime(e.at)}{e.by ? ` · ${e.by}` : ""}</li>
                      ))}
                    </ol>
                  ) : null}
                </td>
                <td className={`${cell} text-[12px]`}>{ph.remark ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-[11px] text-neutral-600">
          {p.code} · {p.client_name} · {formatCalendarDate(p.start_date)} – {formatCalendarDate(p.end_date)}
          {extendedBy ? ` · ${extendedBy > 0 ? `extended by ${extendedBy} days` : `brought forward by ${-extendedBy} days`} (planned end ${formatCalendarDate(p.original_end_date!)})` : ""}
        </p>
      </div>
    </main>
  );
}
