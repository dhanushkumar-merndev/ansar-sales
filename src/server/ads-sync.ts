import "server-only";
import {
  adsGraph, type AdCreds, dayWindows, fetchAdAccount, fetchAds, fetchCampaigns, fetchInsights, fetchMonthlyReach,
  MetaApiError, RATE_LIMIT_CODES, shiftDay, todayIn,
} from "@/lib/meta-ads";
import { createAdminClient } from "@/lib/supabase/admin";

type AdSecrets = {
  id: string; act_id: string; app_id: string; app_secret: string | null; access_token: string | null; timezone: string | null;
  synced_through: string | null; backfilled_from: string | null;
};

export type ConnectStep = { label: string; ok: boolean; detail?: string };

/** Days pulled on the first sync; older history is back-filled 30 days per run up to a year. */
const FIRST_DAYS = 30;
const BACKFILL_DAYS = 365;
const BACKFILL_STEP = 30;
/** Per-ad days are kept this long (then rolled into months by the database), so older ones aren't fetched. */
const AD_LEVEL_DAYS = 90;
/** Meta revises recent days (late attribution), so each sync re-reads them. */
const REVISE_DAYS = 3;

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Unknown error").slice(0, 300);

async function loadAdSecrets(id: string) {
  const { data, error } = await createAdminClient().rpc("ad_account_secrets", { p_account: id }).maybeSingle();
  if (error || !data) return null;
  const s = data as AdSecrets;
  return s.app_secret && s.access_token ? { ...s, creds: { appSecret: s.app_secret, token: s.access_token } as AdCreds } : null;
}

async function setState(id: string, state: {
  status: "connected" | "error" | "unverified"; error?: string | null; name?: string; currency?: string; timezone?: string;
  syncedThrough?: string; backfilledFrom?: string; nextSyncAfter?: string; synced?: boolean;
}) {
  await createAdminClient().rpc("set_ad_account_state", {
    p_account: id, p_status: state.status, p_error: state.error ?? undefined, p_name: state.name, p_currency: state.currency,
    p_timezone: state.timezone, p_synced_through: state.syncedThrough, p_backfilled_from: state.backfilledFrom,
    p_next_sync_after: state.nextSyncAfter, p_synced: state.synced ?? false,
  });
}

/**
 * Checks a saved ad account step by step (token, account access, insights permission) and marks
 * it connected, so the hourly sync picks it up. Secrets are read on the server only.
 */
export async function checkAdAccount(id: string): Promise<{ steps: ConnectStep[]; connected: boolean }> {
  const s = await loadAdSecrets(id);
  if (!s) return { steps: [{ label: "Saved credentials", ok: false, detail: "Save the App ID, App secret, token and ad account ID first." }], connected: false };
  const steps: ConnectStep[] = [];
  const step = async <T,>(label: string, run: () => Promise<T>, detail?: (v: T) => string | undefined) => {
    try {
      const value = await run();
      steps.push({ label, ok: true, detail: detail?.(value) });
      return value;
    } catch (e) {
      steps.push({ label, ok: false, detail: errorText(e) });
      return null;
    }
  };

  const me = await step("System user token works", () => adsGraph<{ name?: string }>("me", s.creds, { fields: "id,name" }), (m) => (m.name ? `Signed in as ${m.name}` : undefined));
  const info = me && await step("Ad account access", () => fetchAdAccount(s.act_id, s.creds), (a) => `${a.name} · ${a.currency} · ${a.timezone}`);
  const insights = info && await step("Can read ad insights (ads_read)", () =>
    adsGraph(`act_${s.act_id}/insights`, s.creds, { date_preset: "yesterday", fields: "spend", limit: "1" }));
  const connected = Boolean(insights && info);
  await setState(id, connected && info
    ? { status: "connected", error: null, name: info.name, currency: info.currency, timezone: info.timezone }
    : { status: "error", error: steps.find((x) => !x.ok)?.detail ?? "Check failed" });
  return { steps, connected };
}

