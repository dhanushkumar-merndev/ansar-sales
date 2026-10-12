# Simple CRM

Internal CRM for one business: leads with creatable niches, notes and an activity timeline, follow-ups with Telegram reminders, capital and expense tracking, and role-based dashboards.

**Stack:** Next.js 16 (App Router, Cache Components) · React 19 · TypeScript · Supabase (Postgres, Auth, Realtime, Cron, Edge Functions) · shadcn/ui + Tailwind 4 · Apache ECharts · Vercel.

Roles: **admin** (everything), **sales** (own leads and follow-ups), **account** (finance only). All access is enforced in PostgreSQL with Row Level Security and is checked again in every server action.

---

## 1. Local setup

```bash
pnpm install
cp .env.example .env.local      # then fill in the values (see comments in the file)
```

### Supabase project

1. Create a project at supabase.com. Copy the **Project URL**, the **publishable key** (`sb_publishable_…`) and a **secret key** (`sb_secret_…`) into `.env.local`.
2. Apply the migrations in `supabase/migrations/` (in filename order):
   ```bash
   pnpm dlx supabase login
   pnpm dlx supabase link --project-ref <your-project-ref>
   pnpm dlx supabase db push
   ```
   If you don't use the CLI, paste each file into **SQL Editor** in order: `…0100_schema.sql`, `…0200_security_and_triggers.sql`, `…0300_rpc.sql`, `…0400_realtime_and_cron.sql`.
3. **Authentication → Sign In / Providers**:
   - Turn **off** "Allow new users to sign up". This blocks public signup in Auth itself, not just in the UI.
   - Email provider: turn off "Confirm email" and "Secure password change".
   - `supabase/config.toml` records the same settings. With the CLI you can run `pnpm dlx supabase config push` instead.
4. Set `AUTH_LOGIN_DOMAIN` to a domain or subdomain you own, such as `login.yourcompany.com`. Each username maps internally to `username@AUTH_LOGIN_DOMAIN`. No mail is ever sent there. Don't change this value after users exist.

### File storage (Tigris)

