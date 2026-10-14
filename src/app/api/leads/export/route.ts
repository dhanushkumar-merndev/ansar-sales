import { NextResponse, type NextRequest } from "next/server";
import { AuthorizationError, authorizeAction } from "@/lib/auth";
import { type ExportedLead, leadsWorkbook } from "@/lib/lead-export";
import { addDays, istDayStartUtc, istToday } from "@/lib/time";

export const maxDuration = 60;

const PAGE = 1000;
/** Rows per file. Past this, "New" again downloads the rest. */
const MAX_ROWS = 20_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Admin: the company's active leads as an .xlsx (`?only=new`: only those this admin hasn't
 * downloaded yet; `?from=YYYY-MM-DD&to=YYYY-MM-DD`: only those added on those IST days). Reads with the admin's own session, so RLS keeps it to their company; the
 * downloaded leads are then recorded for "New". 204 when there is nothing to download.
 */
export async function GET(request: NextRequest) {
  let auth: Awaited<ReturnType<typeof authorizeAction>>;
  try {
    auth = await authorizeAction(["admin"]);
  } catch (e) {
    if (e instanceof AuthorizationError) return new NextResponse(null, { status: 403 });
    throw e;
  }
  const { profile, supabase } = auth;
  const params = request.nextUrl.searchParams;
  const onlyNew = params.get("only") === "new";
  const from = params.get("from"), to = params.get("to");
  const range = from && to ? { from, to } : null;
  if ((from || to) && (!range || !DAY_RE.test(range.from) || !DAY_RE.test(range.to) || range.from > range.to)) {
    return NextResponse.json({ error: "Choose a valid date range." }, { status: 400 });
  }

  const leads: ExportedLead[] = [];
  let more = false;
  for (;;) {
    const last = leads.at(-1);
    const { data, error } = await supabase.rpc("export_leads", {
      p_only_new: onlyNew, p_after_created: last?.created_at, p_after_id: last?.id, p_limit: PAGE,
      p_created_from: range ? istDayStartUtc(range.from) : undefined,
      p_created_before: range ? istDayStartUtc(addDays(range.to, 1)) : undefined,
    });
    if (error) return NextResponse.json({ error: "Couldn't read the leads." }, { status: 500 });
    const page = (data ?? []) as unknown as ExportedLead[];
    leads.push(...page);
    if (page.length < PAGE) break;
    if (leads.length >= MAX_ROWS) { more = true; break; }
  }
  if (!leads.length) return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });

  const file = await leadsWorkbook(leads);
  for (let i = 0; i < leads.length; i += PAGE) {
    const { error } = await supabase.rpc("mark_leads_exported", { p_ids: leads.slice(i, i + PAGE).map((l) => l.id) });
    if (error) return NextResponse.json({ error: "Couldn't record the download." }, { status: 500 });
  }

  const slug = profile.company.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company";
  const name = range
    ? `leads-${slug}-${range.from === range.to ? range.from : `${range.from}-to-${range.to}`}.xlsx`
    : `${onlyNew ? "new-leads" : "leads"}-${slug}-${istToday()}.xlsx`;
  return new NextResponse(new Uint8Array(file), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
      "X-Lead-Count": String(leads.length),
      "X-More-Leads": more ? "1" : "0",
    },
  });
}
