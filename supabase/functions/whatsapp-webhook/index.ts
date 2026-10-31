// WhatsApp webhook (Meta calls it for every message to the business number and for delivery reports).
// Runs on Supabase, not Vercel: delivery reports arrive for every message sent, so this keeps that traffic
// off the app. Meta can't send a Supabase token, so verify_jwt is off and Meta's signature
// (X-Hub-Signature-256, HMAC of the raw body with the app secret) is the authentication.
//
// Every reply here is free: it goes out inside the 24-hour window the person's own message just opened.
import { createClient } from "npm:@supabase/supabase-js@2";
import { dashboardLines, type BotSummary } from "../_shared/bot-summary.ts";
import {
  BAD_CODE_TEXT, extractLinkCode, GRAPH_VERSION, LINKED_TEXT, messageBody, NOT_LINKED_TEXT, parseAction, parseWebhook, safeEqual,
  SUMMARY_BUTTON, KEEP_BUTTON, verifySignature, type WaMessage,
} from "../_shared/whatsapp.ts";

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>;
  return keys.default ?? Object.values(keys)[0] ?? "";
}

const env = (name: string) => Deno.env.get(name) ?? "";

/** Best effort: the CRM records delivery state for alerts; a lost bot reply is not worth a retry storm. */
async function reply(to: string, m: WaMessage) {
  const token = env("WHATSAPP_ACCESS_TOKEN");
  const numberId = env("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !numberId) return;
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${numberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(messageBody(to, m)),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error("reply failed", res.status);
  } catch {
    console.error("reply failed: network");
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Meta's one-time check when the webhook URL is saved.
  if (req.method === "GET") {
    const verify = env("WHATSAPP_VERIFY_TOKEN");
    const ok = !!verify && url.searchParams.get("hub.mode") === "subscribe" && safeEqual(url.searchParams.get("hub.verify_token") ?? "", verify);
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 }) : new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const appSecret = env("WHATSAPP_APP_SECRET");
  if (!appSecret) return new Response("Not configured", { status: 503 });
  const raw = await req.text();
  if (raw.length > 1_000_000 || !(await verifySignature(raw, req.headers.get("x-hub-signature-256"), appSecret))) {
    return new Response("Unauthorized", { status: 401 });
  }
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("ok");
  }

  const supabase = createClient(env("SUPABASE_URL"), serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const appUrl = env("APP_URL") || null;
  const { messages, statuses } = parseWebhook(body, env("WHATSAPP_PHONE_NUMBER_ID") || null);

  // Delivery reports: only failures change anything (window closed → wait again; undeliverable → blocked).
  // They run alongside the replies so a report never delays a reply.
  const reports = Promise.all(statuses.filter((s) => s.status === "failed").map(async (s) => {
    const { error } = await supabase.rpc("whatsapp_delivery_status", { p_external_id: s.id, p_status: s.status, p_error_code: s.errorCode ?? undefined });
    if (error) console.error("status failed", error.code);
  }));

  for (const m of messages.slice(0, 20)) {
    const code = extractLinkCode(m.text);
    const action = parseAction(m);
    // A typed message or "Today's summary" gets the dashboard: fetch it at the same time as recording the
    // message instead of one after the other (each database round trip is the slow part).
    const wantsSummary = !code && (action.type === "other" || action.type === "summary");
    const [inbound, summary] = await Promise.all([
      supabase.rpc("whatsapp_inbound", { p_wa_id: m.from, p_code: code ?? undefined }),
      wantsSummary ? supabase.rpc("whatsapp_bot_summary", { p_wa_id: m.from }) : Promise.resolve(null),
    ]);
    if (inbound.error) {
      console.error("inbound failed", inbound.error.code);
      continue;
    }
    const r = (inbound.data ?? {}) as { connected?: boolean; linked?: boolean; name?: string; released?: number; code_invalid?: boolean; active?: boolean };
    if (!r.connected) {
      await reply(m.from, { kind: "text", text: r.code_invalid ? BAD_CODE_TEXT : NOT_LINKED_TEXT });
      continue;
    }
    if (r.linked) {
      await reply(m.from, { kind: "buttons", text: LINKED_TEXT(r.name ?? ""), buttons: [SUMMARY_BUTTON] });
      continue;
    }

    if (action.type === "silence") {
      const { data: s } = await supabase.rpc("whatsapp_silence_nag", { p_wa_id: m.from, p_follow_up_id: action.followUpId });
      const ok = (s as { ok?: boolean; lead_name?: string } | null)?.ok;
      await reply(m.from, { kind: "text", text: ok ? `🔕 Overdue alerts silenced for ${(s as { lead_name: string }).lead_name}.` : "This alert can't be silenced from this number." });
      continue;
    }
    const waiting = r.released ? `📬 Sending your ${r.released} waiting alert${r.released === 1 ? "" : "s"} now.` : null;
    const elsewhere = r.active === false ? "Your alerts currently go to Telegram. Switch in CRM Settings to get them here." : null;
    if (action.type === "keep") {
      await reply(m.from, { kind: "text", text: [waiting ?? "👍 Your CRM alerts stay on for the next 24 hours.", elsewhere].filter(Boolean).join("\n\n") });
      continue;
    }
    // Anything else (a typed message or "Today's summary"): the same dashboard summary the Telegram bot shows.
    const sum = (summary?.data ?? null) as BotSummary | null;
    const lines = sum?.connected ? dashboardLines(sum, appUrl) : [`Hi ${r.name ?? ""}`];
    await reply(m.from, {
      kind: "buttons",
      text: [...lines, ...(waiting ? ["", waiting] : []), ...(elsewhere ? ["", elsewhere] : [])].join("\n").slice(0, 1024),
      buttons: [SUMMARY_BUTTON, KEEP_BUTTON],
    });
  }
  await reports;

  // Always 200 once the signature is valid, so Meta does not retry.
  return new Response("ok");
});
