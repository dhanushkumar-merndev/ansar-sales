# Simple CRM — Agent Instructions

## Objective and working style

Build a simple, attractive internal CRM for one business. It must support leads, notes, a readable activity timeline, scheduled follow-ups with Telegram reminders, basic capital investment and monthly operating expenses, and useful role-specific analytics.

The user intends to run the coding agent with their selected **Opus 5.5 / High** setting. This document describes the project; it does not install, select, or verify that model. Follow these requirements regardless of the selected model.

Prioritize fast delivery through established, prebuilt components. Make routine implementation decisions independently. Deliver working vertical slices rather than spending time building a framework or discussing plans. Inspect the repository first, preserve existing work, and adapt these instructions to its installed compatible versions. Do not replace a working stack merely to use a newer release.

Use only services required by the agreed stack. Keep v1 to one business; do not introduce multi-tenancy, billing, a full accounting system, AI features, or a separate backend server.

## Required stack

| Area | Choice |
| --- | --- |
| App and application backend | Next.js App Router, React, TypeScript |
| Database | Supabase PostgreSQL |
| Authentication | Supabase Auth with admin-created accounts |
| Server/browser Supabase clients | Official `@supabase/ssr` and `@supabase/supabase-js` |
| Live data | Supabase Realtime |
| UI | shadcn/ui and Tailwind CSS |
| Charts | Apache ECharts |
| Reminder scheduler | Supabase Cron (`pg_cron`) |
| Reminder delivery worker | One Supabase Edge Function invoked through `pg_net` |
| Notifications | Telegram Bot API |
| Deployment | Vercel for Next.js, Supabase for database/auth/worker |

Small supporting packages are acceptable when they replace substantial custom work: Zod, React Hook Form, the dependencies required by shadcn/ui, TanStack Table for its data table pattern, Lucide icons, and a date utility. Avoid adding a second state-management or data-fetching framework unless the repository already uses one or a concrete need justifies it.

## Prebuilt-first implementation

- Start with the shadcn `dashboard-01` or Sidebar pattern and adapt it to this CRM. Remove unrelated demo navigation, sample metrics, and placeholder features.
- Reuse shadcn Button, Card, Badge, Input, Textarea, Dialog, Sheet, Tabs, Table, Calendar, Popover, Command/Combobox, Alert Dialog, Skeleton, and toast patterns as needed.
- Use the shadcn searchable combobox pattern with a small create-option extension for niches.
- Use the shadcn Data Table pattern rather than creating a custom grid engine.
- Use official Supabase SSR/session patterns rather than writing authentication or password hashing yourself.
- Use standard ECharts options for bar, line, and donut charts. Load charts only on the client, preferably lazily, and resize/dispose chart instances correctly.
- The activity timeline can be a small reusable component composed from existing primitives. Do not install a large calendar/timeline suite.
- Reuse forms, status badges, validation schemas, currency formatting, and permission helpers across pages.

## Roles and responsibilities

There are exactly three business roles: `admin`, `sales`, and `account`.

| Capability | Admin | Sales | Account |
| --- | --- | --- | --- |
| Create/deactivate users, change roles, reset passwords | Yes | No | No |
| View all leads and team analytics | Yes | No | No |
| Create leads | Yes | Yes | No |
| Edit leads, status, notes, follow-ups | All leads | Own/assigned leads | No |
| Assign/reassign leads | Yes | No | No |
| Create a niche while saving a lead | Yes | Yes | No |
| Rename/merge/archive niche options | Yes | No | No |
| View investment and expense records | Yes | No | Yes |
| Create/edit/archive financial records | Yes | No | Yes |
| View personal sales analytics | Yes | Yes | No |
| Link own Telegram account | Yes | Yes | Yes |

Default scope: a lead belongs to its assigned salesperson. Sales can access leads they currently own or are assigned; being the original creator does not retain access after reassignment. Account has finance access and no sales-note or lead access by default. Do not implement configurable permission management in v1 unless the user asks for it later.

Admin can manage all business records, including archive/restore, with an audit trail. Prefer soft deletion to destructive deletion. Admin account management must preserve at least one active Admin.