Library files, their previews and company logos live in one **private** [Tigris](https://www.tigrisdata.com) bucket (S3-compatible), not in Supabase Storage. Nobody can read the bucket without a URL signed by the app.

```bash
npx @tigrisdata/cli login                     # browser sign-in
npx @tigrisdata/cli buckets create <bucket> --access private --locations sin --enable-snapshots
npx @tigrisdata/cli access-keys create <app-name> --bucket <bucket> --role Editor
```

1. `sin` (Singapore) is the closest Tigris location to India; Tigris has no Mumbai region.
2. Put the key in `.env.local` as `TIGRIS_STORAGE_ACCESS_KEY_ID` / `TIGRIS_STORAGE_SECRET_ACCESS_KEY`, plus `TIGRIS_STORAGE_BUCKET=<bucket>` and `TIGRIS_STORAGE_ENDPOINT=https://t3.storage.dev`. The key is scoped to that one bucket; these are server-only (never `NEXT_PUBLIC_`).
3. Allow the app's origins to upload from the browser: `pnpm storage:cors` (uses `APP_URL`, `NEXT_PUBLIC_APP_URL` and localhost; pass more origins as arguments). Run it again when the production domain changes.
4. Moving from Supabase Storage (one time): `pnpm storage:migrate` copies every object from the Supabase `library` and `company-logos` buckets to `library/…` and `logos/…` in Tigris. Re-running skips what is already there; Supabase Storage is left untouched as a rollback copy until you delete those buckets by hand.

### First admin (one time)

```bash
pnpm bootstrap:admin --username owner --name "Owner Name"
```

The script prompts for the password without echoing it. You can also set `BOOTSTRAP_ADMIN_PASSWORD` for that single run. It refuses to run if an active admin already exists. Create every other user from **Users** in the app.

### Run

```bash
pnpm dev        # http://localhost:3000 → sign in with the admin username/password
```

---

## 2. Telegram reminders

1. In Telegram, create a bot with **@BotFather**. Put its token in `TELEGRAM_BOT_TOKEN` and its username, without `@`, in `TELEGRAM_BOT_USERNAME`.
2. Generate two random secrets, `openssl rand -hex 32` each:
   - `TELEGRAM_WEBHOOK_SECRET` (Next.js / Vercel)
   - `REMINDER_WORKER_SECRET` (Edge Function and Vault)
3. **Webhook (account linking).** Run this after deploying, because Telegram needs a public `https` URL:
   ```bash
   pnpm telegram:webhook     # uses NEXT_PUBLIC_APP_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
   ```
4. **Reminder worker (Edge Function):**
   ```bash
   cp supabase/functions/.env.example supabase/functions/.env   # fill in
   pnpm dlx supabase secrets set --env-file supabase/functions/.env
   pnpm dlx supabase functions deploy reminder-worker --no-verify-jwt
   ```
   `SUPABASE_URL` and the service key are injected automatically. The function rejects any call that lacks the `x-worker-secret` header.
5. **Scheduler secrets (Vault).** In SQL Editor, use the same worker secret:
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co', 'crm_project_url');
   select vault.create_secret('<REMINDER_WORKER_SECRET>', 'crm_reminder_worker_secret');
   ```
   Migration `…0400` enables `pg_cron` + `pg_net` and schedules two jobs:
   - **`crm-reminder-worker`** runs every minute. It calls the function only when a reminder is due.
   - **`crm-retention`** runs daily. It deletes finished delivery rows after 90 days and cron logs after 7 days.

   For the **Facebook Ads** sync, also set `ADS_SYNC_SECRET` in Vercel (`openssl rand -hex 32`) and add:
   ```sql
   select vault.create_secret('https://<your-app>.vercel.app', 'crm_app_url');
   select vault.create_secret('<ADS_SYNC_SECRET>', 'crm_ads_sync_secret');
   ```
   Migration `…9610` schedules **`crm-ads-sync`** (hourly at :23, calls `/api/ads/sync` only when an ad account is connected)
   and **`crm-ads-rollup`** (daily: per-ad days older than 90 days become monthly totals). Setup for Lead Ads, the ad
   account, ads managers and client logins is in `docs/meta-lead-ads.md` (also in the app under the setup guide).

   Check with `select jobname, schedule from cron.job;`.

**Connect a user:** **Settings → Connect Telegram** opens the bot with a single-use token valid for 15 minutes. Press **Start**, and the settings page shows *Connected*.

**Verify a delivery:**
1. Schedule a follow-up 2 minutes ahead on a lead you own, with Telegram connected.
2. Close the browser.
3. The message should arrive about 1 minute after the due time.
4. Inspect it in SQL:
   ```sql
   select state, attempts, last_error, sent_at from reminder_deliveries order by created_at desc limit 5;
   select status_code, content from net._http_response order by created desc limit 5;  -- worker HTTP calls
   ```

Delivery behaviour:
- Delivery is **at-least-once**. If the worker crashes after Telegram accepts a message but before the result is recorded, that reminder can be sent twice.
- Temporary failures (5xx, network, 429 `retry_after`) are retried up to 5 times with backoff.
- A blocked bot or a missing connection shows as *Reminder failed* in the CRM.

### Role-based notifications

Migration `…5000` adds these. Every message has an **Open in CRM** button, which needs `APP_URL` to be `https://`; otherwise the link is shown as text. Nobody is notified about their own action.

| Notification | Admin | Sales | Account |
| --- | --- | --- | --- |
| New lead · lead won/lost | ✓ | | |
| Lead assigned to you · someone scheduled/rescheduled your follow-up | ✓ | ✓ | |
| Overdue follow-up alert: every 5 min, 9 AM–9 PM IST, with a **🔕 Silence** button | ✓ | ✓ | |
| New library file | ✓ | ✓ | |
| Expense / capital added · monthly recurring expense | ✓ | | ✓ |
| Morning task list (9 AM IST) | ✓ | ✓ | |
| Daily team report per salesperson (8 PM IST) | ✓ | | |
| Monthly finance summary (1st, 9 AM IST) | ✓ | | ✓ |

- **Overdue alerts** stop when the follow-up is completed, cancelled or silenced. Rescheduling re-arms them for the new time.
- **Silence** only works from the assignee's own linked chat. The webhook needs `callback_query` updates, so **run `pnpm telegram:webhook` again after deploying this version.**
- **Preferences:** each user picks types under **Settings → Telegram notifications**. **Send test message** checks the whole path.
- **Scheduling:** the jobs **`crm-overdue-nags`** (every 5 min) and **`crm-digests`** (every 15 min) only queue messages. The every-minute worker delivers them.
- **Delivery-time recheck:** before sending, the worker checks role, preference and lead access again. A message for a lead that was reassigned or archived is skipped.

Inspect the queue:
```sql
select kind, state, attempts, last_error, created_at from telegram_notifications order by created_at desc limit 20;
```

---

## 3. Deploy to Vercel

1. Import the repository in Vercel. It detects Next.js; no `vercel.json` is needed.
2. Add the variables from `.env.example` under **Project → Settings → Environment Variables**, including the four `TIGRIS_STORAGE_*` values. Set `NEXT_PUBLIC_APP_URL` to the production URL, and make sure `pnpm storage:cors` included that origin.
3. Deploy, then run `pnpm telegram:webhook` once with the production `NEXT_PUBLIC_APP_URL`. Set `APP_URL` in the Edge Function secrets so reminder links point there.

Plan notes (checked 2026-10-05; recheck before deploying):
- Vercel **Hobby** is for personal, non-commercial use, so a business CRM needs **Pro**.
- No Vercel Cron is used. Reminders run on Supabase Cron.
- Supabase free projects pause after a week of inactivity and have quotas.
- The cron job invokes the Edge Function only when work is due, so it stays well under the 500k/month invocation allowance.

### Rolling out the Star Gardens projects module

Run these in order. The worker goes out first: the old worker has no message for the new alert kinds.

1. Deploy the new worker. It still handles all the old kinds:
   `pnpm dlx supabase functions deploy reminder-worker --no-verify-jwt`
2. Check what is already applied, then apply the rest:
   ```bash
   pnpm dlx supabase migration list   # Local vs Remote columns
   pnpm dlx supabase db push
   ```
   Never edit a migration that is already applied: `db push` skips it. Add a new migration instead.
   `src/lib/database.types.ts` is already generated from them (`pnpm db:types`). To compare it with the live schema: `pnpm dlx supabase gen types typescript --linked --schema public | diff - src/lib/database.types.ts`. Only formatting should differ.
   The migrations are `20261008000100`–`20261008002100`. On 2026-10-07, 0100–1100 were already on the live project. Until 1200–2100 are applied, these features fail with "needs a database update" or run in a reduced form:
   - 1200: recording payments
   - 1300: the phase history and end-date extensions
   - 1400: folders inside folders
   - 1500: the projects page's year/month folders (until then: counted from start dates, with no late counts or phase details)
   - 1600: the notification bell (until then it stays empty), separate In app / Telegram switches, and shared folder colours. After it, redeploy `reminder-worker`: its message text is now shared with the bell.
   - 1700: the Team page (what each person on a manager's projects is doing). It also limits the dashboard's team board to the manager's own people.
   - 1800: move project folders up and down (right-click in the folder tree).
   - 1900: Ads and Automation switched off for Star Gardens ("no_ads"; Super settings → Companies → Ads & automation).
   - 2000: archiving project folders (whoever made a folder, or a manager), and restoring or deleting them for good (admin or the architect manager).
   - 2100: note pins on DWG/DXF drawings (drawing coordinates) and pin colours. The drawing viewer itself works without it.

   Two details:
   - They run in order; the enum values come first, in files of their own.
   - The `crm-project-alerts` cron job (every 15 minutes) is created only if `pg_cron` is installed.
3. Run `pnpm storage:cors` so the bucket allows the multipart methods (POST, DELETE) and exposes `ETag`. Large uploads fail without it.
4. Deploy the app to Vercel. No new environment variables are needed.
5. In the app:
   - **Super settings → Companies → Star Gardens:** check "Projects" is on. The migration switches it on for a company named "Star Gardens".
   - **Users:** give people their roles: Architect manager, Landscape designer, Execution manager, and BDM (`sales`).
6. Smoke test:
   - Run `E2E_PROJECTS=1 pnpm test:e2e projects` (see §4).
   - Or by hand: hand a lead over, create a project, then upload, approve, sign in to the client portal and record a payment.
   - Then set a phase's deadline to yesterday. A `phase_overdue` Telegram message should arrive within about 15 minutes.

Demo data for trying it (optional): `pnpm seed:star-gardens` adds 24 leads and 13 `SG-DEMO-*` projects to Star Gardens. It needs every project migration up to `20261008001600`.
- It covers the edge cases: late, extended, on hold, cancelled, completed and archived projects, partly paid and overdue payments, every file status, client approvals, far-off check-ins, folders three levels deep, projects from last year and next month, payments ahead of the schedule, and bell notifications.
- With `--logins`, you can sign in as each demo role. They share one password, shown once.
- `pnpm seed:star-gardens --clean` removes all of it, including the placeholder files. Remove it before the real team starts: overdue demo phases and payments send alerts to the company's admins.

To roll back, switch "Projects" off for the company. The menus and routes disappear, and the data stays.

---

## 4. Checks

```bash
pnpm check        # typecheck + lint + tests + production build
pnpm test         # unit + database tests
pnpm test:e2e     # Playwright end-to-end (see below)
```

The database tests run the **real migrations** in PGlite, an in-process PostgreSQL. A small stub (`tests/db/supabase-stub.sql`) stands in for Supabase's `auth` schema and roles. They cover:

- **Permissions and RLS:** sales scope, reassignment, account and finance isolation, deactivation, the last-admin rule, privilege escalation, and worker functions locked to `service_role`.
- **Transaction integrity:** rollback of lead + niche + note + follow-up together, audit activities, version conflicts, and note-correction history.
- **Niches:** normalized uniqueness, merge, and archive.
- **Pagination and search:** tied timestamps across pages, filters with matching counts, literal `%`/`_` search, sales scope with a spoofed owner filter, and limit/offset/sort validation.
- **Reminders:** claim/lease, overlapping runs, lease expiry, retry and backoff, `retry_after`, max attempts, reschedule supersede, completed/cancelled/archived skips, not-connected/blocked handling, and single-use expiring link tokens.
- **Finance:** exact numeric totals, month grouping, archive exclusion, and change history.

Unit tests cover IST conversion, phone normalization, the paging contract, the request gate (the newest response wins and older reads are aborted), webhook parsing, and the worker's Telegram response classification.

Concurrency limitation: PGlite is single-connection, so overlapping workers are simulated with leases. Concurrent niche creation is also exercised with truly parallel sessions by the end-to-end suite (NICHE-04).

### End-to-end tests (Playwright)

`tests/e2e/TEST_PLAN.md` lists every feature, role rule and edge case, with where each one is verified. The Playwright suite drives the real app against the Supabase project in `.env`:

```bash
pnpm test:e2e                                    # starts `pnpm dev` on :3000 if nothing is running
E2E_BASE_URL=http://localhost:3001 pnpm test:e2e # reuse a server that is already running
pnpm test:e2e:report                             # HTML report with traces of failures
```

- **Accounts:** the setup project creates `e2e_admin`, `e2e_sales_a`, `e2e_sales_b` and `e2e_account` with a random password, then signs each one in through the login page. Specs reuse those sessions. Teardown hard-deletes every `e2e_*` user and every row they created; real users and data are never matched. Leftovers from an interrupted run are removed at the next start.
- **Needs** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` and `AUTH_LOGIN_DOMAIN`. The Telegram specs also need `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_BOT_USERNAME`, and skip themselves otherwise.
- **Sign-in rate limit:** a full run makes about 25 sign-ins, close to Supabase's limit of 30 per 5 minutes per IP. Wait 5 minutes between full runs. For local iteration, `E2E_KEEP_DATA=1 E2E_REUSE_SESSIONS=1` keeps the accounts and reuses sessions younger than 45 minutes.
- **Opt-in worker check:** `E2E_WORKER=1 pnpm test:e2e reminders` waits for a real pg_cron → Edge Function run (about 2 minutes) and checks the delivery is recorded.
- **Opt-in projects flow:** `E2E_PROJECTS=1 pnpm test:e2e projects` runs the Star Gardens flow (handoff → project → upload to Tigris → approval → client portal → payment) in a test company named "E2E Gardens". It needs the project migrations applied and the Tigris CORS rules set; teardown deletes its projects, files and users.
- The browser runs in `America/New_York` on purpose, so the suite proves the app enters and shows times in IST whatever the device timezone.

**Database types:** `pnpm db:types` regenerates `src/lib/database.types.ts` from the migrations (via PGlite, so no Docker is needed). Against a linked project, use `pnpm db:types:remote`.

---

## 5. How it works (short)

- **Login:** the username is normalized and mapped on the server to `username@AUTH_LOGIN_DOMAIN`, then `signInWithPassword` runs through the `@supabase/ssr` client so cookies are set. Errors are generic, and there is no public username lookup.
- **Users:**
  - Admins create users with the Auth Admin API (`email_confirm: true`), passing role and username in `app_metadata`.
  - The `on_auth_user_created` trigger inserts the profile in the same transaction, so a rejected profile, such as a duplicate username, also rejects the Auth user.
  - Deactivation updates the profile, so RLS denies data access on the next request, and also bans the Auth user.
- **Authorization:** `private.app_role()` reads the protected `profiles` row on every request. Mutation RPCs are `SECURITY INVOKER`, so RLS applies. Triggers write the audit timeline atomically. The service key is used only for:
  - Admin Auth operations
  - The verified Telegram webhook
  - The shared niche cache
  - The worker
  - Signing a short-lived file URL on the public share page, after the share token has been validated
- **Lists:** every list is server-filtered and sorted with an `id` tie-breaker, uses LIMIT/OFFSET (default 20, max 100), and returns a count computed from the same predicates. Search is debounced by 300 ms and escaped. Each request aborts the previous one and checks a sequence number, so only the newest response wins. List state lives in the URL.
- **Caching:** only the niche option list is cached server-side (`use cache` + `cacheTag('niches')`). Callers authorize first, and `updateTag` runs after niche mutations. Everything else is read fresh.
- **Realtime:** one authenticated channel per session, filtered by RLS. Each view refetches its own current page, debounced by about 350 ms, and also refetches on reconnect, focus, and a slow poll, so rows a user loses access to disappear. Unsaved form input is never overwritten, and lead edits use optimistic versioning.
- **Time and money:** timestamps are stored as UTC `timestamptz` and shown and entered in `Asia/Kolkata`. Amounts use `numeric(14,2)`. Capital is kept separate from expenses, and no profit or cash figure is shown.
- **Calls:** the lead page's **Call** button records a `call_logged` timeline event, opens the phone dialer, then asks for the outcome (Connected / No answer / Busy / Wrong number) and an optional note. Only the caller can set the outcome, within 24 hours.
- **Library:**
  - Folders of PDF / PNG / JPEG / WEBP files (25 MB each at most) live under `library/` in the private Tigris bucket; logos under `logos/`.
  - Admin and Sales can create folders and upload; only Admin can rename or archive. Account has no access.
  - Uploads: a server action checks the user's access to the folder (RLS) and returns a 5-minute presigned PUT URL whose type and size are fixed in the signature. The browser uploads straight to Tigris. The server then reads the object back (HEAD), records its real size and type in the object ledger `private.storage_objects`, and the database registers the file only if that record exists, as before.
  - Reads: the server signs GET URLs only for files the user can read through RLS. Share links (`/s/<token>/f/<id>`) check the token first; logos go through `/logo/<path>`, which needs no session because logos are not secret.
  - The ledger is written only with the server's secret key (`storage_record_object` / `storage_forget_objects` are granted to `service_role` alone); users can't read or change it.
  - **Settings → Usage** (super admin) shows the bytes recorded in the ledger, storage by folder, and archived files largest first. Archiving doesn't free space: there you can **delete archived files permanently** (the Tigris objects are deleted, then the records purged and logged in `admin_audit_log`) and clean up uploads older than an hour that were never registered.
- **WhatsApp sharing:**
  - On a lead, **Share files** picks up to 10 library files and an expiry (24 hours, 7 days, 30 days or never), creates a link, and opens `wa.me/<lead phone>` with the message and link filled in.
  - The link (`/s/<token>`) is a public page showing the sender's name and the files, never the customer's name or number. Only a SHA-256 hash of the token is stored.
  - Every file opens through `/s/<token>/f/<id>`. It re-checks the token in the database, then redirects to a 2-minute signed Tigris URL. So PDFs always load, and revoked or expired links stop at once.
  - The lead page lists each link with its status and open count, and lets you revoke it.
  - **`NEXT_PUBLIC_APP_URL` must be the public HTTPS address of the app**, or the links sent on WhatsApp won't open for customers.

---

## 6. Status: what still needs your setup

Everything listed in §1–§3 that needs your accounts or secrets:
- Migrations applied to your Supabase project
- Auth signup disabled
- First admin bootstrapped
- BotFather bot, webhook registration and Edge Function deploy
- Vault secrets
- Vercel project and environment variables

The following have **not** been run against a live Supabase/Telegram/Vercel environment. Verify them after provisioning:
- Realtime cross-session updates (an open admin dashboard updating when sales creates a lead)
- Real Telegram delivery
- Opening share links on a phone through WhatsApp
- Cron invocation
- Auth rate limits