/**
 * Pulls one ad account into the database: campaigns and ads, daily insights from three days before
 * the last synced day up to today (so missed runs fill themselves in), one back-fill step of older
 * history, and whole-month unique reach. Uses the admin client: it runs for the cron route or after
 * an authorized user action, never with the user's own session.
 */
export async function syncAdAccount(id: string): Promise<{ ok: boolean; error?: string; rateLimited?: boolean }> {
  const admin = createAdminClient();
  const s = await loadAdSecrets(id);
  if (!s) return { ok: false, error: "Not connected" };
  try {
    const info = await fetchAdAccount(s.act_id, s.creds);
    const today = todayIn(info.timezone);
    const since = s.synced_through ? shiftDay(s.synced_through, -REVISE_DAYS) : shiftDay(today, -(FIRST_DAYS - 1));

    const [campaigns, ads] = await Promise.all([fetchCampaigns(s.act_id, s.creds, info.currency), fetchAds(s.act_id, s.creds)]);
    const entities = await admin.rpc("upsert_ad_entities", { p_account: id, p_campaigns: campaigns, p_ads: ads });
    if (entities.error) throw new Error(entities.error.message);

    const windows = dayWindows(since < today ? since : today, today);
    const oldest = shiftDay(today, -(BACKFILL_DAYS - 1));
    let backfilledFrom = s.backfilled_from ?? since;
    if (s.backfilled_from && backfilledFrom > oldest) {
      const from = shiftDay(backfilledFrom, -BACKFILL_STEP) > oldest ? shiftDay(backfilledFrom, -BACKFILL_STEP) : oldest;
      windows.unshift({ since: from, until: shiftDay(backfilledFrom, -1) });
      backfilledFrom = from;
    }

    const adFloor = shiftDay(today, -(AD_LEVEL_DAYS - 1));
    for (const w of windows) {
      const rows = await fetchInsights(s.act_id, s.creds, "campaign", w.since, w.until);
      const saved = await admin.rpc("upsert_ad_insights", { p_account: id, p_level: "campaign", p_rows: rows });
      if (saved.error) throw new Error(saved.error.message);
      const adSince = w.since > adFloor ? w.since : adFloor;
      if (adSince <= w.until) {
        const adRows = await fetchInsights(s.act_id, s.creds, "ad", adSince, w.until);
        const savedAds = await admin.rpc("upsert_ad_insights", { p_account: id, p_level: "ad", p_rows: adRows });
        if (savedAds.error) throw new Error(savedAds.error.message);
      }
    }

    // Unique reach for this month so far, and for last month while its numbers can still move.
    const monthStart = `${today.slice(0, 7)}-01`;
    const months = [{ start: monthStart, end: today }];
    if (Number(today.slice(8, 10)) <= REVISE_DAYS || !s.synced_through) {
      const prevEnd = shiftDay(monthStart, -1);
      months.push({ start: `${prevEnd.slice(0, 7)}-01`, end: prevEnd });
    }
    for (const m of months) {
      const reach = await fetchMonthlyReach(s.act_id, s.creds, m.start, m.end);
      await admin.rpc("upsert_ad_reach", { p_account: id, p_rows: reach });
    }

    await setState(id, {
      status: "connected", error: null, name: info.name, currency: info.currency, timezone: info.timezone,
      syncedThrough: today, backfilledFrom, synced: true,
    });
    return { ok: true };
  } catch (e) {
    const message = errorText(e);
    if (e instanceof MetaApiError && e.code !== null && RATE_LIMIT_CODES.has(e.code)) {
      // Throttled: keep the account connected and try again in an hour.
      await setState(id, { status: "connected", error: `Meta rate limit: ${message}`, nextSyncAfter: new Date(Date.now() + 3600_000).toISOString() });
      return { ok: false, error: message, rateLimited: true };
    }
    await setState(id, { status: "error", error: message });
    return { ok: false, error: message };
  }
}
