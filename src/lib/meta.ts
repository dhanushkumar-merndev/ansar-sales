import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizePhone } from "@/lib/phone";

/** Graph API version used for every call. Meta supports each version for about two years. */
export const GRAPH_VERSION = "v23.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** Checks Meta's X-Hub-Signature-256 header: HMAC-SHA256 of the raw body with the app secret. */
export function verifyMetaSignature(rawBody: string, header: string | null, appSecret: string) {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex"), "utf8");
  const given = Buffer.from(header.slice("sha256=".length), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export class GraphError extends Error {}

/** One Graph API call. Errors carry Meta's own message (never the token). */
export async function graph<T>(path: string, token: string, init?: { method?: "GET" | "POST"; params?: Record<string, string> }): Promise<T> {
  const url = new URL(`${GRAPH}/${path.replace(/^\//, "")}`);
  const params = new URLSearchParams({ ...(init?.params ?? {}), access_token: token });
  const method = init?.method ?? "GET";
  if (method === "GET") url.search = params.toString();
  const res = await fetch(url, {
    method,
    ...(method === "POST" ? { body: params, headers: { "Content-Type": "application/x-www-form-urlencoded" } } : {}),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
  if (!res.ok || body.error) throw new GraphError((body.error?.message ?? `Meta returned ${res.status}`).slice(0, 300));
  return body;
}

export type LeadgenChange = { leadgenId: string; formId: string | null; pageId: string | null };

/** The `leadgen` changes of a Page webhook payload. */
export function leadgenChanges(payload: unknown): LeadgenChange[] {
  const out: LeadgenChange[] = [];
  const entries = (payload as { object?: string; entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    for (const change of ((entry as { changes?: unknown[] }).changes ?? []) as { field?: string; value?: Record<string, unknown> }[]) {
      const v = change.value ?? {};
      if (change.field !== "leadgen" || v.leadgen_id === undefined) continue;
      out.push({ leadgenId: String(v.leadgen_id), formId: v.form_id ? String(v.form_id) : null, pageId: v.page_id ? String(v.page_id) : null });
    }
  }
  return out.slice(0, 50);
}

export type MetaLead = {
  id: string; created_time?: string; form_id?: string; ad_id?: string; ad_name?: string; adset_id?: string; campaign_id?: string; campaign_name?: string;
  field_data?: { name: string; values: string[] }[];
};

const NAME_FIELDS = ["full_name", "name", "full name"];
const PHONE_FIELDS = ["phone_number", "phone", "mobile_number", "mobile", "whatsapp_number"];
const EMAIL_FIELDS = ["email", "email_address"];

/** Maps a lead's form answers to CRM fields; other answers become readable lines for a note. */
export function mapLeadFields(lead: MetaLead) {
  const fields = new Map((lead.field_data ?? []).map((f) => [f.name.toLowerCase(), (f.values ?? []).join(", ").trim()]));
  const pick = (keys: string[]) => keys.map((k) => fields.get(k)).find((v) => v) ?? null;
  const first = fields.get("first_name");
  const last = fields.get("last_name");
  const name = pick(NAME_FIELDS) ?? ([first, last].filter(Boolean).join(" ") || null);
  const rawPhone = pick(PHONE_FIELDS);
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  const email = pick(EMAIL_FIELDS);
  const used = new Set([...NAME_FIELDS, ...PHONE_FIELDS, ...EMAIL_FIELDS, "first_name", "last_name"]);
  const answers = [...fields.entries()]
    .filter(([k, v]) => !used.has(k) && v)
    .map(([k, v]) => `${k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}: ${v}`)
    .join("\n");
  return { name, phone, rawPhone, email, answers: answers || null };
}