Enforce access in the database using Row Level Security and in every server mutation. Hiding buttons or navigation is not authorization. Store authoritative roles in a protected profile table, not user-editable auth metadata. Ordinary CRM operations use the signed-in user's Supabase client and RLS; do not bypass RLS with a service key.

## Authentication: simple username and password

User-facing login is **Username + Password**. There is no public registration, email OTP, magic link, or email verification step.

Supabase's native password identity uses email or phone, not username. Implement a thin server-side username adapter while retaining Supabase Auth:

1. Admin creates a unique normalized username, display name, password, and one of the three roles.
2. Assign a stable internal Auth email address under a configured app-owned login domain/subdomain. Staff do not need an inbox. Keep usernames immutable in v1 so the mapping remains simple.
3. Create the Supabase Auth user using the server-only Admin API with `email_confirm: true`.
4. Link the Auth UUID to the protected profile record.
5. On login, resolve the username to its internal Auth identity on the server and sign in using the official SSR client so cookies are set correctly.
6. Disable public signup at the Auth configuration level, not only in the UI.
7. Admin resets forgotten passwords directly; users may change their own password while authenticated. Do not require an email recovery workflow.

Validate and normalize usernames, return generic invalid-credentials errors, and use the available Auth/platform rate limits. Never store or log plaintext passwords. Never expose internal login mappings through a public lookup endpoint.

Keep secret/service keys server-only. The browser receives only the Supabase URL and publishable key. Account creation/reset endpoints require an authenticated active Admin before using privileged APIs.

Bootstrap the first Admin using a documented one-time script or controlled setup procedure, never an unauthenticated public route. Do not hard-code credentials in code, this file, seed data, or screenshots.

User creation spans Auth and application data. Handle partial failure: if profile creation fails after creating an Auth identity, roll back the new identity or record/recover the incomplete setup. Deactivation must be enforced on every new data request through database permissions; do not rely solely on stale JWT role claims.

## Lead management

| Field | Requirement |
| --- | --- |
| Name | Required; trimmed |
| Phone | Required; validate and normalize with country code support |
| Email | Optional; validate when present |
| Niche | Required searchable, creatable option |
| Status | `new` by default |
| Assigned salesperson | Creator by default for Sales; Admin may assign another active Sales user |
| Initial note | Optional |
| Initial follow-up date/time | Optional |
| Created by / created at / updated at | Automatically recorded |

Statuses: `new`, `contacted`, `interested`, `proposal_sent`, `won`, `lost`.

Provide search by name/phone/email and filters for status, niche, owner (Admin only), date range, and overdue follow-up. Use paginated queries and indexed filtering rather than downloading every lead to the browser.

Flag normalized-phone duplicates. Do not disclose another salesperson's restricted lead details in duplicate messages. Allow an intentional duplicate after a clear confirmation; if overriding requires Admin under existing business policy, respect that policy. Prevent duplicate form submissions.

Lead changes should be authorized and validated server-side. Use a transaction/RPC where a change and its activity records must succeed together. Preserve unsaved form input when a background refresh arrives; flag conflicts instead of silently overwriting another user's edits.

## Server-side pagination, search, and request best practices

These are required for every potentially growing list: leads, follow-ups, timeline history, financial entries, user management, and searchable options. Keep all data filtering and pagination in PostgreSQL/Supabase; client-side slicing of an unbounded dataset is not acceptable.

### Offset pagination contract

