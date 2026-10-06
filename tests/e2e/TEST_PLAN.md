# CRM test plan

Every feature, role rule and edge case, and where it is verified.

**Coverage key**

| Tag | Meaning |
| --- | --- |
| `E2E:<spec>` | Playwright, real app + real Supabase project (`tests/e2e/<spec>.spec.ts`) |
| `DB:<file>` | Vitest against the migrations in PGlite (`tests/db/<file>.test.ts`) |
| `UNIT:<file>` | Vitest pure-function tests (`tests/unit/<file>.test.ts`) |
| `MANUAL` | Needs external provisioning or a human (real Telegram account, provider outage) |

**Test accounts** (created and deleted by the E2E run, all `e2e_*`): `e2e_admin`, `e2e_sales_a`, `e2e_sales_b`, `e2e_account`, plus temporary users created inside tests.

---

## 1. Authentication

| ID | Scenario | Role | Expected | Coverage |
| --- | --- | --- | --- | --- |
| AUTH-01 | Sign in with username + password, no email/OTP step | all | Lands on `/dashboard` | E2E:auth, E2E:users |
| AUTH-02 | Wrong password for an existing user | – | Generic "Invalid username or password." | E2E:auth |
| AUTH-03 | Unknown username | – | Same generic message as AUTH-02 (no user enumeration) | E2E:auth |
| AUTH-04 | Malformed username (`a`, spaces, symbols) | – | Same generic message; Supabase not called | E2E:auth |
| AUTH-05 | Signed-out visit to a protected page | – | 307 to `/login?next=<path>` | E2E:auth |
| AUTH-06 | `next` param honoured after sign-in (incl. query string) | all | Redirects to the original page | E2E:auth |
| AUTH-07 | Open redirect via `next=//evil.example` | – | Ignored, lands on `/dashboard` | E2E:auth |
| AUTH-08 | Public sign-up through Supabase Auth API | anon | Rejected at the Auth layer | E2E:auth |
| AUTH-09 | Sign out | all | Session cleared; protected pages redirect to login | E2E:auth |
| AUTH-10 | Deactivated user tries to sign in | – | Generic invalid-credentials message | E2E:users |
| AUTH-11 | User deactivated while signed in | – | Next request: data access denied, sent to `/login?error=inactive` | E2E:users, DB:permissions |
| AUTH-12 | Admin resets a password | admin | Old password fails, new password works | E2E:users |
| AUTH-13 | Change own password: wrong current password | all | "Current password is incorrect." | E2E:settings |
| AUTH-14 | Change own password: success, then sign in with the new one | all | Works | E2E:settings |
| AUTH-15 | New/confirm password mismatch, < 8 chars | all | Inline error / button disabled | E2E:settings |
| AUTH-16 | Rate limiting on repeated failures | – | "Too many attempts…" (Supabase limit) | MANUAL (shares the server IP, see Findings) |
| AUTH-17 | First admin bootstrap | – | Only via `pnpm bootstrap:admin`, no public route | MANUAL (README) |

## 2. Roles and access control

| ID | Scenario | Role | Expected | Coverage |
| --- | --- | --- | --- | --- |
| ROLE-01 | Sidebar items | admin | Dashboard, Leads, Follow-ups, Finance, Users, Settings | E2E:access |
| ROLE-02 | Sidebar items | sales | Dashboard, Leads, Follow-ups, Settings | E2E:access |
| ROLE-03 | Sidebar items | account | Dashboard, Finance, Settings | E2E:access |
| ROLE-04 | Direct URL to `/finance`, `/users`, `/leads/niches` | sales | Redirect to `/dashboard` | E2E:access |
| ROLE-05 | Direct URL to `/leads`, `/follow-ups`, `/users` | account | Redirect to `/dashboard` | E2E:access |
| ROLE-06 | Role-specific dashboard cards | each | Admin team cards, Sales "My …" cards, Account capital/expense cards | E2E:access |
| ROLE-07 | Sales reads finance tables through the REST API | sales | Empty result (RLS) | E2E:api-security, DB:permissions |
| ROLE-08 | Sales inserts an expense through the REST API | sales | Rejected | E2E:api-security, DB:permissions |
| ROLE-09 | Account reads leads / notes through the REST API or `list_leads` | account | Empty / forbidden | E2E:api-security, DB:permissions |
| ROLE-10 | Sales B reads Sales A's lead, notes, follow-ups through the API | sales | Empty | E2E:api-security, DB:permissions |
| ROLE-11 | Sales changes `owner_id` or archives through the API | sales | Forbidden | E2E:api-security, DB:permissions |
| ROLE-12 | Sales escalates own role (profile update) | sales | Rejected (no column grant) | E2E:api-security, DB:permissions |
| ROLE-13 | Sales calls the `createUser` / `updateUser` server actions directly | sales | "You don't have permission" | E2E:users |
| ROLE-14 | Anonymous REST access to any table | anon | Rejected | E2E:api-security, DB:permissions |
| ROLE-15 | Telegram link tokens / worker internals readable | any user | Not readable | E2E:api-security, DB:permissions |
| ROLE-16 | At least one active admin is always kept | admin | `last_admin` error | DB:permissions (E2E would touch the real admin) |

