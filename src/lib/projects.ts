import type { Enums } from "@/lib/database.types";
import { formatINR } from "@/lib/format";
import { STAGE_COLORS, type StageColor } from "@/lib/stages";
import { addDays } from "@/lib/time";

export type ProjectStatus = Enums<"project_status">;
export type PhaseStatus = Enums<"phase_status">;
export type ProjectMemberRole = Enums<"project_member_role">;

export const PROJECT_STATUSES: ProjectStatus[] = ["active", "on_hold", "completed", "cancelled"];
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "Active", on_hold: "On hold", completed: "Completed", cancelled: "Cancelled",
};

export const PHASE_STATUSES: PhaseStatus[] = ["not_started", "in_progress", "in_review", "changes_requested", "done", "skipped"];
export const PHASE_STATUS_LABELS: Record<PhaseStatus, string> = {
  not_started: "Not started", in_progress: "In progress", in_review: "In review",
  changes_requested: "Changes requested", done: "Done", skipped: "Skipped",
};
/** Statuses a phase owner can set themselves; done, skipped and changes requested are the manager's call. */
export const OWNER_PHASE_STATUSES: PhaseStatus[] = ["not_started", "in_progress", "in_review"];
/** The statuses this person may pick for a phase now (the current one always stays visible). */
export const phaseStatusChoices = (manage: boolean, current: PhaseStatus): PhaseStatus[] =>
  manage ? PHASE_STATUSES : isPhaseFinished(current) ? [current] : PHASE_STATUSES.filter((s) => OWNER_PHASE_STATUSES.includes(s) || s === current);

/** One status change of a phase (who and when), for the Gantt's status track. */
export type PhaseEvent = { phase_id: string; at: string; from: PhaseStatus | null; to: PhaseStatus; by: string | null };

/** Finished phases never count as late. "In review" waits on someone else, so it is not late either. */
export const isPhaseFinished = (s: PhaseStatus) => s === "done" || s === "skipped";

export const MEMBER_ROLE_LABELS: Record<ProjectMemberRole, string> = {
  architect_manager: "Architect manager", landscape_designer: "Landscape designer", execution: "Execution manager", client: "Client",
};

/** Colours a user may pick for a project or phase (shared with pipeline stages). */
export const PROJECT_COLORS = STAGE_COLORS;
export type ProjectColor = StageColor;

export type ProjectMember = { id: string; display_name: string; role: ProjectMemberRole; added_at?: string };

export type PhaseItem = { id: string; title: string; position: number; done_at: string | null; done_by: string | null };

export type Phase = {
  id: string;
  position: number;
  category: string;
  name: string;
  color: ProjectColor;
  owner: { id: string; display_name: string } | null;
  planned_start: string;
  deadline: string;
  actual_start: string | null;
  submitted_on: string | null;
  status: PhaseStatus;
  needs_client_approval: boolean;
  /** Tiptap document. */
  notes: Record<string, unknown> | null;
  remark: string | null;
  version: number;
  updated_at: string;
  /** Days past the deadline: submission day for submitted phases, today for open ones. */
  late_days: number;
  overdue: boolean;
  items: PhaseItem[];
};

export type ProjectListItem = {
  id: string;
  code: string;
  name: string;
  client_name: string;
  client_phone: string | null;
  status: ProjectStatus;
  color: ProjectColor;
  start_date: string;
  end_date: string;
  lead_id: string | null;
  site_address: string | null;
  updated_at: string;
  phases_total: number;
  phases_done: number;
  late_phases: number;
  max_late_days: number;
  current_phase: { id: string; name: string; category: string; status: PhaseStatus; deadline: string; color: ProjectColor } | null;
  team: ProjectMember[];
};

