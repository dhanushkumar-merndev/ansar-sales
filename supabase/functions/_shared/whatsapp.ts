// WhatsApp Cloud API helpers shared by the reminder worker, the WhatsApp webhook (Edge Functions) and the
// app's tests. Pure TypeScript: no imports, no Deno or Node APIs except Web Crypto (both have it).
//
// Free sending relies on WhatsApp's 24-hour window: free-form messages are allowed (and free) for 24 hours
// after the person last wrote to the business number. The database decides whether the window is open;
// these helpers only build and read messages.

export const GRAPH_VERSION = "v23.0";

/** The same shape as the worker's Telegram message (text and one row of buttons). */
type Button = { text: string; url: string } | { text: string; callback_data: string };
export type PlainMessage = { text: string; buttons: Button[][] };

/** A reply button the person can tap: it comes back to the webhook as a message (and renews the window). */
export type ReplyButton = { id: string; title: string };

/** What we send: text, text with reply buttons, or text with one link button. */
export type WaMessage =
  | { kind: "text"; text: string }
  | { kind: "buttons"; text: string; buttons: ReplyButton[] }
  | { kind: "link"; text: string; label: string; url: string };

export const KEEP_BUTTON: ReplyButton = { id: "keep", title: "Keep alerts on" };
export const SUMMARY_BUTTON: ReplyButton = { id: "summary", title: "Today's summary" };
const SILENCE_PREFIX = "silence:";
const TELEGRAM_SILENCE_PREFIX = "s:";

// WhatsApp limits: interactive body 1024 characters, plain text 4096, button and link titles 20.
const BODY_MAX = 1024;
const TEXT_MAX = 4096;
const TITLE_MAX = 20;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** Telegram link buttons are labelled "🔗 Open lead"; WhatsApp shows its own link icon. */
const label = (s: string) => clip(s.replace(/^🔗\s*/, ""), TITLE_MAX);

/**
 * The worker's message (built for Telegram) as a WhatsApp message.
 * - A link button becomes WhatsApp's "Open in CRM" link button.
 * - Silence (overdue alerts) becomes reply buttons (Silence and Keep alerts on); WhatsApp can't mix those
 *   with a link button, so the link goes in the text.
 */
export function toWhatsApp(m: PlainMessage): WaMessage {
  const buttons = m.buttons.flat();
  const link = buttons.find((b): b is { text: string; url: string } => "url" in b);
  const silence = buttons.find((b): b is { text: string; callback_data: string } => "callback_data" in b && b.callback_data.startsWith(TELEGRAM_SILENCE_PREFIX));
  if (silence) {
    const text = link ? `${m.text}\n\n${link.url}` : m.text;
    return {
      kind: "buttons",
      text: clip(text, BODY_MAX),
      buttons: [{ id: `${SILENCE_PREFIX}${silence.callback_data.slice(TELEGRAM_SILENCE_PREFIX.length)}`, title: "🔕 Silence" }, KEEP_BUTTON],
    };
  }
  if (link) return { kind: "link", text: clip(m.text, BODY_MAX), label: label(link.text), url: link.url };
  return { kind: "text", text: clip(m.text, TEXT_MAX) };
}

/** The Cloud API request body for one message to `to` (a wa_id). */
export function messageBody(to: string, m: WaMessage) {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  if (m.kind === "text") return { ...base, type: "text", text: { body: m.text, preview_url: false } };
  if (m.kind === "link") {
    return {
      ...base,
      type: "interactive",
      interactive: { type: "cta_url", body: { text: m.text }, action: { name: "cta_url", parameters: { display_text: m.label, url: m.url } } },
    };
  }
  return {
    ...base,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: m.text },
      action: { buttons: m.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 256), title: clip(b.title, TITLE_MAX) } })) },
    },
  };
}

/** The optional paid template (a utility template with no variables, approved in Meta). */
export function templateBody(to: string, name: string, language: string) {
  return { messaging_product: "whatsapp", recipient_type: "individual", to, type: "template", template: { name, language: { code: language } } };
}

/** About an hour before the window closes: one free message with buttons, any tap renews it. */
export function nudgeMessage(name: string): WaMessage {
  return {
    kind: "buttons",
    text: `Hi ${name}, WhatsApp only lets the CRM message you for 24 hours after your last message. Tap below (or send anything) to keep your alerts coming for another day.`,
    buttons: [KEEP_BUTTON, SUMMARY_BUTTON],
  };
}

export const LINKED_TEXT = (name: string) =>
  `✅ Connected, ${name}. Your CRM alerts will come here.\n\nWhatsApp lets the CRM message you for 24 hours after your last message, so once a day we'll ask you to tap “Keep alerts on”. If you miss it, alerts wait until you send anything.`;
export const NOT_LINKED_TEXT = "This number isn't linked to the CRM. Open Settings in the CRM and use “Connect WhatsApp”.";
export const BAD_CODE_TEXT = "That code is wrong or has expired. Make a new one in CRM Settings → Connect WhatsApp.";

// ----- Linking ----------------------------------------------------------------------

const CODE = /^[A-HJ-NP-Z2-9]{6}$/;

/** The one-time code in a message ("Link my CRM: 7KQ2PX"), if any. Codes always mix letters and digits. */
export function extractLinkCode(text: string | null | undefined): string | null {
  for (const token of (text ?? "").toUpperCase().split(/[^A-Z0-9]+/)) {
    if (CODE.test(token) && /[0-9]/.test(token) && /[A-Z]/.test(token)) return token;
  }
  return null;
}