- Default page size: 20. Offer 20, 50, and 100 where appropriate; enforce a server-side maximum of 100.
- Use one-based `page` in the UI. Derive `offset = (page - 1) * pageSize` on the server; validate integers and reject negative, malformed, or excessively large values.
- Use SQL `LIMIT pageSize OFFSET offset`, or Supabase `.range(offset, offset + pageSize - 1)`. Supabase range endpoints are inclusive; do not return one extra row accidentally.
- Apply authorization, archive filters, search, status, niche, owner, and date predicates before sorting and pagination. The returned total must use exactly the same authorized predicates.
- Use stable deterministic ordering with a unique tie-breaker, for example `created_at DESC, id DESC`. Allowlist supported sort fields/directions; never interpolate user-controlled SQL identifiers.
- Return a consistent response such as `{ items, page, pageSize, total, hasNextPage }`. For lists that do not need numbered pages, requesting one extra bounded row to determine `hasNextPage` is acceptable instead of repeatedly calculating a count.
- Query the database for counts; do not download IDs or records merely to count them. Avoid separately repeating the same exact count on every Realtime event when only row content changed. Refresh counts when membership might have changed.
- Pagination state and filters belong in the URL where useful, so browser Back/Forward and sharing preserve the view. Reset to page 1 when the applied search, filters, sort, or page size changes.
- If archiving/removing a record makes the current page empty, move to the last valid page and refetch. Keep selection scoped to the visible authorized data; clear stale selections when scope changes.
- Offset pagination is the v1 default. It can shift under concurrent inserts and becomes expensive at deep offsets. Do not claim snapshot consistency. If actual data volume makes deep pages slow, introduce cursor/keyset pagination for that specific list with measured justification; do not prematurely build both systems.

### Search and combobox debounce

- Keep typing responsive using immediate local input state. Apply a 300 ms debounce to search requests; do not issue a database query on every keystroke.
- The niche combobox uses the same 300 ms debounce when options are searched remotely. Return at most 20 matches and offer the create action only after normalized exact-match checking. Keep the currently selected option visible even when it is outside the latest search results.
- An empty search restores the default bounded query. Bound query length server-side and use a sensible minimum length for expensive partial matching. Preserve exact phone matching as appropriate.
- Use parameterized queries. Escape `%` and `_` when search treats input literally. If using Supabase filter-expression APIs, do not concatenate unescaped user strings into `.or()` grammar; use a safe typed RPC or an equivalent validated construction.
- Use case-insensitive search for names/email/niche and normalized phone search. Add appropriate indexes; introduce `pg_trgm` for substring search only when needed and verify with query plans rather than assuming a normal B-tree speeds up `%term%` queries.
- Debounce search, not explicit Save, Sign in, Complete follow-up, or reminder delivery actions. Disable duplicate submissions while a mutation is pending.

### Avoid stale results and unnecessary requests

- Abort obsolete reads when supported, and use a request sequence/key check so a slow older response cannot overwrite the latest search/filter/page results. Treat expected cancellation separately from errors.
- Include every applied filter, sort, page, page size, and current user's authorized scope in query identity. Clear user-specific state on sign-out or account switch.
- Preserve the previous page while loading the next page if useful, but show a loading indicator and do not present old records as the new page's confirmed result.
- Batch/debounce Realtime-triggered refetches around 250–500 ms. Refetch only affected mounted views and metrics. Do not make every table event refetch every dashboard.
- When a Realtime event can change filtered membership, ordering, totals, or page boundaries, refetch the current server page instead of blindly prepending/removing rows. Preserve the user's applied filters and current page where still valid.
- Prevent duplicate active reads for the same query and unnecessary subscriptions; clean up abort controllers, timers, and channels on unmount/sign-out.
- Use bounded pending/error/loading states and retry transient reads with limited backoff. Never blindly retry non-idempotent writes or keep an infinite request loop alive.
- Keep aggregate queries separate from list pagination: dashboard totals summarize the full authorized filtered scope, not just the current 20-row page.
- Avoid N+1 requests. Fetch the bounded related owner/niche/next-follow-up data with joins or an appropriate RPC; fetch timeline details only when a lead is opened.
- Validate limits/filters on the server even if the client already validated them. Never trust a supplied owner ID to bypass Sales scope.

For acceptance, create more records than one page, verify all supported filters/sorts across page boundaries, rapidly type/change filters and confirm only the newest response wins, and trigger another user's authorized insert while a filtered page is open. Confirm query sizes remain bounded and no restricted data is returned.

### Niche combobox behaviour

- As the user types, show matching saved niche options.
- If no normalized exact match exists, offer `Create "<typed value>"`.
- Persist the new niche when the lead is successfully saved, not on every keystroke.
- Store niches in their own table and reference them by ID.
- Normalize case and whitespace for uniqueness, while retaining a readable display label.
- Use a database unique constraint/upsert so concurrent saves do not create duplicate niches.
- A saved niche becomes available to all authorized lead users without a page reload.
- Admin may archive or merge niches without breaking existing lead references.

