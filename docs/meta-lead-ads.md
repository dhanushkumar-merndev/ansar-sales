# Facebook Lead Ads: connecting a company

Each company connects its own Meta app and Facebook Page. Leads from that Page's Lead Ads forms then
arrive in that company's CRM within seconds. They go to the sales users chosen under **Lead routing**: one
person gets them all; two or more get them in turn.

The company's admin sets this up from **Automation → Facebook**. One Meta app and token serve both the lead forms (Page ID)
and the Ads dashboard (ad account ID). The super admin can also do it for any company from **Super settings → Facebook leads**.

You need admin access to the company's **Meta Business portfolio** (business.facebook.com). That
portfolio must own, or have full control of, the Facebook Page.

## 1. Create the Meta app

1. Go to **developers.facebook.com → My Apps → Create app**.
2. Pick the use case **Capture & manage ad leads with Marketing API** (or **Other → Business**) and connect the app to the
   company's Business portfolio. That use case already includes every permission the CRM needs except
   `pages_manage_metadata`, which is optional there: add it under **Use cases → Customize → Permissions**. An app used only
   for an ads client's results can take **Measure ad performance data with Marketing API** instead. Meta doesn't let you
   remove a use case once it's added.

   That one use case is enough: lead capture already includes `ads_read` for the Ads dashboard and the Page permissions for
   lead forms. Ticking **Measure ad performance data with Marketing API** as well is fine (the Star Groups app has both);
   it only repeats `ads_read`. Leave the rest unticked (Create & manage ads, Manage everything on your Page, Facebook Login,
   Messenger, Instagram, WhatsApp, Threads, Catalog and so on): the CRM uses none of them.
3. In the app dashboard, add the **Webhooks** product. You don't need to configure it: the CRM registers the
   subscription itself.
4. **App settings → Basic**:
   - Add a Privacy Policy URL (Meta needs one before the app can go Live).
   - Copy the **App ID** and the **App secret** (click *Show*).

## 2. Create a system user and a token that never expires

1. Open **business.facebook.com → Settings → Users → System users**.
2. Click **Add** and create an **Admin** system user (e.g. "CRM").
3. Click **Assign assets**:
   - **Apps:** the app from step 1, with full control.
   - **Pages:** the company's Page, with full control (or at least *Manage Page* and leads access).
   - **Ad accounts** (for the Ads dashboard): *View performance* is enough.
4. Click **Generate new token**, select the app, and set **Token expiration: Never**. Tick these permissions:
   `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`,
   `pages_manage_ads`, `ads_read`. The CRM only reads from Meta, so `ads_management` and `business_management` are not
   needed (ticking them does no harm).
5. Copy the token now: Meta shows it only once.

