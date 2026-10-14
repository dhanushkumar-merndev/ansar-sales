"use server";

import { after } from "next/server";
import { z } from "zod";
import type { AppRole } from "@/lib/constants";
import { publicEnv } from "@/lib/env";
import { type ActionResult, dbError } from "@/lib/errors";
import { GraphError, graph, type MetaLead } from "@/lib/meta";
import { createAdminClient } from "@/lib/supabase/admin";
import type { createClient } from "@/lib/supabase/server";
import { runAction } from "@/server/action-utils";
import { checkAdAccount, syncAdAccount } from "@/server/ads-sync";
import { ingestLeadgensBulk, loadMetaSecrets, pageToken } from "@/server/meta-ingest";

const metaId = z.string().trim().regex(/^\d{5,25}$/, "Digits only, as shown in Meta");
const FORBIDDEN = { ok: false as const, error: "You don't have permission to do that.", code: "forbidden" as const };

/** Admins for their own company; our admins and ads managers also for a client's CRM (the database decides). */
const META_ROLES: AppRole[] = ["admin", "ads_manager"];

/**
 * These actions read secrets with the service role, so ask the database for the scope first
 * (private.can_manage_meta, the rule the RPCs enforce too).
 */
async function canManage(supabase: Awaited<ReturnType<typeof createClient>>, companyId: string) {
  const { data } = await supabase.rpc("meta_can_manage", { p_company_id: companyId });
  return data === true;
}