## Notes, activity timeline, and follow-ups

The lead detail view must be understandable at a glance. Show the lead summary, current status, owner, and next follow-up first. Show upcoming tasks separately above the historical timeline.

Record timestamped timeline events for lead creation, notes, status changes, assignments, follow-up scheduling/rescheduling/completion/cancellation, and meaningful edits. Each event shows its author, time, event type, and readable content. Include old/new values where helpful. Retain audit history when notes are corrected or records are archived.

Use a compact vertical timeline with icons and subtle separators, newest history first. Keep the next task prominent. Do not present raw JSON to users.

A follow-up contains a lead ID, assigned user ID, due timestamp, task text, optional outcome, state (`pending`, `completed`, `cancelled`), and reminder scheduling metadata. A pending task with a due time in the past is overdue; derive that state rather than maintaining a drifting separate flag.

Sales can schedule, reschedule, complete, and cancel follow-ups for permitted leads. Completion can capture a short outcome and optionally schedule the next follow-up. Reassignment must keep pending follow-ups and reminder recipients consistent with the lead's current owner.

Default to one Telegram notification at the due time per follow-up revision. Additional advance reminders and daily digests are future enhancements, not v1 requirements.

Store timestamps as UTC `timestamptz`; display and accept user-entered times in `Asia/Kolkata`. Avoid browser/system timezone ambiguity. Use explicit India date/time formatting and INR currency formatting.

## Telegram reminder architecture

The CRM must send reminders while browsers are closed. Browser timers and Realtime events are not background schedulers.

Use one Supabase Cron job every minute. It invokes one authenticated Supabase Edge Function through `pg_net`. The worker processes a bounded batch of due reminders and sends messages through Telegram's Bot API. Do not create one cron job per lead or follow-up.

### Connect Telegram

- Create the bot using BotFather; keep its token in server/Edge Function secrets.
- Provide a `Connect Telegram` action in the signed-in user's settings.
- Generate an opaque, short-lived, single-use token tied to that user's UUID.
- Open a Telegram bot deep link with the token in its `start` parameter.
- Use a secured Next.js webhook route to receive `/start`, verify the linking token, and bind the private Telegram chat ID to the profile.
- Validate Telegram's webhook secret header; never expose the bot token or accept an arbitrary submitted chat ID as proof of ownership.
- The user must start the bot before private reminders can be delivered. Show connected/disconnected status.

### Worker rules

- Scan reminders due at or before now so a late scheduler run can catch up.
- Claim work atomically with an expiring lease; overlapping runs must not both process the same pending item.
- Recheck follow-up state, current owner, active profile, current schedule revision, and Telegram connection before delivery.
- Rescheduling cancels the previous pending reminder revision and creates the new one transactionally.
- Skip completed/cancelled follow-ups and archived leads.
- Message content: lead name, task, due time in IST, and an authenticated CRM lead link. Include a phone number only if it is appropriate for that user's permitted lead.
- Record attempts, delivery state, timestamps, and sanitized error information. Retry temporary failures with bounded backoff; respect Telegram rate-limit responses.
- Handle blocked/disconnected bots visibly in the CRM. Retain a pending/failed delivery state rather than claiming success.
- Use a unique key per follow-up revision/reminder type to reduce duplicate sends. Telegram delivery is not a transaction with PostgreSQL; a crash after sending but before recording success can still duplicate a notification. Do not promise exactly-once delivery.
- Authenticate worker invocations with a dedicated secret or supported service authentication, stored securely. A public/publishable key alone is not authorization for privileged reminder work.
- Clean up old delivery/cron logs with a bounded retention policy so free-tier storage is not exhausted.

Delivery normally occurs around the next minute-based scheduler run plus processing/network time. Do not promise exact-second delivery or delivery during provider outages.

## Vercel and Supabase deployment constraints

The following constraints were checked during project planning on **2026-10-05**. Recheck official documentation before final deployment; do not assume pricing or limits are permanent.