export type ProjectDetail = {
  project: {
    id: string; code: string; name: string; client_name: string; client_phone: string | null; client_email: string | null;
    site_address: string | null; site_lat: number | null; site_lng: number | null;
    start_date: string; end_date: string;
    /** The end date the project was created with; differs from end_date once it is extended or brought forward. */
    original_end_date?: string;
    completed_on: string | null; status: ProjectStatus; color: ProjectColor;
    storage_quota_bytes: number; version: number; created_at: string; updated_at: string; archived_at: string | null; created_by: string | null;
  };
  financials: { area_sqft: number | null; rate_per_sqft: number | null; contract_value: number | null } | null;
  lead: { id: string; name: string; owner: string; handoff_note: string | null } | null;
  members: ProjectMember[];
  phases: Phase[];
  can: { manage: boolean; money: boolean; admin: boolean };
};

export type ProjectActivity = {
  id: string; type: string; body: string | null; meta: Record<string, unknown>; phase_id: string | null; created_at: string;
  actor: { display_name: string } | null;
};

export type HandoffLead = {
  id: string; name: string; phone: string; email: string | null; handoff_at: string; handoff_note: string | null;
  owner: { id: string; display_name: string }; handed_by: string | null; stage: string | null;
};

// ---------------------------------------------------------------------------
// Default Star Gardens timeline (from their process: R0 → layout & deck → BOQ R2 → GFC + BOQ R3
// → kick-off → execution → BOQ R4 → handover). Weights share the project's days; edit freely later.
// ---------------------------------------------------------------------------
type TemplatePhase = { category: string; name: string; color: ProjectColor; weight: number; items?: string[]; needsClientApproval?: boolean };

export const STAR_GARDENS_TEMPLATE: TemplatePhase[] = [
  { category: "Design", name: "First cut design & estimation — R0", color: "sky", weight: 6 },
  { category: "Design", name: "Design development: layout + deck", color: "sky", weight: 14, items: ["Detailed layout", "Updated pitch / design deck"], needsClientApproval: true },
  { category: "Design", name: "BOQ — R2", color: "violet", weight: 7, items: ["Detailed BOQ from approved layout"], needsClientApproval: true },
  {
    category: "GFC drawings", name: "GFC drawings", color: "blue", weight: 15, needsClientApproval: true,
    items: ["Master plan", "Grading plan", "Drainage plan", "Lighting plan", "Setting out plan", "Planting plan"],
  },
  { category: "GFC drawings", name: "BOQ — R3 (hardscape + softscape)", color: "violet", weight: 5, needsClientApproval: true },
  { category: "Execution", name: "Kick-off meeting at site", color: "amber", weight: 2, items: ["Confirm drawings, materials and quantities", "Brief the execution team"] },
  { category: "Execution", name: "Execution", color: "orange", weight: 40 },
  { category: "Execution", name: "BOQ — R4 (final)", color: "violet", weight: 4, items: ["Approved changes during execution"], needsClientApproval: true },
  { category: "Finish", name: "Handover & completion report", color: "emerald", weight: 7, items: ["Final site inspection", "Rectify snags", "Completion report", "Handover to client"] },
];

export type PhaseDraft = {
  category: string; name: string; color: ProjectColor; planned_start: string; deadline: string;
  needs_client_approval: boolean; items: string[]; owner_id?: string | null;
};

/** Whole days from a to b (YYYY-MM-DD), b - a. */
export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Lays the template out back to back between start and end (inclusive). Every phase gets at
 * least one day; the last phase always ends on the project end date.
 */
export function spreadTemplate(start: string, end: string, template: TemplatePhase[] = STAR_GARDENS_TEMPLATE): PhaseDraft[] {
  const total = Math.max(daysBetween(start, end) + 1, 1);
  const weight = template.reduce((s, p) => s + p.weight, 0);
  let cursor = 0;
  return template.map((p, i) => {
    const remaining = template.length - i - 1;
    const share = Math.max(1, Math.round((p.weight / weight) * total));
    const last = i === template.length - 1;
    // Leave at least one day for each remaining phase when the project is short.
    const len = last ? Math.max(total - cursor, 1) : Math.max(1, Math.min(share, total - cursor - remaining));
    const from = Math.min(cursor, total - 1);
    const to = Math.min(from + len - 1, total - 1);
    cursor = to + 1;
    return {
      category: p.category, name: p.name, color: p.color,
      planned_start: addDays(start, from), deadline: addDays(start, last ? total - 1 : to),
      needs_client_approval: Boolean(p.needsClientApproval), items: p.items ?? [],
    };
  });
}