Already have a token from this system user (for example the one another company uses)? You can reuse it. See
[One token for several companies](#tokens) before generating a new one.

## The token: what it's used for and what stops it working {#tokens}

**Meta app use case:** **Capture & manage ad leads with Marketing API**, plus `pages_manage_metadata` added under
**Use cases → Customize → Permissions**. *Measure ad performance data* may be added too (harmless); no *Manage everything on
your Page* or any other use case.

What the CRM asks Meta for. Everything is a read except subscribing the Page to lead events.

| What the CRM does | Meta call | Permission |
| --- | --- | --- |
| Check the token (**Connect & test**) | `GET /me` | none |
| Get the Page's own token | `GET /<page id>?fields=access_token` | `pages_show_list`, `pages_read_engagement` |
| Subscribe the Page to new leads | `POST /<page id>/subscribed_apps` | `pages_manage_metadata` |
| Point the app's webhook at the CRM | `POST /<app id>/subscriptions` (app ID + secret, not the token) | none |
| Read a lead and its form name; **Sync last 7 days** | `GET /<lead id>`, `/<page id>/leadgen_forms`, `/<form id>/leads` | `leads_retrieval`, `pages_manage_ads` |
| Ads dashboard: account, campaigns, ads, insights | `GET /act_<id>`, `/act_<id>/campaigns`, `/act_<id>/ads`, `/act_<id>/insights` | `ads_read` |

Ads calls are signed with the app secret (`appsecret_proof`), so the **App ID and App secret entered in the CRM must belong
to the same app the token was generated for**.

**One token for several companies.** A system user's token can reach every asset assigned to that system user *now*, not
only the ones assigned when the token was made. To connect another Page or ad account, assign it to the same system user
(**Assign assets**) and paste the same token, App ID and App secret into the other company's connection. You don't need a new
token. What a token can do (its permissions) is fixed when it's generated; which Pages and ad accounts it reaches is not.

**Generating another token.** Meta allows several tokens per system user, and in practice an older token keeps working when
you generate a new one. Meta doesn't state this outright for system users, so after generating one, press **Connect & test**
on every company that uses the older token to confirm.

**These break the token for every company that uses it:**
- **Revoke tokens** on the system user: cancels all of its tokens for the app you pick.
- The bin icon next to an asset on the system user: the token loses that Page or ad account at once.
- Deleting the system user, or removing the app from it.
- **Resetting the app secret:** the CRM's signed ads calls fail until the new secret is saved in every company that uses the
  app, and Meta may also invalidate tokens.
- Taking `leads_retrieval` access away under **Integrations → Leads access**: new leads stop arriving.

Each company's connection keeps its own encrypted copy of the token, so saving a new token in one company never changes another
company's.

<!-- super-admin -->
### Current setup (checked 15 Oct 2026)

Star Growth Hub's lead and ads connections both use one never-expiring token:

| | |
| --- | --- |
| System user | **Dhanush**, ID `61595275705362` in Business settings |
| App | **Star Groups**, App ID `966336746544305` |
| Page for lead forms | **StarGarden**, `1155579617648250` |
| Ad account | **Star Garden**, `act_1554836196332969` (View performance), shared with the other companies by category |
| Permissions | `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_manage_ads`, `ads_read` |

That is all the CRM needs. To connect another Page or ad account, assign it to **Dhanush** and reuse this token; don't press
**Revoke tokens** on Dhanush.
<!-- /super-admin -->

## 3. Find the Page ID

Use either of these:
- On the Facebook Page: **About → Page transparency → Page ID**.
- **Business settings → Accounts → Pages**: select the Page, and its ID is shown.

## 4. Allow the CRM to read leads

**Business settings → Integrations → Leads access**: select the Page and make sure the app (or the system
user) is allowed. If nobody is listed as restricted, everyone already has access.

## 5. Switch the app to Live

In the app dashboard, switch **App mode** from *Development* to **Live**. In Development mode, Meta only
delivers test leads made by app admins.

If Meta asks for **Advanced access** for `leads_retrieval` or `pages_manage_metadata`, request it under
**App Review → Permissions and features**. This is needed when the Page belongs to a different business than
the app.

## 6. Connect in the CRM

1. Sign in as the company's admin and open **Automation**, then press **Connect Facebook** on the Facebook card.
   (Super admin: open the company first, or use **Super settings → Facebook leads** and pick the company.)
2. On the **Connection** tab, enter the **App ID**, **App secret** and **system user token** once, then the **Page ID** (for lead
   forms) and/or the **ad account ID** (for the Ads dashboard). Press **Save**.
3. Press **Connect & test**. For lead forms the CRM checks four things (the ad account checks are described under
   *Facebook Ads dashboard* below):
   - the token works
   - it can manage the Page
   - the Page is subscribed to lead events
   - the app's webhook points to `https://<your CRM>/api/meta/webhook/<company id>`

   Each step shows ✓ or Meta's exact error message.
4. On the **Lead routing** tab, tick the sales users and press **Save routing**.

`NEXT_PUBLIC_APP_URL` must be the public **https** address of the deployed CRM (Meta cannot reach localhost).

## 7. Send a test lead

1. Open **developers.facebook.com/tools/lead-ads-testing**.
2. Pick the Page and a form, then press **Create lead**.
3. Within a few seconds the lead appears in the company's Leads list:
   - it is tagged *Facebook*
   - its niche is the form name
   - it has the form's other answers as a note
   - it is owned by the next user in the routing

   The owner also gets a Telegram message if they connected Telegram.

## How leads are handled

- **Same phone again:** if the company already has an active lead with that phone, no new lead is made. The
  existing lead gets a note "Submitted the Facebook form … again" with the new answers.
- **No valid phone:** the lead is listed as *Failed* under **Recent leads** with the reason.
- **Missed deliveries** (for example during an outage): press **Sync last 7 days**. Leads already in the CRM
  are never added twice.
- **Secrets:** the app secret and token are stored encrypted in Supabase Vault. They are never shown again
  and never sent to the browser. To change them, type new values and press Save.

## Facebook Ads dashboard {#ads}

The **Ads** page shows a company's spend, reach, impressions, clicks, results (leads), cost per result and every campaign
with its ads and upload dates. The CRM pulls these from Meta every hour and keeps them in its own database, so the history
stays even if the ad account is later disconnected.

1. Use a Meta app and a system user as in steps 1–2. The token needs **`ads_read`** in addition to the Lead Ads permissions
   (`read_insights` is for Page insights and isn't needed). You can reuse the same app and token as Lead Ads.
2. **Business settings → Users → System users → Assign assets → Ad accounts**: give the system user the company's ad account
   (*View performance* is enough).
3. Find the **ad account ID**: in Ads Manager, the number in the account picker, or `act=…` in the address bar.
4. In the CRM open **Automation → Facebook → Manage** and add the **ad account ID** next to the Page ID (same App ID, secret and
   token; ads managers can use **Ads → Connection**). Press **Save**, then **Connect & test**. The CRM checks the token, the
   account and the insights permission, then starts the first sync (the last 30 days). Each hour it adds new days and fills
   in up to a year of older history, 30 days at a time.
5. **Refresh now** on the Ads page pulls the latest numbers at once (at most every 5 minutes).

Notes:
- Meta reports days in the **ad account's timezone**, and numbers for the last few days can still change (late
  attribution); every sync re-reads the last three days.
- **Reach** counts unique people, so it can't be added up across days. Pick one whole calendar month to see the exact unique
  reach; for other ranges the CRM shows the daily reach summed, labelled as such.
- Numbers per **ad** are kept day by day for 90 days, then as monthly totals. Numbers per **campaign** are kept day by day
  permanently.

## One ad account for several companies {#ads-merge}

If one ad account runs campaigns for several companies (for example Star Growth Hub, Star Production House and Star Tech
India):

1. Connect the account once, in the company that owns it.
2. As super admin, open **Super settings → Ads → Shared ad accounts** and tick the companies it also runs campaigns for. Each
   ticked company gets a fixed category with its name.
3. On **Ads → Categories**, set a **match text** for each category (for example `SPH`). Campaigns whose name contains it are
   filed automatically; you can also pick a category per campaign in the table. Add your own categories as needed.
4. The owner company's admin and its ads managers see every campaign. A merged company's admin and ads managers see only the
   campaigns in their company's category.

## Ads managers {#ads-managers}

Ads managers see only **Ads** and **Ads clients**: never leads, finance or users. The super admin creates them in
**Super settings → Ads → Ads managers** and ticks the companies each one handles; they switch between those companies at the
top left. Unticking a company removes their access immediately.

## Ads clients and their portal {#ads-clients}

With **Automation → Won leads → ads clients** switched on (on for Star Growth Hub), every lead marked **Won** becomes an ads
client, and the ads managers get a Telegram message. Only the name, phone, email and niche move over, never the notes. You can
also add a client by hand on **Ads → Clients**.

Connect each client's own ads:

1. The client (or you, in their Business portfolio) creates a Meta app and an **Admin system user** as in steps 1–2, with a
   **never-expiring token** that has **`ads_read`**, and assigns their ad account to that system user (*View performance*
   is enough).
2. On the client's page in the CRM, open **Meta connection** and enter their **ad account ID, App ID, App secret and token**.
   The secret and token are stored encrypted in Supabase Vault and are never shown again.
3. Press **Connect & test**. Their results appear under **Results** and update every hour.

Give the client a login: on **Client login**, create a username and password and share them. The client signs in on the
same login page and sees only a read-only view of their own ad results: KPIs, charts, running campaigns, and their latest ads
with upload dates. They can't see anything else in the CRM.

When you **close** a client, syncing stops and (by default) their login is turned off. Everything synced until then stays on
the client's page. Reopening resumes syncing and fills in the gap.