- Vercel Hobby cron runs each configured job no more than once per day, with invocation possible anywhere in the scheduled hour. It is unsuitable for minute-based follow-up reminders.
- Do not work around Hobby restrictions with many staggered jobs. Run the reminder scheduler in Supabase.
- Vercel Hobby is restricted to personal, non-commercial use. An operational business CRM should use Vercel Pro or another appropriate commercial hosting plan. A non-commercial personal prototype may use Hobby.
- Supabase Cron supports minute-level scheduling and invoking Edge Functions. The free plan's documented Edge Function allowance was 500,000 monthly invocations; one run/minute is about 43,200 runs per 30 days, before retries and other functions.
- This is only an invocation calculation, not a guarantee that all free-tier limits or reliability requirements fit. Supabase free projects may pause after a week of inactivity and have storage, Realtime, and other quotas.
- Do not deploy or change paid plans without the user's authorization. Document required provisioning and report missing external credentials/configuration clearly.

## Server cache and realtime rules

Use **selective server caching plus live operational reads**. Caching and Realtime solve different problems; cache expiration alone does not update another browser.

| Data | Policy |
| --- | --- |
| Shared niche/options data and suitable display settings | Explicit server cache with scoped tags and bounded lifetime |
| Lead lists/details, notes, timelines, follow-ups, financial entries | Fresh authorized reads; no persistent shared response cache |
| Current dashboard totals and chart aggregates | Fresh database aggregate queries on relevant events |
| Sessions, role checks, deactivation, permissions, secrets | Never persistently cache as shared application data |

- Use the installed Next.js version's supported cache APIs. For versions using Cache Components, explicitly configure `cacheComponents`, `use cache`, `cacheTag`, and `cacheLife` for cacheable functions. Do not mix incompatible caching models.
- In Server Actions, expire relevant tags immediately after a successful cached-data mutation using `updateTag` where supported. In Route Handlers/webhooks, use the appropriate `revalidateTag` API for that version and the needed expiration behaviour.
- A Supabase SDK database call does not automatically become a persistent Next.js cache entry. Define intentional caching explicitly.
- Never cache a privileged query broadly and then filter its result in the browser. Perform authorization before returning data; include access scope in any protected cache key.
- Initial pages may render on the server. Interactive components subscribe to permitted table changes through the authenticated browser Supabase client.
- On relevant events, update local state or refetch the affected fresh query; update summary cards and ECharts datasets too. Debounce bursts to avoid one aggregate query per tiny change.
- When a niche changes, refetch fresh options in connected browsers as well as invalidating server cache. Do not let an event race with cache invalidation return an old list indefinitely.
- Use authenticated RLS-aware subscriptions. Never broadcast sales notes or financial data through a global public channel.
- Handle insert/update/archive and permission changes. A former owner may not receive a reassignment event after RLS removes their access, so also refetch on reconnect/focus and use a lightweight periodic freshness fallback for active lists. Remove data no longer authorized.
- Refetch missed updates after reconnect and show a subtle connection state. Unsubscribe when components unmount or the user signs out.
- Optimistically show a successful-looking local action only where safe, reconcile with the server result, and roll back/show an error on failure.
- Preserve current filters, pagination, and in-progress form values during refreshes.
- Do not call `window.location.reload()` to synchronize data. If using `router.refresh()`, understand that it does not independently invalidate persistent server caches.

Acceptance example: Sales creates a lead; an already-open Admin dashboard receives the change and updates its list and totals without manual reload. Another Sales user must not receive the restricted lead.

## Basic finance module

Keep finance focused on the user's requested capital investment and monthly operating costs.

### Capital investment

Fields: date, contributor/source, amount, description, author, and audit timestamps. Treat this as money contributed to the business. Do not count it as sales revenue. If the user means asset purchases instead, track that separately rather than mixing contributions and spending.

### Operating expenses

Fields: expense date, category, positive INR amount, description, author, and audit timestamps. Derive the accounting month from the expense date in the configured business timezone.

Initial categories: salary, rent, software, marketing, utilities, and miscellaneous. Let Admin/Account use existing categories consistently. Start with actual entries; recurring-expense auto-generation, tax workflows, payroll, invoice processing, and bank reconciliation are outside v1.

Store amounts using an exact database numeric type or integer paise, never floating-point financial totals. Account and Admin can create/edit/archive entries with history. Sales must have no financial read/write access.

