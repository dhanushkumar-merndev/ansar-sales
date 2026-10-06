"use server";

import { after } from "next/server";
import { z } from "zod";
import { dbError, type ActionResult } from "@/lib/errors";
import type { createClient } from "@/lib/supabase/server";
import { passwordSchema, usernameSchema } from "@/lib/validation";
import { runAction } from "@/server/action-utils";
import { checkAdAccount, syncAdAccount } from "@/server/ads-sync";
import { provisionLogin, setAuthBan, setAuthPassword } from "@/server/provision-login";

const ADS_ROLES = ["admin", "ads_manager"] as const;
const metaId = z.string().trim().regex(/^(act_)?\d{5,25}$/, "Digits only, as shown in Meta");
const displayName = z.string().trim().min(1, "Enter a name").max(80);
const optional = (max: number) => z.string().trim().max(max).optional();

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * The database decides whether this user may manage the ad account (full access in their current
 * company, or super admin). Needed before anything that uses the account's secrets on the server.
 */
async function requireManage(supabase: Supabase, accountId: string) {
  const { data, error } = await supabase.rpc("ad_account_detail", { p_account: accountId });
  const detail = data as { scope?: string; last_synced_at?: string | null } | null;
  if (error || detail?.scope !== "all") return null;
  return detail;
}

// ---------------------------------------------------------------------------
// Ad accounts
// ---------------------------------------------------------------------------
/** Company account (kind "company", owner = company id) or an ads client's (kind "client", owner = client id). */
export async function saveAdAccount(input: unknown) {
  const schema = z.object({
    kind: z.enum(["company", "client"]), ownerId: z.uuid(), actId: metaId,
    appId: metaId.optional(), appSecret: optional(200), accessToken: optional(1000), useLeadApp: z.boolean().optional(),
  });
  return runAction([...ADS_ROLES], schema, input, async (d, { supabase }) => {
    if (!d.useLeadApp && !d.appId) return { ok: false, error: "Enter the App ID.", fieldErrors: { appId: ["Required"] } };
    const { data, error } = await supabase.rpc("save_ad_account", {
      p_kind: d.kind, p_owner: d.ownerId, p_act_id: d.actId, p_app_id: d.appId ?? undefined,
      p_app_secret: d.appSecret || undefined, p_access_token: d.accessToken || undefined, p_use_lead_app: d.useLeadApp ?? false,
    });
    if (error) return dbError(error);
    return { ok: true, data: { id: data as string } };
  });
}

/** Checks token, account access and insights permission; on success the first sync starts in the background. */
export async function testAdAccount(input: unknown) {
  return runAction([...ADS_ROLES], z.object({ accountId: z.uuid() }), input, async (d, { supabase }) => {
    if (!(await requireManage(supabase, d.accountId))) return { ok: false, error: "You don't have permission to do that.", code: "forbidden" };
    const result = await checkAdAccount(d.accountId);
    if (result.connected) after(() => syncAdAccount(d.accountId).then(() => undefined));
    return { ok: true, data: result };
  });
}

/** Pulls the latest numbers now (at most every 5 minutes per account). */
export async function refreshAdAccount(input: unknown) {
  return runAction([...ADS_ROLES], z.object({ accountId: z.uuid() }), input, async (d, { supabase }): Promise<ActionResult> => {
    const detail = await requireManage(supabase, d.accountId);
    if (!detail) return { ok: false, error: "You don't have permission to do that.", code: "forbidden" };
    if (detail.last_synced_at && Date.now() - new Date(detail.last_synced_at).getTime() < 5 * 60_000) {
      return { ok: false, error: "Synced less than 5 minutes ago. Try again in a few minutes." };
    }
    const r = await syncAdAccount(d.accountId);
    return r.ok ? { ok: true, data: undefined } : { ok: false, error: `Meta: ${r.error}` };
  });
}