/** wa.me link that opens WhatsApp with the code typed in. `number` in any format; digits are kept. */
export function buildLinkUrl(number: string, code: string) {
  return `https://wa.me/${number.replace(/\D/g, "")}?text=${encodeURIComponent(`Link my CRM: ${code}`)}`;
}

// ----- Webhook ----------------------------------------------------------------------

export type Inbound = { from: string; text: string | null; buttonId: string | null };
export type StatusReport = { id: string; status: string; errorCode: number | null };

type WebhookValue = {
  metadata?: { phone_number_id?: string };
  messages?: {
    from?: string; type?: string; text?: { body?: string };
    interactive?: { button_reply?: { id?: string }; list_reply?: { id?: string } };
    button?: { payload?: string; text?: string };
  }[];
  statuses?: { id?: string; status?: string; errors?: { code?: number }[] }[];
};

/** Messages and delivery reports in a webhook call, for our number only (when `phoneNumberId` is given). */
export function parseWebhook(body: unknown, phoneNumberId?: string | null): { messages: Inbound[]; statuses: StatusReport[] } {
  const messages: Inbound[] = [];
  const statuses: StatusReport[] = [];
  const entries = (body as { object?: string; entry?: { changes?: { field?: string; value?: WebhookValue }[] }[] })?.entry;
  if ((body as { object?: string })?.object !== "whatsapp_business_account" || !Array.isArray(entries)) return { messages, statuses };
  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value;
      if (change?.field !== "messages" || !v) continue;
      if (phoneNumberId && v.metadata?.phone_number_id && v.metadata.phone_number_id !== phoneNumberId) continue;
      for (const m of v.messages ?? []) {
        if (typeof m?.from !== "string" || !/^[0-9]{6,20}$/.test(m.from)) continue;
        messages.push({
          from: m.from,
          text: m.text?.body ?? m.button?.text ?? null,
          buttonId: m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? m.button?.payload ?? null,
        });
      }
      for (const s of v.statuses ?? []) {
        if (typeof s?.id !== "string" || typeof s.status !== "string") continue;
        statuses.push({ id: s.id, status: s.status, errorCode: typeof s.errors?.[0]?.code === "number" ? s.errors[0].code : null });
      }
    }
  }
  return { messages, statuses };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a tapped button (or a typed word) asks for. */
export function parseAction(m: Inbound): { type: "keep" } | { type: "summary" } | { type: "silence"; followUpId: string } | { type: "other" } {
  const id = m.buttonId ?? "";
  if (id === KEEP_BUTTON.id) return { type: "keep" };
  if (id === SUMMARY_BUTTON.id) return { type: "summary" };
  if (id.startsWith(SILENCE_PREFIX) && UUID.test(id.slice(SILENCE_PREFIX.length))) return { type: "silence", followUpId: id.slice(SILENCE_PREFIX.length) };
  return { type: "other" };
}

// ----- Sending results ------------------------------------------------------------------

export type WaOutcome =
  | { result: "sent"; externalId: string | null }
  | { result: "retry"; error: string; retryAfterSeconds: number | null; rateLimited: boolean }
  | { result: "failed"; error: string }
  | { result: "blocked"; error: string }
  | { result: "hold"; error: string };

type GraphBody = { messages?: { id?: string }[]; error?: { code?: number; message?: string; error_data?: { details?: string } } };

const clean = (s: string) => s.replace(/https?:\/\/\S+/g, "<url>").replace(/\b\d{8,}\b/g, "<number>").slice(0, 250);

/** Maps a Cloud API response to what the worker records. `status` 0 = network error or timeout. */
export function classifyWhatsAppResult(status: number, body: GraphBody | null): WaOutcome {
  if (status >= 200 && status < 300 && body?.messages?.length) return { result: "sent", externalId: body.messages[0]?.id ?? null };
  const code = body?.error?.code ?? null;
  const message = clean(body?.error?.message ?? (status === 0 ? "network error" : `HTTP ${status}`));
  const error = code ? `whatsapp ${code}: ${message}` : message;
  // The 24-hour window had closed: wait for the person to write.
  if (code === 131047) return { result: "hold", error: "whatsapp_window_closed" };
  // Throughput / pair / spam rate limits.
  if (code === 130429 || code === 131056 || code === 131048 || code === 80007 || status === 429) {
    return { result: "retry", error, retryAfterSeconds: code === 131056 ? 120 : 60, rateLimited: true };
  }
  if (code === 131026) return { result: "blocked", error: "whatsapp_undeliverable" };
  if (code === 190) return { result: "failed", error: "whatsapp_token_invalid" };
  if (code === 131030) return { result: "failed", error: "whatsapp_test_number_not_allowed" };
  if (status === 0 || status >= 500 || code === 1 || code === 2 || code === 131000 || code === 131016) {
    return { result: "retry", error, retryAfterSeconds: null, rateLimited: false };
  }
  return { result: "failed", error };
}

// ----- Webhook signature ----------------------------------------------------------------

/** Checks Meta's X-Hub-Signature-256 header: HMAC-SHA256 of the raw body with the app secret. */
export async function verifySignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header?.startsWith("sha256=") || !appSecret) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  return safeEqual(header.slice("sha256=".length).toLowerCase(), expected);
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