Show total contributed capital, this month's operating expense total, month-wise spending, and category breakdown. Do not show profit, available cash, or ROI without the additional income/outflow data required to calculate them correctly.

## Analytics using Apache ECharts

| Role | Summary cards | Charts |
| --- | --- | --- |
| Admin | Total active leads, today's pending follow-ups, overdue follow-ups, won leads | Lead creation trend, current stage breakdown, salesperson comparison; niche breakdown if useful |
| Sales | My active leads, today's tasks, overdue tasks, my won leads | My stage breakdown and personal activity trend |
| Account | Total contributed capital, current month expenses | Monthly cost trend and expense category breakdown |

Calculate metrics in PostgreSQL aggregate queries/RPCs under the correct permissions. Do not load all records merely to count them client-side. Label date ranges and distinguish a creation-date trend from current pipeline distribution.

If showing a closed-lead win rate, define it explicitly as `won / (won + lost)` and handle a zero denominator. Do not claim revenue from the number of won leads. Keep the dashboard to a few relevant charts, not a wall of graphs.

## UI and interaction requirements

- Clean white/off-white surfaces, dark readable text, restrained red accent, subtle borders, and generous spacing.
- Role-aware sidebar: Dashboard, Leads, Follow-ups, Finance, Users, and personal Settings. Show only applicable items.
- Sales landing view prioritizes today's and overdue tasks, with a clear `Add lead` action.
- Desktop leads use a compact searchable/filterable table. Mobile uses a readable card/detail layout rather than cramped horizontal fields.
- Open lead details in a spacious Sheet or dedicated page, with summary, upcoming follow-ups, and timeline. Keep `Add note` and `Schedule follow-up` easy to reach.
- Use text labels alongside status colours. Red means urgent/overdue; green means completed/won; colours are not the only signal.
- Provide keyboard-friendly comboboxes, labelled fields, inline validation, loading skeletons, empty states, failure states, save confirmations, and clear destructive-action confirmations.
- Keep dialogs short. Do not put every editable field into one overloaded screen.
- No unrequested animation, decorative gradients, or placeholder analytics. Seed/demo data must be clearly restricted to development.

## Suggested data model

Use SQL migrations with foreign keys, appropriate indexes, RLS, and generated TypeScript database types.

- `profiles`: Auth UUID, unique username, display name, protected role, active state, timestamps.
- `niches`: display name, normalized unique name, archived state.
- `leads`: contact fields, niche, status, owner, creator, timestamps, archive metadata.
- `lead_activities`: lead, author, event type, readable note and structured change metadata, timestamps.
- `follow_ups`: lead, assignee, task, due time, state, outcome, schedule revision, timestamps.
- `telegram_connections`: user, protected chat ID, connection state.
- `telegram_link_tokens`: hashed single-use token, user, expiry, consumed timestamp.
- `reminder_deliveries`: follow-up revision, recipient, due time, state, attempts, lease, sent timestamp, sanitized failure.
- `capital_entries`: investment fields, audit/archive metadata.
- `expenses`: expense fields, category, audit/archive metadata.
- `finance_activities`: financial change history visible only to Admin/Account.

Do not expose Telegram linking tokens or delivery-worker internals through general profile reads. Join limited display-name data for timeline authors without exposing Auth emails or other private profile fields.

Indexes should cover owner/status filtering, niche normalization, normalized phone matching, lead/time timeline lookup, pending follow-up due times, eligible reminder state/due times, and financial date/category grouping. Keep migrations reproducible; do not rely on undocumented dashboard-only changes.

## Delivery order

1. Inspect the repository, choose compatible dependencies, and build the reusable shadcn application shell.
2. Add database migrations, RLS, first-Admin bootstrap, SSR login, and role-aware navigation.
3. Deliver lead creation/list/detail, creatable niches, notes, timeline, and follow-ups as one working sales flow.
4. Add Realtime synchronization and selective server-cache invalidation; verify with separate Admin/Sales sessions.
5. Add capital and expense entries with Account access and finance history.
6. Add the small role-specific ECharts dashboards using real aggregates.
7. Add Telegram connection/webhook, reminder worker, delivery records, and Cron setup.
8. Run meaningful checks, document environment/provisioning, and prepare the Vercel deployment configuration.