/** Stops syncing and deletes the stored secrets. Everything already synced stays. */
export async function disconnectAdAccount(input: unknown) {
  return runAction([...ADS_ROLES], z.object({ accountId: z.uuid() }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("disconnect_ad_account", { p_account: d.accountId });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

// ---------------------------------------------------------------------------
// Categories and merging
// ---------------------------------------------------------------------------
export async function saveAdCategory(input: unknown) {
  const schema = z.object({ accountId: z.uuid(), id: z.uuid().optional(), name: z.string().trim().max(60), matchText: optional(60) });
  return runAction([...ADS_ROLES], schema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("save_ad_category", {
      p_account: d.accountId, p_id: (d.id ?? null) as string, p_name: d.name, p_match_text: d.matchText || undefined,
    });
    if (error) return dbError(error);
    return { ok: true, data: { id: data as string } };
  });
}

export async function archiveAdCategory(input: unknown) {
  return runAction([...ADS_ROLES], z.object({ id: z.uuid() }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("archive_ad_category", { p_id: d.id });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function setCampaignCategory(input: unknown) {
  const schema = z.object({ campaignIds: z.array(z.uuid()).min(1).max(100), categoryId: z.uuid().nullable() });
  return runAction([...ADS_ROLES], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_ad_campaign_category", { p_campaign_ids: d.campaignIds, p_category_id: d.categoryId as string });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Super admin: exactly which other companies share this company ad account. */
export async function mergeAdAccount(input: unknown) {
  return runAction("super_admin", z.object({ accountId: z.uuid(), companyIds: z.array(z.uuid()).max(50) }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("merge_ad_account", { p_account: d.accountId, p_company_ids: d.companyIds });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function setWonToAdsClient(input: unknown) {
  return runAction(["admin"], z.object({ companyId: z.uuid(), enabled: z.boolean() }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_won_to_ads_client", { p_company_id: d.companyId, p_enabled: d.enabled });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

// ---------------------------------------------------------------------------
// Ads managers (super admin)
// ---------------------------------------------------------------------------
export async function createAdsManager(input: unknown) {
  const schema = z.object({ username: usernameSchema, displayName, password: passwordSchema, companyIds: z.array(z.uuid()).max(50) });
  return runAction("super_admin", schema, input, async (d, { supabase, profile }) => {
    const created = await provisionLogin({ username: d.username, displayName: d.displayName, password: d.password, role: "ads_manager", createdBy: profile.id });
    if (!created.ok) return created;
    const { error } = await supabase.rpc("set_ads_manager_companies", { p_user_id: created.data.id, p_company_ids: d.companyIds });
    if (error) return { ok: false, error: "The login was created, but its companies couldn't be saved. Tick them again." };
    return created;
  });
}

export async function setAdsManagerCompanies(input: unknown) {
  return runAction("super_admin", z.object({ id: z.uuid(), companyIds: z.array(z.uuid()).max(50) }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_ads_manager_companies", { p_user_id: d.id, p_company_ids: d.companyIds });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function updateAdsManager(input: unknown) {
  const schema = z.object({ id: z.uuid(), displayName: displayName.optional(), isActive: z.boolean().optional() });
  return runAction("super_admin", schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("super_update_ads_manager", { p_user_id: d.id, p_display_name: d.displayName, p_is_active: d.isActive });
    if (error) return dbError(error);
    if (d.isActive !== undefined && !(await setAuthBan(d.id, d.isActive))) {
      return { ok: false, error: "Saved, but the sign-in block could not be changed. Retry to sync it.", code: "auth_sync" };
    }
    return { ok: true, data: undefined };
  });
}

export async function resetAdsManagerPassword(input: unknown) {
  return runAction("super_admin", z.object({ id: z.uuid(), password: passwordSchema }), input, async (d, { supabase }) => {
    // Authorizes (ads managers only) and logs the reset before touching Auth.
    const { error } = await supabase.rpc("super_update_ads_manager", { p_user_id: d.id, p_password_reset: true });
    if (error) return dbError(error);
    if (!(await setAuthPassword(d.id, d.password))) return { ok: false, error: "Could not reset the password." };
    return { ok: true, data: undefined };
  });
}

// ---------------------------------------------------------------------------
// Ads clients and their portal logins
// ---------------------------------------------------------------------------
const clientFields = {
  name: z.string().trim().min(1, "Enter the client's name").max(120),
  phone: optional(32), email: z.union([z.literal(""), z.email("Enter a valid email")]).optional(), business: optional(120), notes: optional(2000),
};

export async function createAdsClient(input: unknown) {
  return runAction([...ADS_ROLES], z.object(clientFields), input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("create_ads_client", {
      p_name: d.name, p_phone: d.phone || undefined, p_email: d.email || undefined, p_business: d.business || undefined, p_notes: d.notes || undefined,
    });
    if (error) return dbError(error);
    return { ok: true, data: { id: data as string } };
  });
}

export async function updateAdsClient(input: unknown) {
  return runAction([...ADS_ROLES], z.object({ id: z.uuid(), ...clientFields }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("update_ads_client", {
      p_id: d.id, p_name: d.name, p_phone: d.phone ?? "", p_email: d.email ?? "", p_business: d.business ?? "", p_notes: d.notes ?? "",
    });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Closing pauses syncing (history stays) and, by default, disables the client's logins. */
export async function setAdsClientStatus(input: unknown) {
  const schema = z.object({ id: z.uuid(), status: z.enum(["onboarding", "active", "paused", "closed"]), disableLogins: z.boolean().optional() });
  return runAction([...ADS_ROLES], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_ads_client_status", { p_id: d.id, p_status: d.status, p_disable_logins: d.disableLogins ?? true });
    if (error) return dbError(error);
    if (d.status === "closed" && (d.disableLogins ?? true)) {
      const { data } = await supabase.rpc("ads_client_detail", { p_id: d.id });
      for (const login of ((data as { logins?: { id: string }[] } | null)?.logins ?? [])) await setAuthBan(login.id, false);
    }
    return { ok: true, data: undefined };
  });
}

/** A read-only portal login for the client, created after the database authorizes this client. */
export async function createClientLogin(input: unknown) {
  const schema = z.object({ clientId: z.uuid(), username: usernameSchema, displayName, password: passwordSchema });
  return runAction([...ADS_ROLES], schema, input, async (d, { supabase, profile }) => {
    const { data: companyId, error } = await supabase.rpc("ads_client_login_check", { p_client: d.clientId });
    if (error || !companyId) return dbError(error);
    return provisionLogin({
      username: d.username, displayName: d.displayName, password: d.password, role: "client",
      companyId: companyId as string, adsClientId: d.clientId, createdBy: profile.id,
    });
  });
}

export async function setClientLoginActive(input: unknown) {
  return runAction([...ADS_ROLES], z.object({ id: z.uuid(), isActive: z.boolean() }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_client_login", { p_user_id: d.id, p_is_active: d.isActive });
    if (error) return dbError(error);
    if (!(await setAuthBan(d.id, d.isActive))) return { ok: false, error: "Saved, but the sign-in block could not be changed. Retry to sync it." };
    return { ok: true, data: undefined };
  });
}

export async function resetClientPassword(input: unknown) {
  return runAction([...ADS_ROLES], z.object({ id: z.uuid(), password: passwordSchema }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_client_login", { p_user_id: d.id, p_password_reset: true });
    if (error) return dbError(error);
    if (!(await setAuthPassword(d.id, d.password))) return { ok: false, error: "Could not reset the password." };
    return { ok: true, data: undefined };
  });
}
