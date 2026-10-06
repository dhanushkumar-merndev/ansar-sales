function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`E2E: missing environment variable ${name} (see README → End-to-end tests)`);
  return value;
}

export const env = {
  get supabaseUrl() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get publishableKey() {
    return required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  },
  get secretKey() {
    return required("SUPABASE_SECRET_KEY");
  },
  get loginDomain() {
    return required("AUTH_LOGIN_DOMAIN");
  },
  get webhookSecret() {
    return process.env.TELEGRAM_WEBHOOK_SECRET ?? null;
  },
  get botUsername() {
    return process.env.TELEGRAM_BOT_USERNAME ?? null;
  },
  keepData: process.env.E2E_KEEP_DATA === "1",
  runWorker: process.env.E2E_WORKER === "1",
};