## 3. Leads

| ID | Scenario | Role | Expected | Coverage |
| --- | --- | --- | --- | --- |
| LEAD-01 | Create with name + phone + new niche, no email | sales | Toast, lead in list, owner = creator | E2E:leads |
| LEAD-02 | Required-field validation (empty form) | sales | Name/phone/niche errors, nothing saved | E2E:leads |
| LEAD-03 | Invalid phone / invalid email | sales | Inline errors | E2E:leads |
| LEAD-04 | Local Indian number normalised | sales | Saved as `+91 …` | E2E:leads, UNIT:lib |
| LEAD-05 | Foreign number with `+country` code | sales | Accepted | UNIT:lib |
| LEAD-06 | Duplicate phone, own lead | sales | Warning with "open it" link | E2E:leads |
| LEAD-07 | Duplicate phone, other user's lead | sales | Warning without link or details; "Save duplicate" works | E2E:leads, DB:permissions |
| LEAD-08 | Double-click Create | sales | Exactly one lead (button disabled while pending) | E2E:leads |
| LEAD-09 | Admin assigns on create | admin | Owner = chosen sales user | E2E:assignment |
| LEAD-10 | Sales spoofs owner on create | sales | Ignored, owner = self | DB:permissions |
| LEAD-11 | Search by name / phone digits / email (literal `%`, `_`) | sales | Matching leads only | E2E:leads, DB:pagination |
| LEAD-12 | Filters: status, niche, owner (admin), dates, overdue, archived (admin) | admin/sales | Applied server-side before paging | E2E:leads, DB:pagination |
| LEAD-13 | Pagination: > 1 page, next/prev, page size 20/50/100 | sales | Correct ranges, totals, page resets to 1 on filter change | E2E:leads |
| LEAD-14 | Tampered URL `pageSize=1000`, `page=-1`, `sort=evil` | sales | Falls back to safe defaults; DB rejects bad values | E2E:leads, DB:pagination |
| LEAD-15 | Sort by name across page boundaries | sales | Stable, no duplicates/gaps | E2E:leads, DB:pagination |
| LEAD-16 | URL state survives reload and Back | sales | Same filters/page | E2E:leads |
| LEAD-17 | Search debounce | sales | One `list_leads` request per pause, newest response wins | E2E:performance, UNIT:lib |
| LEAD-18 | Edit conflict (lead changed while edit dialog open) | sales | Conflict banner; save rejected with readable message | E2E:lead-detail, DB:leads |
| LEAD-19 | Archive / restore | admin | Hidden from sales, shown under Archived, restorable | E2E:assignment |
| LEAD-20 | Mobile layout | sales | Cards instead of table, usable dialog | E2E:mobile |

## 4. Niches

| ID | Scenario | Role | Expected | Coverage |
| --- | --- | --- | --- | --- |
| NICHE-01 | Type a new niche → "Create …" offered, saved with the lead | sales | Niche exists after save only | E2E:leads |
| NICHE-02 | Exact match (case/space-insensitive) → no Create option | sales | Existing niche offered instead | E2E:niches |
| NICHE-03 | Niche created by Sales A visible to Sales B | sales | Found in combobox | E2E:niches, DB:leads |
| NICHE-04 | Concurrent creation of the same normalised niche | sales×2 | One niche row | E2E:niches, DB:leads |
| NICHE-05 | Rename / archive / merge | admin | Lead references stay valid | E2E:niches, DB:leads |
| NICHE-06 | Archived niche not usable for new leads | sales | `niche_archived` error | DB:leads |
| NICHE-07 | Niche admin page | sales | Redirect | E2E:access |

## 5. Notes and timeline

