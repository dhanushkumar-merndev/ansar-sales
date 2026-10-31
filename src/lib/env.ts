// Browser-safe values must be referenced literally so Next.js can inline them.
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
};

/** Reads a server-only variable at call time; never import this from client code. */
export function serverEnv(
  name:
    | "SUPABASE_SECRET_KEY" | "AUTH_LOGIN_DOMAIN" | "TELEGRAM_BOT_TOKEN" | "TELEGRAM_BOT_USERNAME" | "TELEGRAM_WEBHOOK_SECRET"
    | "TIGRIS_STORAGE_ACCESS_KEY_ID" | "TIGRIS_STORAGE_SECRET_ACCESS_KEY" | "TIGRIS_STORAGE_BUCKET"
    | "WHATSAPP_BUSINESS_NUMBER",
) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required server environment variable ${name}`);
  return value;
}

export function isSupabaseConfigured() {
  return Boolean(publicEnv.supabaseUrl && publicEnv.supabasePublishableKey);
}

/** The CRM's WhatsApp business number (digits), or null when WhatsApp isn't set up. Server only. */
export function whatsappNumber(): string | null {
  const digits = (process.env.WHATSAPP_BUSINESS_NUMBER ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}
