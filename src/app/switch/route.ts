import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opens a CRM path inside a given company, for the super admin's and ads managers' Telegram links
 * (`/switch?company=<id>&next=/finance`). Everyone else, or an unknown company, just goes to `next`.
 * Switching only changes which company they are looking at, so a GET is acceptable here.
 */
export async function GET(request: NextRequest) {
  const company = request.nextUrl.searchParams.get("company") ?? "";
  const nextParam = request.nextUrl.searchParams.get("next") ?? "/dashboard";
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/dashboard";
  const profile = await getCurrentProfile();
  if (!profile) return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`, request.url));
  // The database checks the company too: any for the super admin, an assigned one for an ads manager.
  if ((profile.isSuperAdmin || profile.role === "ads_manager") && UUID_RE.test(company) && company !== profile.company.id) {
    const supabase = await createClient();
    await supabase.rpc("set_active_company", { p_company_id: company });
  }
  return NextResponse.redirect(new URL(next, request.url));
}