| ID | Scenario | Role | Expected | Coverage |
| --- | --- | --- | --- | --- |
| TL-01 | Add note (button and Ctrl+Enter) | sales | Appears at top of timeline with author/time | E2E:lead-detail |
| TL-02 | Empty note | sales | Save disabled | E2E:lead-detail |
| TL-03 | Correct note | author/admin | Corrected text shown, previous text kept struck-through | E2E:lead-detail, DB:leads |
| TL-04 | Status change logged with old → new | sales | "changed status from New to Contacted" | E2E:lead-detail |
| TL-05 | Field edit logged with old → new | sales | "updated details" with Name/Phone/… | E2E:lead-detail, DB:leads |
| TL-06 | Reassignment logged | admin | "reassigned the lead from A to B" | E2E:assignment |
| TL-07 | Follow-up scheduled/rescheduled/completed/cancelled logged | sales | Matching entries | E2E:follow-ups |
| TL-08 | Newest first, "Show older activity" pagination | sales | Ordered, bounded | E2E:lead-detail |
| TL-09 | No raw JSON in the UI | all | Readable text only | E2E:lead-detail |

## 6. Follow-ups and reminders

| ID | Scenario | Role | Expected | Coverage |
| --- | --- | --- | --- | --- |
| FU-01 | Schedule (task + IST date/time) | sales | Shows under Upcoming + Follow-ups page | E2E:follow-ups |
| FU-02 | Empty task / time in the past | sales | Inline validation | E2E:follow-ups |
| FU-03 | Reschedule | sales | New time; new reminder revision; old one cancelled | E2E:follow-ups, DB:reminders |
| FU-04 | Complete with outcome + schedule next (atomic) | sales | Old completed, new pending | E2E:follow-ups, DB:leads |
| FU-05 | Cancel with confirmation | sales | Removed from pending, logged | E2E:follow-ups |
| FU-06 | Overdue derived from due time | sales | Red "Overdue" badge, Overdue tab, overdue filter, dashboard count | E2E:follow-ups |
| FU-07 | Times entered/displayed in IST regardless of browser timezone | sales | 10:30 IST stored as 05:00Z, shown as 10:30 am | E2E:follow-ups, UNIT:lib |
| FU-08 | Reassignment moves pending follow-ups + reminder recipient | admin | New owner sees task | E2E:assignment, DB:permissions |
| FU-09 | Completing an already-closed follow-up | sales | "already completed or cancelled" | DB:leads |
| FU-10 | Reminder for user without Telegram | – | Delivery marked failed: "Telegram not connected" (visible) | E2E:reminders (opt-in), DB:reminders |
| FU-11 | Worker overlap / lease expiry / retry / retry_after / batch bound | – | No double claim, bounded retries | DB:reminders, UNIT:worker-logic |
| FU-12 | Completed / cancelled / archived / rescheduled not delivered | – | Skipped | DB:reminders |
| FU-13 | Real Telegram message received while the browser is closed | sales | Message with lead, task, IST time, link | MANUAL |

## 7. Telegram linking

| ID | Scenario | Role | Expected | Coverage |
| --- | --- | --- | --- | --- |
| TG-01 | Webhook without / with wrong secret header | anon | 401 | E2E:telegram |
| TG-02 | Webhook GET | anon | 405 | E2E:telegram |
| TG-03 | Connect: link token → `/start <token>` webhook → Connected | all | Settings shows Connected | E2E:telegram |
| TG-04 | Reusing a consumed token | – | Rejected, connection unchanged | E2E:telegram, DB:reminders |
| TG-05 | Expired token | – | Rejected | DB:reminders |
| TG-06 | Disconnect | all | Not connected | E2E:telegram |
| TG-07 | Bot blocked by user | – | "Bot blocked" state | DB:reminders, MANUAL |

## 8. Realtime and freshness

| ID | Scenario | Role | Expected | Coverage |
| --- | --- | --- | --- | --- |
| RT-01 | Sales creates a lead → open Admin leads list updates without reload | admin | Row appears | E2E:realtime |
| RT-02 | Same event → Admin dashboard "Active leads" updates | admin | Count +1 | E2E:realtime |
| RT-03 | Other sales user's open list | sales B | Never receives the lead | E2E:realtime |
| RT-04 | Lead reassigned away → former owner's list drops it on refocus | sales | Row removed | E2E:realtime |
| RT-05 | Unsaved form input survives a background refresh | sales | Input kept | E2E:realtime |
| RT-06 | Network drop and reconnect | all | "Reconnecting…" then catch-up refetch | MANUAL |

## 9. Finance

