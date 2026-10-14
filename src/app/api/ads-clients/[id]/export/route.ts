import { NextResponse, type NextRequest } from "next/server";
import { AuthorizationError, authorizeAction } from "@/lib/auth";
import { adsClientWorkbook, EXPORT_SHEETS } from "@/lib/ads-client-export";
import { istToday } from "@/lib/time";

export const maxDuration = 60;

const PAGE = 2000;
/** Past this the file would be too big to build here; the super admin is told instead of getting a cut file. */
const MAX_ROWS = 300_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Super admin: everything of a deleted ads client as one .xlsx (client, logins, CRM leads, timeline,
 * follow-ups, Facebook leads, ad accounts, campaigns, daily results). Making the file is what allows
 * the permanent delete, so it is recorded only once the whole file is built.
 */
export async function GET(_request: NextRequest, { params }: RouteContext<"/api/ads-clients/[id]/export">) {
  let auth: Awaited<ReturnType<typeof authorizeAction>>;
  try {
    auth = await authorizeAction("super_admin");
  } catch (e) {
    if (e instanceof AuthorizationError) return new NextResponse(null, { status: 403 });
    throw e;
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return new NextResponse(null, { status: 404 });
  const { supabase } = auth;

  const data: Record<string, Record<string, unknown>[]> = {};
  let total = 0;
  for (const { section } of EXPORT_SHEETS) {
    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data: page, error } = await supabase.rpc("ads_client_export", { p_id: id, p_section: section, p_offset: offset, p_limit: PAGE });
      if (error) return NextResponse.json({ error: error.code === "P0002" ? "not_found" : "read_failed" }, { status: error.code === "P0002" ? 404 : 500 });
      const got = (page ?? []) as Record<string, unknown>[];
      rows.push(...got);
      total += got.length;
      if (total > MAX_ROWS) return NextResponse.json({ error: "too_big" }, { status: 413 });
      if (got.length < PAGE) break;
    }
    data[section] = rows;
  }

  const file = await adsClientWorkbook(data);
  const { error } = await supabase.rpc("mark_ads_client_exported", { p_id: id });
  if (error) return NextResponse.json({ error: "record_failed" }, { status: 500 });

  const client = data.client?.[0] ?? {};
  const slug = String(client.company_name ?? client.contact ?? "client").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
  return new NextResponse(new Uint8Array(file), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="deleted-client-${slug}-${istToday()}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
