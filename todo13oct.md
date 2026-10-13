# To do — 13 Oct 2026

Picks up the 12 Oct session. Nothing is committed. All the work below is uncommitted in the working tree.

## In progress: a leads CRM for each ads client ("client CRM")
The full plan is in `~/.claude/plans/splendid-singing-sprout.md`.

**The idea:** each ads client gets its own workspace company (`companies.parent_company_id` = Star Growth Hub). Leads, follow-ups, timeline, pipeline, Telegram reminders and the Facebook Lead Ads connection all work there unchanged. Star Growth Hub admins, ads managers and the super admin switch in and act as Admin there. The client's own staff are normal users of the workspace.

### Slice 1: workspace, access and entry point — done
- [x] Migration `supabase/migrations/20261008002600_client_crm.sql` (workspace columns, who may enter, `current_company_id` / `my_roles` / `app_role` / `set_active_company`, `my_context()`, RLS, lead owners, `open_ads_client_crm`, `ads_client_crm_summary`).
- [x] Failing test fixed: an ads manager has no home company, so `member` came out null. `my_context()` now uses `is not distinct from`.
- [x] Added to 2600: client CRMs stay out of the super admin's lists (`super_list_companies`, `super_ads_overview`, `super_meta_overview`, `super_finance_groups`), and `lead_company()` so a lead link can switch to the right CRM.
- [x] `database.types.ts` regenerated (`pnpm db:types`).
- [x] `getCurrentProfile` reads `my_context`; agency staff are Admin inside a client CRM; client CRMs are not in the company switcher.
- [x] `client_workspace` feature; sidebar inside a client CRM: Dashboard, Leads, Follow-ups, Ad results, Users (admin). Users there can only be Admin or Sales.
- [x] `fetchStaff` includes ads managers (visible only inside client CRMs).
- [x] `/switch` lets anyone try; the database decides.
- [x] Workspace bar: "Working in X · client CRM of Star Growth Hub · Back to Star Growth Hub".
- [x] Client page **Leads** tab: "Create & open CRM", then tiles and "Open CRM".
- [x] Client login tab: note that CRM users are added inside the CRM → Users.
- [x] Telegram links: the lead page itself switches to the lead's CRM (`lead_company`), so reminder links stay `/leads/<id>` and the worker is unchanged.

### Slice 2: the client's Facebook leads, and ad results inside the CRM — done
- [x] Migration `supabase/migrations/20261008002700_client_crm_meta.sql`: `can_manage_meta`, `set_meta_routing`, `ingest_meta_lead` (our team can get the leads; fallback owner = the client's admin, else whoever of us created the CRM, else the super admin), `meta_can_manage`, `ads_client_crm_meta`.
- [x] "Facebook lead forms", "Who gets new Facebook leads" and "Recent Facebook leads" cards in the client's Leads tab (the existing cards, without the ad-account field). Ads managers can use them too.
- [x] `/ad-results` inside the CRM. `my_ads_client_id()` now also returns the client whose CRM you are working in, so no separate `viewer_ads_client_id()` was needed.
- [x] Tests: `tests/db/client-crm.test.ts` (12) and `tests/unit/nav.test.ts`.

### Slice 3: client leads without connecting twice — built, migration 2800 not applied
- [x] Migration `supabase/migrations/20261008002800_client_crm_auto_leads.sql`.
- [x] A lead that reaches OUR Facebook connection from a campaign in the client's category on our ad account goes to that client's CRM (`ingest_meta_lead` + `p_campaign_id`). Old leads are not moved.
- [x] The client's own Page can be connected with our Meta app: only the Page ID is typed (`connect_client_page`). The webhook now passes on leads of other Pages served by the same app.
- [x] Client's Leads tab says when leads arrive automatically; our inbox says which client's CRM a lead went to.
- [x] Fix: the client page title showed our company name instead of the client's (`ads_client_detail` → `agency_name`).
- [ ] Apply 2800 (`supabase db push`), then deploy the app. The live webhook runs on the deployed app, so routing starts only after the deploy.

### Checks (13 Oct)
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: clean.
- `pnpm test`: 366 pass. The only failures are the 5 old Star Gardens seed ones.

### Still to do
- [ ] Apply 2600 and 2700 to the live DB, then click through it in the browser. This has not been done: the feature was only tested at the database level.
  1. Ads → a client → Leads → Create & open CRM.
  2. In the CRM: add a lead, schedule a follow-up, get the Telegram reminder, open its link while working in Star Growth Hub.
  3. Back to Star Growth Hub: our Leads don't show it.
  4. Add a Sales user in the CRM's Users page and sign in as them.
  5. Connect a client's Page and send a test lead with Meta's Lead Ads Testing Tool. The real Meta connection is untested.
- [ ] Commit.

## Done on 12 Oct (built locally, not yet live)
- Delete a disconnected ad account's history: migration 2200 plus a button on the Ads page.
- Notification icons instead of emoji: bell, notifications page and toast.
- "Add campaigns" multi-select in the Categories dialog.
- Ads clients can run on our ad account, their own, or both, with a combined summary and an Active-needs-a-source rule: migration 2300.
- Company name on leads and ads clients; "Business" relabelled "Industry": migration 2400.
- Ads client list: Business and Client columns, alignment fixes.
- Tigris → Cloudflare R2: was looked at and **reverted**. We stay on Tigris.

## Before deploying
- Migrations waiting for the live DB: 1500–2100 (Star Gardens, from earlier) plus 2200, 2300, 2400, 2500 (made by another session), 2600 and 2700. Run `supabase migration list --linked` first.
- **Apply 2400 before deploying the app**, because the create/update lead functions changed.
- 2600 changes `current_company_id` / `app_role`; the whole db test suite passes with it. 2700 follows it.
- **Apply 2600 and 2700 before deploying the app.** The app now reads `my_context()` and `companies.parent_company_id` on every request; without them nobody can sign in.
- New (13 Oct): **2900** (Leads → Download Excel, all / new since my last download) and **3000** (client portal: view-only leads, switched per client on Ads → client → Client login). Apply after 2800, before deploying the app.
- Nothing has been applied or deployed yet.