| ID | Scenario | Role | Expected | Coverage |
| --- | --- | --- | --- | --- |
| FIN-01 | Add expense | account | Listed; month total increases exactly | E2E:finance |
| FIN-02 | Add capital | account | Capital total increases; expense total unchanged | E2E:finance, DB:finance |
| FIN-03 | Paise precision (e.g. 1,234.56 + 0.44) | account | Exact sum | E2E:finance, DB:finance |
| FIN-04 | Invalid amount: 0, negative, 3 decimals, text | account | Inline error, not saved | E2E:finance, DB:finance |
| FIN-05 | Edit → history shows old → new | account | History entry | E2E:finance, DB:finance |
| FIN-06 | Archive removes from totals; restore adds back | account | Totals change | E2E:finance, DB:finance |
| FIN-07 | Month/category filters | account | Server-side filtered | E2E:finance |
| FIN-08 | Admin has finance access too | admin | Can view and add | E2E:finance |
| FIN-09 | No profit/ROI/cash shown | all | Not present | E2E:finance |
| FIN-10 | Finance page: year picker, clickable month chart and one card per month (expense and capital totals, entry counts, change vs previous month, category split); a card opens that month's report | account | Card totals equal the report; click navigates | DB:finance-period, E2E:finance |
| FIN-11 | Expense and capital record mode of payment (required), optional item and nos; nos without an item is rejected; edits appear in history | account | Saved and shown in the row; history lists the change | DB:reports, UNIT:lib, E2E:finance |
| FIN-12 | "Repeat every month" adds the same expense on the same day next month (31st → month end), catches up missed months once, never duplicates; unticking stops the series; connected Admin/Account get a Telegram message | account | One expense per month; notification queued per recipient | DB:recurring, UNIT:worker-logic, E2E:finance (series created and stopped); MANUAL: Telegram message arrives |
| FIN-13 | Period report (`/finance/YYYY-MM` or `/finance/YYYY`): cards with previous-period and last-year comparisons, 13 charts (daily/monthly, running total, categories and vs previous, payment mode, monthly vs one-off, weekday, size bands, items, contributors, recorded by, largest); entries with escaped search, category/mode/monthly/archived filters, four sorts, paging and CSV, all kept in the URL; previous/next periods | account | Totals exact; newest response wins; CSV is formula-safe | DB:finance-period, UNIT:lib (parsePeriod), E2E:finance |
| FIN-14 | Malformed period (`/finance/2026-13`) | account | Not found | UNIT:lib, E2E:finance |
| FIN-15 | Sales opens a finance report URL or calls the period RPCs | sales | Redirected / forbidden | DB:finance-period, E2E:finance |

## 9a. Reports

| ID | Case | Role | Expected | Coverage |
| --- | --- | --- | --- | --- |
| REP-01 | Range picker (presets/custom, max ~3 years) drives every chart; range and tab kept in the URL; buckets day/week/month by range length | admin | All sections reflect the range | DB:reports, E2E:reports |
| REP-02 | Finance report: capital and expenses side by side (never netted), running capital total, categories, mode of payment, contributors, items with nos and per-unit amount, largest expenses | account | Totals exact to the paisa | DB:reports, E2E:reports |
| REP-03 | Sales report scope: Admin sees the team plus salesperson comparison; Sales sees only own leads; Account has no sales report; Sales has no finance report (UI and RPC) | all | Restricted data never returned | DB:reports, E2E:reports |

## 10. User management

| ID | Scenario | Role | Expected | Coverage |
| --- | --- | --- | --- | --- |
| USER-01 | Create user of each role, sign in immediately | admin | Works without email | E2E:users |
| USER-02 | Duplicate username | admin | "That username is already taken." | E2E:users, DB:permissions |
| USER-03 | Invalid username / short password | admin | Inline errors | E2E:users |
| USER-04 | Change role while user owns active leads | admin | "Reassign this user's active leads…" | E2E:users, DB:permissions |
| USER-05 | Search / role filter / pagination | admin | Server-side | E2E:users, DB:permissions |
| USER-06 | Deactivate / reactivate | admin | Sign-in blocked / allowed again | E2E:users |

## 11. Production hardening and performance

| ID | Scenario | Expected | Coverage |
| --- | --- | --- | --- |
| PROD-01 | Security headers on every page | `X-Frame-Options`, `frame-ancestors`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS | E2E:performance |
| PROD-02 | `site.webmanifest` / `robots.txt` reachable when signed out | Not redirected to login | E2E:performance |
| PROD-03 | No `X-Powered-By` header | Absent | E2E:performance |
| PROD-04 | List requests bounded (`p_limit` ≤ 100); DB rejects larger | Enforced | E2E:performance, DB:pagination |
| PROD-05 | No N+1: leads page issues one list RPC per query | One request | E2E:performance |
| PROD-06 | ECharts loaded lazily, not in the leads page bundle | Chunk only on dashboard | MANUAL (bundle analyzer) |
| PROD-07 | Deployed DB has the migrations (RPC guards active) | `invalid_limit`, `invalid_sort` returned | E2E:api-security |