/** Late days of a phase as the database calculates them, for optimistic display. */
export function phaseLateDays(p: Pick<Phase, "status" | "deadline" | "submitted_on">, today: string) {
  if (p.status === "skipped") return 0;
  if (p.submitted_on && (p.status === "in_review" || p.status === "done")) return Math.max(daysBetween(p.deadline, p.submitted_on), 0);
  if (p.status === "done") return 0;
  return Math.max(daysBetween(p.deadline, today), 0);
}

// ---------------------------------------------------------------------------
// Payments in parts
// ---------------------------------------------------------------------------
export type MilestoneStatus = "upcoming" | "due" | "partly_paid" | "overdue" | "paid";
export const MILESTONE_STATUS_LABELS: Record<MilestoneStatus, string> = {
  upcoming: "Upcoming", due: "Due", partly_paid: "Partly paid", overdue: "Overdue", paid: "Paid",
};

export type Milestone = {
  id: string; position: number; label: string; due_trigger: "date" | "phase"; due_date?: string; due_on?: string;
  phase?: { id: string; name: string; status: PhaseStatus }; status: MilestoneStatus; days_overdue?: number; version: number;
  /** Money roles only. */
  percent?: number; amount?: number; paid?: number; balance?: number; notes?: string;
};
export type ProjectPayment = {
  id: string; amount: number; paid_on: string; mode: string; reference: string | null; notes: string | null;
  /** Extra work outside the schedule; otherwise the money fills the schedule's parts in order. */
  is_extra: boolean; milestone_id: string | null; milestone: string | null; received_by: string | null; version: number; created_at: string;
};
/** Admin / Accounts only. Schedule payments fill the parts oldest first; "ahead" is money beyond the whole schedule. */
export type PaymentStatus = {
  money: true; contract_value: number | null; scheduled: number; received: number; extra: number; schedule_open: number; ahead: number;
  milestones: Milestone[]; payments: ProjectPayment[];
};

/** How a new schedule payment would be applied: the oldest open parts first. */
export function allocatePayment(milestones: Pick<Milestone, "id" | "label" | "balance">[], amount: number) {
  let left = Math.round(amount * 100);
  const parts: { id: string; label: string; applied: number; clears: boolean }[] = [];
  for (const m of milestones) {
    const balance = Math.round(Number(m.balance ?? 0) * 100);
    if (left <= 0) break;
    if (balance <= 0) continue;
    const applied = Math.min(left, balance);
    parts.push({ id: m.id, label: m.label, applied: applied / 100, clears: applied === balance });
    left -= applied;
  }
  return { parts, ahead: left / 100 };
}
export type PaymentDue = Milestone & { project: { id: string; name: string; code: string; client_name: string; client_phone: string | null } };

/** The default schedule: advance at closing, then parts tied to the design, BOQ and handover phases. */
export const DEFAULT_SCHEDULE: { label: string; percent: number; phase?: string }[] = [
  { label: "Advance", percent: 30 },
  { label: "After design approval", percent: 20, phase: "Design development: layout + deck" },
  { label: "After BOQ R2", percent: 30, phase: "BOQ — R2" },
  { label: "At handover", percent: 20, phase: "Handover & completion report" },
];

export type MilestoneDraft = { label: string; percent: number; amount: string; due_trigger: "date" | "phase"; due_date?: string; phase_index?: number };

/** Splits the contract value by percent (exact to the paisa; the last part takes the rounding). */
/** Rupees as whole paise, so money compares exactly. */
const toPaise = (v: unknown) => Math.round(Number(v ?? 0) * 100);
/** Total of rupee amounts, exact to the paisa. */
export const sumAmounts = (amounts: unknown[]) => amounts.reduce<number>((s, a) => s + toPaise(a), 0) / 100;