Avoid premature abstraction. Build UI around actual database data from the start. Reuse prebuilt patterns and existing project conventions to keep implementation fast.

## Required validation and completion criteria

Run the project's type check, lint, and production build. Add focused automated tests for permissions, transaction integrity, niche uniqueness, date/time scheduling, and reminder claim/reschedule/retry behaviour. Do not write redundant snapshot tests for every visual primitive.

Verify these end-to-end behaviours:

- Admin creates each role; staff sign in with username/password without email/OTP.
- Public signup is disabled, the initial Admin is provisioned safely, and non-Admins cannot create users or escalate roles.
- Sales creates a lead using required fields and no email; saved niche appears for another authorized lead user.
- Concurrent creation of the same normalized niche yields one option.
- Sales sees only assigned leads, including after reassignment; Account cannot read lead notes; Sales cannot access finance through UI or direct API calls.
- Notes, status changes, assignments, and follow-up changes appear correctly in the timeline.
- Already-open permitted screens update without manual reload, including dashboard totals and niches.
- Reconnect/refocus restores missed changes and removes records whose permissions changed.
- Expense and capital totals remain separate, exact, and correctly grouped by month.
- Telegram account linking requires the correct single-use token and webhook verification.
- Due reminders work while the browser is closed; completed/cancelled/rescheduled tasks are handled correctly; concurrent workers do not normally send the same reminder twice.
- Temporary Telegram failures are retried and visible; timestamps render in IST; mobile forms are usable.

Use separate test accounts for Admin, Sales A, Sales B, and Account. Keep them in a development environment. Do not claim an integration was tested when external credentials or provisioning were unavailable; report the exact unverified part.

Completion means working code, reproducible migrations, a documented `.env.example` containing placeholders only, a short setup/deployment README, passing applicable checks, and an explicit list of any blocked external configuration. A mock-only dashboard is not a completed CRM.

## Environment and setup documentation

Document the needed configuration without committing secrets:

- Supabase project URL and publishable key for browser/SSR clients.
- Supabase server-only secret/service key for narrowly scoped Admin operations.
- Configured internal Auth login domain and application URL.
- Telegram bot username/token, webhook secret, and reminder-worker authentication secret in the correct server/Edge environments.
- Supabase Vault values needed to invoke the worker, Realtime publication settings, Cron installation/schedule, and RLS migrations.
- Vercel environment values, Supabase project settings, first-Admin bootstrap, and how to verify a reminder delivery.

Choose environment names consistent with the installed SDK and repo. Never give secret values a `NEXT_PUBLIC_` prefix. Changes to deployment, paid plans, and real external messages require the user's task authorization; setup docs and reversible local implementation can proceed independently.

## Official references

Use primary documentation when an API or limit needs verification:

- Next.js caching: https://nextjs.org/docs/app/getting-started/caching
- Next.js immediate tag expiration: https://nextjs.org/docs/app/api-reference/functions/updateTag
- Supabase Next.js SSR: https://supabase.com/docs/guides/auth/server-side/nextjs
- Supabase password auth: https://supabase.com/docs/guides/auth/passwords
- Supabase Admin createUser: https://supabase.com/docs/reference/javascript/auth-admin-createuser
- Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase Realtime: https://supabase.com/docs/guides/realtime/postgres-changes
- Supabase Cron: https://supabase.com/docs/guides/cron
- Scheduling Edge Functions: https://supabase.com/docs/guides/functions/schedule-functions
- Supabase plan limits: https://supabase.com/pricing
- Vercel cron limits: https://vercel.com/docs/cron-jobs/usage-and-pricing
- Vercel commercial-use rules: https://vercel.com/docs/limits/fair-use-guidelines
- shadcn components: https://ui.shadcn.com/docs/components
- shadcn blocks: https://ui.shadcn.com/blocks
- Apache ECharts: https://echarts.apache.org/handbook/en/get-started/
- Telegram linking: https://core.telegram.org/bots/features#deep-linking
- Telegram Bot API: https://core.telegram.org/bots/api
