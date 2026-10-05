// Browser-safe values must be referenced literally so Next.js can inline them.
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
};

/** Reads a server-only variable at call time; never import this from client code. */
export function serverEnv(name: "SUPABASE_SECRET_KEY" | "AUTH_LOGIN_DOMAIN" | "TELEGRAM_BOT_TOKEN" | "TELEGRAM_BOT_USERNAME" | "TELEGRAM_WEBHOOK_SECRET") {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required server environment variable ${name}`);
  return value;
}

export function isSupabaseConfigured() {
  return Boolean(publicEnv.supabaseUrl && publicEnv.supabasePublishableKey);
}