/**
 * How much the payment parts go over the contract value (0 when they don't, or no value is set).
 * The schedule may never ask for more than the contract: lower a part, or Accounts raises the value.
 */
export function scheduleExcess(contractValue: unknown, partsTotal: unknown) {
  if (contractValue == null || contractValue === "") return 0;
  return Math.max(toPaise(partsTotal) - toPaise(contractValue), 0) / 100;
}
export const scheduleExcessMessage = (partsTotal: unknown, contractValue: unknown) =>
  `The parts would add up to ${formatINR(Number(partsTotal))}, ${formatINR(scheduleExcess(contractValue, partsTotal))} more than the contract value (${formatINR(Number(contractValue))}). Lower a part, or raise the contract value.`;

export function splitByPercent(total: number, percents: number[]) {
  const paise = Math.round(total * 100);
  let used = 0;
  return percents.map((p, i) => {
    const part = i === percents.length - 1 ? paise - used : Math.round((paise * p) / 100);
    used += part;
    return (part / 100).toFixed(2);
  });
}

/** One editable part of the schedule in the "New project" dialog. A phase is referred to by its name. */
export type ScheduleRow = { label: string; percent: string; due_trigger: "date" | "phase"; due_date: string; phase_name: string };

export function defaultScheduleRows(startDate: string): ScheduleRow[] {
  return DEFAULT_SCHEDULE.map((s) => ({
    label: s.label, percent: String(s.percent), due_trigger: s.phase ? "phase" : "date", due_date: startDate, phase_name: s.phase ?? "",
  }));
}

export const schedulePercentTotal = (rows: ScheduleRow[]) => Math.round(rows.reduce((t, r) => t + (Number(r.percent) || 0), 0) * 100) / 100;

/**
 * The rows as milestones for create_project. Amounts come from the contract value: exact to the paisa when the
 * parts add up to 100% (the last part takes the rounding), else each part on its own. A part tied to a phase
 * that isn't in the timeline is due on its date instead.
 */
export function scheduleToMilestones(rows: ScheduleRow[], phases: PhaseDraft[], contractValue: number | null, startDate: string): MilestoneDraft[] {
  const percents = rows.map((r) => Number(r.percent) || 0);
  const amounts = schedulePercentTotal(rows) === 100
    ? splitByPercent(contractValue ?? 0, percents)
    : percents.map((p) => (Math.round((contractValue ?? 0) * p) / 100).toFixed(2));
  return rows.map((r, i) => {
    const index = r.due_trigger === "phase" ? phases.findIndex((p) => p.name === r.phase_name) : -1;
    return index >= 0
      ? { label: r.label.trim(), percent: percents[i], amount: amounts[i], due_trigger: "phase", phase_index: index + 1 }
      : { label: r.label.trim(), percent: percents[i], amount: amounts[i], due_trigger: "date", due_date: r.due_date || startDate };
  });
}

/** The default schedule for a timeline (kept for callers that don't edit it). */
export function buildSchedule(phases: PhaseDraft[], contractValue: number | null, startDate: string): MilestoneDraft[] {
  return scheduleToMilestones(defaultScheduleRows(startDate), phases, contractValue, startDate);
}

// ---------------------------------------------------------------------------
// Site visits
// ---------------------------------------------------------------------------
export type SiteVisitStatus = "scheduled" | "checked_in" | "completed" | "cancelled";
export const VISIT_STATUS_LABELS: Record<SiteVisitStatus, string> = {
  scheduled: "Scheduled", checked_in: "On site", completed: "Done", cancelled: "Cancelled",
};
/** Warn when a check-in is this far from the saved site pin. */
export const SITE_RADIUS_M = 300;

