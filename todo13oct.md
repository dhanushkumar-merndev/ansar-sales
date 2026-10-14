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

### Deleting an ads client (super admin) — built, migration 3100 not applied
- [x] Migration `supabase/migrations/20261008003100_ads_client_delete.sql` (already live; the other 3100 file moved to 3250).
- [x] Client page → **Delete** (super admin): hidden everywhere, closed, sync stopped, logins off, client CRM archived, pending reminders skipped. Restorable.
- [x] Ads → Clients → **Deleted** (super admin): Restore, **Download Excel** (9 sheets: client, logins, CRM leads, timeline, follow-ups, Facebook leads, ad accounts, campaigns, daily results), then **Delete for good**, which is only allowed after a download made since the deletion.
- [x] Delete for good removes the client, its own ad accounts and history, its logins (Auth users too) and its client CRM. A category on our own ad account stays, unlinked.
- [x] Tests: `tests/db/ads-client-delete.test.ts`, `tests/unit/ads-client-export.test.ts`.
- [ ] Later (agreed): the same flow for leads.

### Bulk lead import from Excel — built, migration 3300 not applied
- [x] Leads → **Add lead ▾** → One lead / **Import from Excel**: template download, .xlsx pick or drop, every row checked in the browser, at most 500 leads per file.
- [x] Phones already in the CRM are skipped unless "import anyway" is ticked; rows with problems can be downloaded with the reason.
- [x] Migration `20261008003300_lead_import.sql`: `import_leads`, `lead_phones_in_crm`; one summary alert per person instead of one per lead.
- [x] Tests: `tests/db/lead-import.test.ts`, `tests/unit/lead-import.test.ts`.
- [ ] Apply 3300 and redeploy `reminder-worker` (it words the summary alert).
- Later: a follow-up date column.

### Campaigns that ran recently — built, migration 3400 not applied
- [x] Ads → Campaigns table: "Running now / Ran in the last 7, 14, 28 days / Not running / Any status". "Ran" = spent money on one of those days, paused since included.
- [x] Migration `20261008003400_campaigns_ran_recently.sql` (same `list_ad_campaigns` signature, new `p_status` values). Test in `tests/db/ads.test.ts`.

### Facebook niches without form numbers and dates — built, migration 3500 not applied
- [x] `20261008003500_form_niche_names.sql`: a Facebook lead's niche is the form name without "FORM 2 -", dates, times or "copy" ("FORM 2 - PROSPECTING CRM - JULY 22" → "PROSPECTING CRM"), so forms for the same product share one niche.
- [x] On apply, existing niches holding Facebook leads are renamed the same way; two that end up equal are merged (leads move, a "Niche" change shows on their timeline, the old niche is archived). Typed niches are not touched.
- [x] Tests: `tests/db/form-niche-names.test.ts`.

### Lead download for chosen dates — built, migration 3600 not applied
- [x] Leads → Download → **Choose dates…**: a dialog with the date-range picker (presets + calendar, IST days); downloads the active leads added on those days. They count as downloaded for "New since my last download".
- [x] `20261008003600_lead_export_dates.sql`: `export_leads` gains `p_created_from` / `p_created_before`. Until it is applied, only "Choose dates" fails; All and New keep working.
- [x] Test in `tests/db/lead-exports.test.ts`.

### "Add as client" on a lead — built, migration 3700 not applied
- [x] Lead page → **Add as client** (admins, ads managers, super admin; companies with ads, not inside a client's CRM): creates the ads client from the lead's details and tells the ads team, without marking the lead Won. Then the button becomes **Ads client** and opens it.
- [x] One client per lead: marking it Won later doesn't add a second. A deleted client must be restored from Ads → Clients → Deleted.
- [x] `20261008003700_lead_to_ads_client.sql`; tests `tests/db/lead-to-ads-client.test.ts`.

### Ad categories per company, set from Facebook leads — built, migration 3900 not applied
- [x] Super settings → Facebook leads → pick a company → **Leads from ad categories**: tick the categories of Star Growth Hub's ad account that are this company's. New Facebook leads from their campaigns go to its CRM; it sees those campaigns on its Ads page. Several categories per company; a company not yet sharing the account joins it on save.
- [x] Star Growth Hub (the account's owner) shows which categories went to whom. The Ads tab uses the same picker.
- [x] `20261008003900_company_ad_categories.sql` (needs 3250 first); tests `tests/db/company-ad-categories.test.ts`.
- Old leads are not moved (not agreed yet).

### Sync leads by period (super admin) — built, no migration
- [x] Ads → Our company → **Sync leads ▾**: Last 7 days / Last 30 days / All (90 days, what Meta keeps). Super admin only on that page; 30/90 days refused for others on the server. Reads every form of the Page; up to 3,000 leads per run; page `maxDuration` 300 s.
- Found on live (13 Oct): no category is linked to any company yet, and all 64 Facebook leads (58 from LEADS_LANDSCAPE ARCHITECT_OCT 10, Star Gardens' category) came in before routing existed, so they sit in Star Growth Hub. Moving them needs `company_guard` to allow a lead's company change: not built, waiting for the user's OK.

### Fresh start of Facebook leads (done on live, 13 Oct, user approved)
- Deleted Star Growth Hub's 322 leads (all Facebook) with their timeline, follow-ups, shared link, and its 336 Facebook lead records, so a sync re-imports and routes them by category. Star Gardens' 2 hand-typed leads kept. Categories Star Gardens / Star Tech India / Star Production House were already linked to their companies.

### Bulk Facebook sync — built, migration 4000 not applied
- [x] Sync leads saves 100 leads per database call (`ingest_meta_leads`), and each owner gets one "N leads imported to you" alert instead of one per lead (`notify_meta_leads_synced`). Form names come with the form list. The webhook still saves and alerts one lead at a time (real time).
- [x] Safe fallback: a batch the database can't take (e.g. 4000 not pushed yet) is saved one lead at a time as before.
- [x] Tests: `tests/db/meta-bulk-sync.test.ts`.

### Bell notifications of deleted leads — cleaned on live, migration 4100 not applied
- Done on live (13 Oct): removed the 322 "Lead assigned to you" bell notifications left by the fresh start (they keep the lead id only in their payload).
- [x] `20261008004100_lead_delete_notifications.sql`: deleting leads now also deletes their bell notifications (statement trigger). Test: `tests/db/lead-delete-notifications.test.ts`.

### Checks (13 Oct)
- `pnpm typecheck`, `pnpm lint`, `pnpm build`: clean.
- `pnpm test`: 409 pass. The only failures are the 5 old Star Gardens seed ones.

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
