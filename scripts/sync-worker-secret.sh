#!/usr/bin/env bash
# Gives the reminder worker one fresh secret in both places that must match:
#   1. the Edge Function secret REMINDER_WORKER_SECRET (checked by supabase/functions/reminder-worker)
#   2. the Vault secret crm_reminder_worker_secret (sent by private.invoke_reminder_worker via pg_net)
# If they differ, every worker call answers 401 and no Telegram/WhatsApp alert is ever sent.
# Needs a linked Supabase project (npx supabase link). Run from the repo root; nothing is printed.
set -euo pipefail

secret="$(openssl rand -hex 32)"
npx -y supabase secrets set "REMINDER_WORKER_SECRET=${secret}" >/dev/null
npx -y supabase db query --linked \
  "select vault.update_secret((select id from vault.secrets where name = 'crm_reminder_worker_secret'), '${secret}')" >/dev/null 2>&1

# Keep the local copy in step (used only for manual checks).
if [ -f .env ] && grep -q '^REMINDER_WORKER_SECRET=' .env; then
  sed -i.bak "s/^REMINDER_WORKER_SECRET=.*/REMINDER_WORKER_SECRET=${secret}/" .env && rm -f .env.bak
fi
echo "Worker secret updated in Supabase secrets and Vault."