export type SiteVisit = {
  id: string; project_id: string | null; lead_id: string | null; scheduled_at: string; purpose: string; status: SiteVisitStatus;
  check_in_at: string | null; check_in_lat: number | null; check_in_lng: number | null; check_in_accuracy_m: number | null;
  distance_from_site_m: number | null; check_out_at: string | null; notes: Record<string, unknown> | null;
  measurements: string | null; outcome: string | null; version: number; created_at: string; overdue: boolean;
  assignee: { id: string; display_name: string };
  project: { id: string; name: string; code: string; site_address: string | null; site_lat: number | null; site_lng: number | null; client_name: string; client_phone: string | null } | null;
  lead: { id: string; name: string; phone: string } | null;
};

// ---------------------------------------------------------------------------
// BOQ, site logs, snags
// ---------------------------------------------------------------------------
export type BoqStatus = "draft" | "sent" | "client_approved" | "superseded";
export const BOQ_STATUS_LABELS: Record<BoqStatus, string> = { draft: "Draft", sent: "Sent to client", client_approved: "Client approved", superseded: "Replaced" };
export const BOQ_SECTIONS = ["Hardscape", "Softscape", "Irrigation", "Lighting", "Civil", "Other"];
export const BOQ_UNITS = ["nos", "sqft", "sqm", "rft", "rmt", "cum", "kg", "bag", "lot", "ls"];

export type BoqItem = {
  id: string; position: number; section: string; item: string; description: string | null; unit: string;
  qty: number; rate: number; amount: number; executed_qty: number;
};
export type BoqRevision = {
  id: string; label: string; title: string | null; status: BoqStatus; notes: string | null; sent_at: string | null;
  approved_at: string | null; version: number; created_at: string; created_by: string | null; total: number; items: BoqItem[];
};

export type SiteLog = {
  id: string; project_id: string; log_date: string; work_done: Record<string, unknown> | null; workers: number | null;
  issues: string | null; version: number; created_by: string; created_at: string; author: { display_name: string } | null;
};

export type SnagStatus = "open" | "fixed" | "verified";
export const SNAG_STATUS_LABELS: Record<SnagStatus, string> = { open: "Open", fixed: "Fixed", verified: "Checked" };
export type Snag = {
  id: string; title: string; details: string | null; status: SnagStatus; owner_id: string | null; due_date: string | null;
  fixed_at: string | null; version: number; created_at: string; owner: { display_name: string } | null;
};

export type MyWork = {
  today: string;
  phases: (Phase & { project: { id: string; name: string; code: string; color: ProjectColor } })[];
  visits: SiteVisit[];
  snags: { id: string; title: string; status: SnagStatus; due_date: string | null; project: { id: string; name: string; code: string } }[];
  sites: { id: string; name: string; code: string; site_address: string | null; logged_today: boolean; open_snags: number }[];
};

// ---------------------------------------------------------------------------
// Project files
// ---------------------------------------------------------------------------
export type FileVersionStatus = "draft" | "submitted" | "approved" | "client_approved" | "changes_requested" | "superseded";
export const FILE_STATUS_LABELS: Record<FileVersionStatus, string> = {
  draft: "Draft", submitted: "Waiting for review", approved: "Approved · client can see",
  client_approved: "Client approved", changes_requested: "Changes requested", superseded: "Old version",
};
export type FileKind = "image" | "pdf" | "cad" | "sketchup" | "video" | "office" | "archive" | "other";