export async function saveMetaIntegration(input: unknown) {
  const schema = z.object({
    companyId: z.uuid(), appId: metaId, pageId: metaId,
    appSecret: z.string().trim().max(200).optional(), accessToken: z.string().trim().max(1000).optional(),
  });
  return runAction(["admin"], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("save_meta_integration", {
      p_company_id: d.companyId, p_app_id: d.appId, p_page_id: d.pageId,
      p_app_secret: d.appSecret || undefined, p_access_token: d.accessToken || undefined,
    });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function deleteMetaIntegration(input: unknown) {
  return runAction(["admin"], z.object({ companyId: z.uuid() }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("delete_meta_integration", { p_company_id: d.companyId });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** One selected user gets every lead; two or more share them round-robin. */
export async function setMetaRouting(input: unknown) {
  return runAction(META_ROLES, z.object({ companyId: z.uuid(), userIds: z.array(z.uuid()).max(50) }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_meta_routing", { p_company_id: d.companyId, p_user_ids: d.userIds });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export type ConnectStep = { label: string; ok: boolean; detail?: string };

const webhookUrl = (companyId: string) => `${publicEnv.appUrl.replace(/\/+$/, "")}/api/meta/webhook/${companyId}`;

/**
 * Checks the saved credentials step by step and subscribes the Page and the app's webhook,
 * so new Lead Ads submissions reach this company. Secrets are read on the server only.
 */
async function checkLeadConnection(companyId: string): Promise<{ steps: ConnectStep[]; connected: boolean } | null> {
  const secrets = await loadMetaSecrets(companyId);
  if (!secrets) return null;
  const steps: ConnectStep[] = [];
  let pageName: string | undefined;
  const fail = async (message: string) => {
    await createAdminClient().rpc("set_meta_status", { p_company_id: companyId, p_status: "error", p_error: message.slice(0, 500) });
    return { steps, connected: false };
  };
  const step = async (label: string, run: () => Promise<string | undefined>) => {
    try {
      steps.push({ label, ok: true, detail: await run() });
      return true;
    } catch (e) {
      steps.push({ label, ok: false, detail: e instanceof GraphError || e instanceof Error ? e.message : "Failed" });
      return false;
    }
  };

  if (!publicEnv.appUrl.startsWith("https://")) {
    steps.push({ label: "Public HTTPS address", ok: false, detail: "Set NEXT_PUBLIC_APP_URL to the deployed https:// address (Meta can't reach localhost)." });
    return fail("NEXT_PUBLIC_APP_URL is not https");
  }
  if (!(await step("System user token works", async () => {
    const me = await graph<{ name?: string }>("me", secrets.access_token, { params: { fields: "id,name" } });
    return me.name ? `Signed in as ${me.name}` : undefined;
  }))) return fail(steps.at(-1)!.detail!);

  let token = "";
  if (!(await step("Page access", async () => {
    const page = await pageToken(secrets);
    token = page.token;
    pageName = page.name;
    return page.name;
  }))) return fail(steps.at(-1)!.detail!);

  if (!(await step("Page subscribed to lead events", async () => {
    await graph(`${secrets.page_id}/subscribed_apps`, token, { method: "POST", params: { subscribed_fields: "leadgen" } });
    return undefined;
  }))) return fail(steps.at(-1)!.detail!);

  // A Meta app has one webhook address. When this app already delivers to another company here
  // (a client's CRM connected with our app), keep that address: it passes each Page's leads on.
  const { data: shared } = await createAdminClient().from("meta_integrations").select("company_id")
    .eq("app_id", secrets.app_id).eq("status", "connected").neq("company_id", companyId).limit(1).maybeSingle();
  if (shared) {
    steps.push({ label: "App webhook registered", ok: true, detail: "Uses the webhook this Meta app already has here." });
  } else if (!(await step("App webhook registered", async () => {
    await graph(`${secrets.app_id}/subscriptions`, `${secrets.app_id}|${secrets.app_secret}`, {
      method: "POST",
      params: { object: "page", callback_url: webhookUrl(companyId), fields: "leadgen", verify_token: secrets.verify_token, include_values: "true" },
    });
    return webhookUrl(companyId);
  }))) return fail(steps.at(-1)!.detail!);

  await createAdminClient().rpc("set_meta_status", { p_company_id: companyId, p_status: "connected", p_page_name: pageName });
  return { steps, connected: true };
}

export async function connectMeta(input: unknown) {
  return runAction(META_ROLES, z.object({ companyId: z.uuid() }), input, async (d, { supabase }) => {
    if (!(await canManage(supabase, d.companyId))) return FORBIDDEN;
    const result = await checkLeadConnection(d.companyId);
    if (!result) return { ok: false, error: "Save the App ID, App secret, Page ID and token first." };
    return { ok: true, data: result };
  });
}

/** Pulls the last 7 days of leads from every form of the Page (recovers missed webhooks; never duplicates). */
/** How far back a sync looks: a week, a month, or everything Meta keeps (90 days). */
export type SyncDays = 7 | 30 | 90;

export async function syncMetaLeads(input: unknown) {
  const schema = z.object({ companyId: z.uuid(), days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(7) });
  return runAction(META_ROLES, schema, input, async (d, { supabase, profile }) => {
    if (!(await canManage(supabase, d.companyId))) return FORBIDDEN;
    // Longer periods (up to everything Meta keeps) are the super admin's.
    if (d.days !== 7 && !profile.isSuperAdmin) return FORBIDDEN;
    return pullRecentLeads(d.companyId, d.days);
  });
}

/**
 * The same pull on OUR connection, from an ads client's page: leads of the campaigns we run for the
 * client land in the client's CRM. Allowed for whoever manages that client's CRM connection.
 */
export async function syncClientLeads(input: unknown) {
  return runAction(META_ROLES, z.object({ clientId: z.uuid() }), input, async (d, { supabase }) => {
    // Both reads authorize: the client is ours, and the caller may manage its CRM's Facebook leads.
    const [meta, detail] = await Promise.all([
      supabase.rpc("ads_client_crm_meta", { p_client: d.clientId }),
      supabase.rpc("ads_client_detail", { p_id: d.clientId }),
    ]);
    const agencyId = (detail.data as { company_id?: string } | null)?.company_id;
    if (meta.error || detail.error || !meta.data || !agencyId) return FORBIDDEN;
    return pullRecentLeads(agencyId);
  });
}

type PullResult = {
  found: number; created: number; duplicate: number; failed: number; skipped: number; routed: number;
  /** New leads per company they went to, most first. */
  companies: { id: string; name: string; created: number }[];
};

async function pullRecentLeads(companyId: string, days: SyncDays = 7): Promise<ActionResult<PullResult>> {
  const secrets = await loadMetaSecrets(companyId);
  if (!secrets) return { ok: false, error: "Save the connection details first." };
  // Leads already in the CRM are skipped with one cheap check, so a long sync mostly costs the new ones.
  const maxLeads = days === 7 ? 500 : 3000;
  try {
    const { token } = await pageToken(secrets);
    const since = Math.floor(Date.now() / 1000) - days * 24 * 3600;
    // Every form of the Page (older ones too: their leads may still be within the period).
    const forms: { id: string; name?: string }[] = [];
    let formsAfter: string | undefined;
    do {
      const page = await graph<{ data: { id: string; name?: string }[]; paging?: { cursors?: { after?: string }; next?: string } }>(`${secrets.page_id}/leadgen_forms`, token, {
        params: { fields: "id,name", limit: "100", ...(formsAfter ? { after: formsAfter } : {}) },
      });
      forms.push(...(page.data ?? []));
      formsAfter = page.paging?.next && forms.length < 500 ? page.paging.cursors?.after : undefined;
    } while (formsAfter);
    const items: { leadgenId: string; formId: string; lead: MetaLead }[] = [];
    // Each form's leads come 100 per request with their answers; follow the pages up to maxLeads in all.
    forms: for (const form of forms) {
      let after: string | undefined;
      do {
        const page = await graph<{ data: MetaLead[]; paging?: { cursors?: { after?: string }; next?: string } }>(`${form.id}/leads`, token, {
          params: {
            fields: "id,created_time,form_id,ad_id,ad_name,adset_id,campaign_id,campaign_name,field_data", limit: "100",
            filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since }]),
            ...(after ? { after } : {}),
          },
        });
        for (const lead of page.data ?? []) items.push({ leadgenId: lead.id, formId: form.id, lead: { ...lead, form_id: lead.form_id ?? form.id } });
        if (items.length >= maxLeads) break forms;
        after = page.paging?.next ? page.paging.cursors?.after : undefined;
      } while (after);
    }
    // Saved 100 per database call; each owner gets one alert for the lot.
    const formNames = new Map(forms.filter((f) => f.name).map((f) => [f.id, f.name!]));
    const { byCompany, ...result } = await ingestLeadgensBulk(companyId, secrets, items, formNames);
    const ids = Object.keys(byCompany);
    const { data: names } = ids.length ? await createAdminClient().from("companies").select("id, name").in("id", ids) : { data: [] };
    const companies = ids.map((id) => ({ id, name: names?.find((n) => n.id === id)?.name ?? "Another CRM", created: byCompany[id] }))
      .sort((a, b) => b.created - a.created || a.name.localeCompare(b.name));
    return { ok: true, data: { found: items.length, ...result, companies } };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Couldn't reach Meta.";
    // A dead token: show it on the connection too, instead of the last successful test.
    if (message.includes("Error validating access token")) {
      await createAdminClient().rpc("set_meta_status", { p_company_id: companyId, p_status: "error", p_error: message.slice(0, 500) });
      return { ok: false, error: "Our Facebook token no longer works. Make a new system user token and save it under Automation → Manage, then press Connect & test." };
    }
    return { ok: false, error: `Meta: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// One Facebook connection per company: the same Meta app and token serve the Page's lead forms
// (Page ID) and the Ads dashboard (ad account ID). Either or both can be set.
// ---------------------------------------------------------------------------
const optionalId = (re: RegExp) => z.union([z.literal(""), z.string().trim().regex(re, "Digits only, as shown in Meta")]).optional();

export async function saveFacebookConnection(input: unknown) {
  const schema = z.object({
    companyId: z.uuid(), appId: metaId, pageId: optionalId(/^\d{5,25}$/), actId: optionalId(/^(act_)?\d{5,25}$/),
    appSecret: z.string().trim().max(200).optional(), accessToken: z.string().trim().max(1000).optional(),
  });
  return runAction(META_ROLES, schema, input, async (d, { supabase }) => {
    if (!(await canManage(supabase, d.companyId))) return FORBIDDEN;
    if (!d.pageId && !d.actId) return { ok: false, error: "Enter the Page ID, the ad account ID, or both." };
    const secrets = { p_app_secret: d.appSecret || undefined, p_access_token: d.accessToken || undefined };
    if (d.pageId) {
      const { error } = await supabase.rpc("save_meta_integration", { p_company_id: d.companyId, p_app_id: d.appId, p_page_id: d.pageId, ...secrets });
      if (error) return dbError(error);
    }
    if (d.actId) {
      const save = (useLeadApp: boolean) => supabase.rpc("save_ad_account", {
        p_kind: "company", p_owner: d.companyId, p_act_id: d.actId!, p_app_id: d.appId, ...secrets, p_use_lead_app: useLeadApp,
      });
      let { error } = await save(false);
      // Secrets not retyped for a new ad account: reuse the ones just saved for the Page.
      if (error?.message.startsWith("meta_secrets_required") && d.pageId) ({ error } = await save(true));
      if (error) return dbError(error);
    }
    return { ok: true, data: undefined };
  });
}

/**
 * Connects an ads client's own Facebook Page to their CRM with our Meta app and token, so only the
 * Page ID is typed. The database checks the caller and copies the secrets; then press Connect & test.
 */
export async function connectClientPage(input: unknown) {
  return runAction(META_ROLES, z.object({ clientId: z.uuid(), pageId: metaId }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("connect_client_page", { p_client: d.clientId, p_page_id: d.pageId });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

async function companyAdAccountId(companyId: string) {
  const { data } = await createAdminClient().from("ad_accounts").select("id")
    .eq("company_id", companyId).eq("kind", "company").is("archived_at", null).maybeSingle();
  return data?.id ?? null;
}

/** Checks lead forms (Page + webhook) and the ad account; a working ad account starts its first sync. */
export async function testFacebookConnection(input: unknown) {
  return runAction(META_ROLES, z.object({ companyId: z.uuid() }), input, async (d, { supabase }) => {
    if (!(await canManage(supabase, d.companyId))) return FORBIDDEN;
    const leads = await checkLeadConnection(d.companyId);
    const accountId = await companyAdAccountId(d.companyId);
    const ads = accountId ? await checkAdAccount(accountId) : null;
    if (!leads && !ads) return { ok: false, error: "Save the connection first." };
    if (accountId && ads?.connected) after(() => syncAdAccount(accountId).then(() => undefined));
    return { ok: true, data: { leads, ads } };
  });
}

/** Stops lead forms and ad syncing and deletes the saved secrets. Leads and synced ad history stay. */
export async function removeFacebookConnection(input: unknown) {
  return runAction(META_ROLES, z.object({ companyId: z.uuid() }), input, async (d, { supabase }) => {
    if (!(await canManage(supabase, d.companyId))) return FORBIDDEN;
    const { error } = await supabase.rpc("delete_meta_integration", { p_company_id: d.companyId });
    if (error) return dbError(error);
    const accountId = await companyAdAccountId(d.companyId);
    if (accountId) {
      const res = await supabase.rpc("disconnect_ad_account", { p_account: accountId });
      if (res.error) return dbError(res.error);
    }
    return { ok: true, data: undefined };
  });
}
