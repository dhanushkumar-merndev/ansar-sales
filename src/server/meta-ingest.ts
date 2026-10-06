import "server-only";
import { GraphError, graph, mapLeadFields, type MetaLead } from "@/lib/meta";
import { createAdminClient } from "@/lib/supabase/admin";

export type MetaSecrets = { app_id: string; page_id: string; verify_token: string; app_secret: string; access_token: string };

const LEAD_FIELDS = "id,created_time,form_id,ad_id,ad_name,adset_id,campaign_id,campaign_name,field_data";

/** A company's Meta settings with its secrets (service role; call only from verified server code). */
export async function loadMetaSecrets(companyId: string): Promise<MetaSecrets | null> {
  const { data, error } = await createAdminClient().rpc("meta_integration_secrets", { p_company_id: companyId }).maybeSingle();
  if (error || !data) return null;
  const s = data as MetaSecrets;
  return s.app_secret && s.access_token ? s : null;
}

/** The Page access token, from the (non-expiring) system-user token. */
export async function pageToken(secrets: MetaSecrets) {
  const page = await graph<{ id: string; name: string; access_token?: string }>(secrets.page_id, secrets.access_token, { params: { fields: "name,access_token" } });
  if (!page.access_token) throw new GraphError("The token can't manage this Page. Assign the Page to the system user with full control.");
  return { token: page.access_token, name: page.name };
}

/**
 * Fetches each lead from Meta and turns it into a CRM lead (idempotent per leadgen id).
 * Uses the admin client: this runs for a verified webhook or a super admin's sync, not as a user.
 */
export async function ingestLeadgens(companyId: string, secrets: MetaSecrets, leads: { leadgenId: string; formId: string | null; lead?: MetaLead }[]) {
  const admin = createAdminClient();
  const forms = new Map<string, string | null>();
  let token: string | null = null;
  const result = { created: 0, duplicate: 0, failed: 0, skipped: 0 };

  for (const item of leads) {
    const { data: pending } = await admin.rpc("record_meta_leadgen", { p_company_id: companyId, p_leadgen_id: item.leadgenId, p_form_id: item.formId ?? undefined });
    if (!pending) { result.skipped += 1; continue; }
    try {
      token ??= (await pageToken(secrets)).token;
      const lead = item.lead ?? await graph<MetaLead>(item.leadgenId, token, { params: { fields: LEAD_FIELDS } });
      const formId = lead.form_id ?? item.formId;
      if (formId && !forms.has(formId)) {
        forms.set(formId, await graph<{ name?: string }>(formId, token, { params: { fields: "name" } }).then((f) => f.name ?? null).catch(() => null));
      }
      const f = mapLeadFields(lead);
      const { data, error } = await admin.rpc("ingest_meta_lead", {
        p_company_id: companyId,
        p_leadgen_id: item.leadgenId,
        p_name: f.name ?? "Facebook lead",
        p_phone: f.phone?.display ?? f.rawPhone ?? "",
        p_phone_normalized: f.phone?.e164 ?? (null as unknown as string),
        p_email: f.email ?? undefined,
        p_form_id: formId ?? undefined,
        p_form_name: formId ? (forms.get(formId) ?? undefined) : undefined,
        p_ad_name: lead.ad_name,
        p_campaign_name: lead.campaign_name,
        p_answers: f.answers ?? undefined,
      });
      if (error) throw new Error(error.message);
      // Remembered so Lead Ads insights can show spend and cost per lead per campaign.
      if (lead.campaign_id || lead.ad_id) {
        await admin.rpc("set_meta_lead_ad_ids", {
          p_company_id: companyId, p_leadgen_id: item.leadgenId,
          p_campaign_id: lead.campaign_id ?? "", p_adset_id: lead.adset_id ?? "", p_ad_id: lead.ad_id ?? "",
        });
      }
      const state = (data as { state: "created" | "duplicate" | "failed" }).state;
      result[state] += 1;
    } catch (e) {
      result.failed += 1;
      await admin.rpc("fail_meta_lead", { p_company_id: companyId, p_leadgen_id: item.leadgenId, p_error: e instanceof Error ? e.message : "Unknown error" });
    }
  }
  return result;
}