export type ProjectFolder = { id: string; parent_id: string | null; name: string; system_key: string | null; restricted: boolean; position: number; created_by: string | null };
/** An archived folder as the Archived list shows it (sub-folders archived with it are counted in it). */
export type ArchivedProjectFolder = {
  id: string; name: string; archived_at: string; parent_name: string | null; parent_archived: boolean;
  archived_by: string | null; created_by: string | null; folders: number; files: number; bytes: number;
};
export type ProjectFileItem = {
  id: string; name: string; kind: FileKind; folder_id: string; updated_at: string; created_at: string;
  phase: { id: string; name: string } | null;
  current: { id: string; version_no: number; status: FileVersionStatus; size_bytes: number; mime_type: string; created_at: string; uploaded_by: string | null } | null;
  client_version: { version_no: number; status: FileVersionStatus } | null;
  versions: number; open_comments: number; client_seen_at: string | null;
};
export type FileVersion = {
  id: string; version_no: number; status: FileVersionStatus; size_bytes: number; mime_type: string; original_name: string; note: string | null;
  client_comment: string | null; created_at: string; status_at: string | null; uploaded_by: string | null; uploaded_by_id: string | null; status_by: string | null;
};
export type FileComment = {
  id: string; version_id: string; page: number | null; x_pct: number | null; y_pct: number | null; body: string; from_client: boolean;
  created_at: string; resolved_at: string | null; author: string;
  /** Filled in by fetchProjectFile: a pin on a DWG/DXF drawing (drawing coordinates), the pin's colour, who wrote it. */
  cad_x?: number | null; cad_y?: number | null; pin_color?: StageColor | null; author_id?: string | null;
};
export type FileEvent = { id: string; type: string; version_id: string | null; from_client: boolean; comment: string | null; created_at: string; actor: string | null };
export type ProjectFileDetail = {
  file: { id: string; name: string; kind: FileKind; folder_id: string; project_id: string; current_version_id: string | null; archived_at: string | null; can_manage: boolean };
  versions: FileVersion[]; comments: FileComment[]; events: FileEvent[];
};

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** One month folder of the projects page (projects grouped by their start date). */
export type ProjectMonth = { year: number; month: number; total: number; late: number; active: number; colors: ProjectColor[] };
/** One year folder: its months, newest year first. */
export type ProjectYear = { year: number; total: number; late: number; months: ProjectMonth[] };

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The start-date range of a month folder: [from, to) as YYYY-MM-DD. */
export function monthRange(year: number, month: number) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return { from: `${year}-${pad(month)}-01`, to: `${next.y}-${pad(next.m)}-01` };
}

/** Year folders from month folders: newest year first, months January → December inside. */
export function groupYears(months: ProjectMonth[]): ProjectYear[] {
  const years = new Map<number, ProjectYear>();
  for (const m of months) {
    const y = years.get(m.year) ?? { year: m.year, total: 0, late: 0, months: [] };
    y.total += m.total;
    y.late += m.late;
    y.months.push(m);
    years.set(m.year, y);
  }
  return [...years.values()].sort((a, b) => b.year - a.year).map((y) => ({ ...y, months: y.months.sort((a, b) => a.month - b.month) }));
}

/** Month folders counted from bare project rows (only while the database lacks project_months). */
export function countMonths(rows: { start_date: string; status: string; color: string }[]): ProjectMonth[] {
  const by = new Map<string, ProjectMonth>();
  for (const r of rows) {
    const [y, m] = r.start_date.split("-").map(Number);
    const k = `${y}-${m}`;
    const cur = by.get(k) ?? { year: y, month: m, total: 0, late: 0, active: 0, colors: [] };
    cur.total += 1;
    if (r.status === "active") cur.active += 1;
    if (cur.colors.length < 4) cur.colors.push(r.color as ProjectColor);
    by.set(k, cur);
  }
  return [...by.values()].sort((a, b) => b.year - a.year || b.month - a.month);
}

/** One person on the team-work page: their open phases by status and what they did lately. */
export type TeamPerson = {
  id: string; name: string; roles: string[];
  projects: { id: string; name: string; code: string; role: ProjectMemberRole }[];
  in_progress: number; in_review: number; changes: number; not_started: number; late: number;
  /** In the chosen period: phases they sent for review, and their phases a manager approved. */
  submitted: number; approved: number;
  phases: { id: string; project_id: string; project: string; name: string; stage: string; status: PhaseStatus; deadline: string; late_days: number; updated_at: string }[];
  recent: { at: string; source: "activity" | "file"; type: string; meta: Record<string, unknown>; body: string | null; project_id: string; project: string; file: string | null }[];
  last_active: string | null;
};
export type TeamWork = { days: number; people: TeamPerson[] };
