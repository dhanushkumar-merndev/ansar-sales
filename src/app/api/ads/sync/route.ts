import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeEqual } from "@/lib/telegram";
import { syncAdAccount } from "@/server/ads-sync";

export const maxDuration = 60;

/** Stop starting new accounts after this long; the rest go first in the next hourly run. */
const BUDGET_MS = 45_000;

/**
 * Hourly ad sync, called by Supabase Cron (private.invoke_ads_sync) with ADS_SYNC_SECRET.
 * Syncs the accounts that waited longest, one by one, within the time budget.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.ADS_SYNC_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return new NextResponse(null, { status: 401 });

  const started = Date.now();
  const { data: targets, error } = await createAdminClient().rpc("ad_sync_targets", { p_limit: 10 });
  if (error) return NextResponse.json({ ok: false }, { status: 500 });
  const results = { synced: 0, failed: 0, rateLimited: 0, skipped: 0 };
  for (const id of (targets ?? []) as string[]) {
    if (Date.now() - started > BUDGET_MS) {
      results.skipped += 1;
      continue;
    }
    const r = await syncAdAccount(id);
    if (r.ok) results.synced += 1;
    else if (r.rateLimited) results.rateLimited += 1;
    else results.failed += 1;
  }
  return NextResponse.json({ ok: true, ...results });
}
