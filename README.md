# pd-apply — Pacific Discovery online application

The four-step application flow, hosted on Netlify (e.g. `apply.pacificdiscovery.org`):

| Step | What the applicant does | What happens behind the scenes |
|---|---|---|
| 1 · About you | Name, DOB, email, mobile, gender, program, travel dates (mirrors Jotform form `251668678208874`) | Application row created in Neon. Mirrored into Jotform form 1. HubSpot contact created or updated (always). With `HUBSPOT_SYNC=on`, a deal is created in **PD Applications** (amount = program price, `pd_program`, `travel_year`). An alert email goes to **admissions@pacificdiscovery.org** with their details and HubSpot links (reply-to is the applicant). |
| 2 · Application | The full application (mirrors Jotform form `240277257210046`), incl. photo upload | Saved + mirrored into Jotform form 2 with the same field IDs (identity fields carried over from step 1). HubSpot contact updated with any mapped fields. Unless the fee is already paid, the deal is put in **PD Applications → Application Complete**. If neither pd-apply nor the Zap has made a deal yet, one is created there; if the Zap put it in another pipeline, it's moved. Parent/guardian contacts are created (by email) and associated to the student (**Parent** label) and the deal; the student, parents and deal are associated to the matching **Pacific Discovery program** record (custom object `2-58411705`, matched by program + season + year from its start date) with the **Student** / **Parent** labels the portals use. |
| 3 · Interview | Books a time in the embedded HubSpot scheduler (`eda-admissions/pacific-discovery-interviews`), prefilled with name + email | The booking moves them on automatically. A note is added to the HubSpot contact/deal. |
|   | *Can't book?* | After 30 seconds (or straight away if the scheduler doesn't load) a **"Can't find a time, or the calendar won't load?"** option appears. They pick a reason, add an optional note, and continue to payment; admissions@ gets an **Interview needed** email and a note is added in HubSpot. Shown as *Interview needed* in the dashboard. Switch off or change the delay under *Fee, interview & text*. |
| 4 · Application fee | Pays **$250 + 3.5 % card fee = $258.75** via Stripe Checkout | Payment confirmed (return page + webhook, idempotent). Deal moved to the right **program pipeline** → **Application Fee Received**, with `pd_program`, `travel_year` and `payment_N = "250, pi_…, YYYY-MM-DD"`. |

Applicants can leave and come back. Their place is kept in the browser and every screen is rebuilt from the server.

**Fields, programs, prices, travel dates, fee, interview link and wording are all edited in the dashboard** (`dashboard.pacificdiscovery.org/apply-form/`). No code change is needed to add or adjust a field.

## How it fits together

```
 pd-dashboard  /apply-form/  ──writes──▶  Neon: apply_forms (draft / published)
                                                 │ reads published
 applicant ──▶ pd-apply (this site) ─────────────┘
                 │ writes Neon: applications, apply_files (+ Blobs "apply-uploads")
                 ├──▶ Jotform  (mirror, same field IDs — while JOTFORM_MIRROR=on)
                 ├──▶ HubSpot  (contact, deal, pipeline move, payment_N)
                 └──▶ Stripe   (Checkout + webhook)

 student portal / instructor portal / dashboard enrollment + sales funnel
   └── read Jotform as before, PLUS /api/service/submissions on pd-apply
       (Jotform-shaped, mirrored duplicates dropped) — so the Jotform forms
       can be archived once the mirror is switched off.
```

`public/form-kit.mjs` is the form engine (rendering, conditions, validation, Jotform shape). The browser, the server functions and the dashboard editor all use it. The dashboard keeps a pinned copy, so after changing it here run `npm run sync:form-kit` in pd-dashboard.

### Pipeline routing when the fee is paid

| Program type (set per program in the dashboard) | Season of the chosen travel date | Pipeline |
|---|---|---|
| Summer | Summer | Summer Program |
| Gap semester | Fall / Spring | Fall Semester / Spring Semester |
| Mini semester | Fall / Spring | Fall Mini Semester / Spring Mini Semester |

The stage is the pipeline's "Application Fee Received" (or "…Paid") stage. `pd_program` comes from the value set on the program in the dashboard. If that's blank, the closest HubSpot option is used. `travel_year` is the year of the travel date. Pipelines and stages are looked up by label, with the known IDs as a fallback, so renaming a stage only needs a matching label.

## Setup

1. **Database.** In the Neon SQL editor for the dashboard's database, run `MIGRATION-apply.sql` (it's in pd-dashboard).
2. **Create the Netlify site** from this repo. Publish dir `public`, functions `netlify/functions` (already in `netlify.toml`).
3. **Environment variables** (Site settings → Environment variables):

   | Variable | Value |
   |---|---|
   | `APPLY_DATABASE_URL` | the dashboard site's `NETLIFY_DATABASE_URL` (same Neon DB) |
   | `APPLY_SITE_URL` | `https://apply.pacificdiscovery.org` |
   | `APPLY_SERVICE_KEY` | a long random secret (`openssl rand -hex 32`), shared with the dashboard and both portals |
   | `HUBSPOT_TOKEN` | private-app token. Scopes: contacts read/write, deals read/write, deal schemas read, **forms** (for the source-tracking form submissions; without it the public submit endpoint is used) |
   | `JOTFORM_API_KEY` | same key the portals use |
   | `STRIPE_SECRET_KEY` | same Stripe account as the student portal |
   | `STRIPE_WEBHOOK_SECRET` | from step 5 |
   | `JOTFORM_MIRROR` | `on` (default). Set `off` once you're ready to archive the Jotform forms |
   | `HUBSPOT_SYNC` | `on` (default) = pd-apply creates the contact + deal. **Turn the Zapier Zap off** at the same time (see below) |
   | `HUBSPOT_PAYMENT_SYNC` | `on` (default) = pipeline move + `payment_N` on payment |
   | `HUBSPOT_COMPANY_TAG` | optional, default `Pacific Discovery` |
   | `SMTP_USER` / `SMTP_PASS` | the same Google Workspace mailbox + App Password the student portal uses for its emails. Needed for the admissions alert |
   | `ADMISSIONS_ALERT_EMAIL` | optional, default `admissions@pacificdiscovery.org` (comma-separate several, `off` to disable) |
   | `SMTP_FROM_NAME` | optional, default `Pacific Discovery Applications` |
   | `HUBSPOT_PROGRAM_OBJECT` | optional, default `2-58411705` (Pacific Discovery program object) |
   | `HUBSPOT_PARENT_LABEL`, `HUBSPOT_DEAL_STUDENT_LABEL`, `HUBSPOT_DEAL_PARENT_LABEL`, `HUBSPOT_PROGRAM_STUDENT_LABEL`, `HUBSPOT_PROGRAM_PARENT_LABEL` | optional association-label names; defaults `Parent` / `Student` / `Parent` / `Student` / `Parent` |
   | `HUBSPOT_PORTAL_ID` | optional, default `3855728` — used for HubSpot form submissions |
   | `HUBSPOT_STEP1_FORM_GUID`, `HUBSPOT_QUIZ_FORM_GUID` | optional fallbacks; normally the HubSpot form IDs are set in the dashboard (Apply Form → Fee, interview & text; Quiz → Settings & HubSpot) |
   | `HUBSPOT_APPLICATION_PIPELINE` | optional; the application pipeline's name or ID, default `PD Applications` |

4. **Domain:** add `apply.pacificdiscovery.org` to the site.
5. **Stripe webhook:** Developers → Webhooks → Add endpoint `https://apply.pacificdiscovery.org/api/stripe-webhook`, events `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. Other Stripe sessions (the student portal's) are ignored.
6. **Dashboard:** deploy pd-dashboard, set `APPLY_SITE_URL` + `APPLY_SERVICE_KEY` there, open **Apply Form**. The form seeds itself from the live Jotform forms. Check the Programs tab (Japan Summer Program has no price on the current Jotform, and PD Program values need picking), then **Publish**.
7. **Portals:** set `APPLY_SERVICE_URL=https://apply.pacificdiscovery.org` and `APPLY_SERVICE_KEY` on the student and instructor portal sites, then deploy them.
8. **Website:** point the "Apply" buttons at `https://apply.pacificdiscovery.org`. UTM/gclid/fbclid parameters on that link are captured. To embed it in a page instead:

   ```html
   <iframe id="pd-apply" src="https://apply.pacificdiscovery.org/?embed=1" style="width:100%;border:0;min-height:900px" title="Apply to Pacific Discovery"></iframe>
   <script>
     addEventListener('message', function (e) {
       if (e.origin === 'https://apply.pacificdiscovery.org' && e.data && e.data.pdApplyHeight)
         document.getElementById('pd-apply').style.height = e.data.pdApplyHeight + 'px';
     });
   </script>
   ```
   Pass the page's own UTMs through by adding them to the iframe `src` (and `&page=<page url>` to record the landing page).

### Zapier and HubSpot — pick one owner for step 1

Today a Zap watches Jotform form 1 and creates the HubSpot contact and deal. With the mirror on, the Zap would still fire. Choose one:

- **Recommended:** `HUBSPOT_SYNC=on` and **turn the Zap off**. pd-apply creates the contact and deal itself, so archiving Jotform later doesn't break anything.
- **Keep the Zap for now:** `HUBSPOT_SYNC=off`. The Zap keeps creating the deal from the mirrored submission. On payment, pd-apply finds that deal (the newest PD Applications deal for the contact) and moves it.

If both run, pd-apply reuses a deal the Zap already made but can't stop the Zap creating a second one, so don't leave both on.

### Archiving the Jotform forms

Archived or disabled Jotform forms don't count toward the form limit. But while `JOTFORM_MIRROR=on`, form 1 and form 2 must stay **enabled** to accept the mirrored submissions. To retire them:

1. Run for a while with the mirror on and the portal adapters deployed. Check a few applicants in the student portal, the instructor portal (photo, medical modal), Enrollment (T-shirt sizes) and Sales Funnel (attribution).
2. Turn the Zap off (if you haven't already) and set `JOTFORM_MIRROR=off`.
3. Archive both forms. Older submissions are still read from Jotform by the portals. New ones come from pd-apply.

Jotform notification and autoresponder emails can fire on mirrored submissions. Check those after launch, and recreate any you rely on in HubSpot before switching the mirror off.

## Gap-year quiz (`/quiz`) and real lead sources

`apply.pacificdiscovery.org/quiz` replaces Jotform form `252958612162864`: the same
15 questions and the same scoring for the five results (Adventurer, Cultural
Connector, Ocean Guardian, Changemaker, Seeker — ties go to the one listed first).
It's edited in the dashboard (**Apply Form → Quiz editor**); until the first
publish there, the copy bundled here (`scripts/quiz-seed.json`) is served.
After the result, “Start your application” opens the application with name,
email and phone already filled in.

**Why HubSpot said "Offline Sources".** Contacts created by Zapier / Make / the
CRM API have no visitor cookie, so HubSpot can't see the visit. Now, for both the
quiz and application step 1, the sync:

1. submits to a **HubSpot form** with the visitor's `hubspotutk` cookie, page URL
   and IP — this creates the contact, so HubSpot's Original Source is the real
   channel (the HubSpot tracking code is on every page here to set that cookie);
2. waits for HubSpot to process it (up to 30 s in the background function);
3. writes the rest via the CRM API: the `pd_first_*` (never overwritten) and
   `pd_last_*` source properties (channel, source, medium, campaign, ad click id,
   landing page, referring site), `utm_*`/`gclid`/`fbclid` if those properties
   exist, plus for the quiz `pd_quiz_archetype`, `pd_quiz_answers`, `pd_quiz_date`
   and lead status `NEW` (only if empty).

This runs *before* the Jotform mirror, so an old Zap firing off the mirrored
submission can't create the contact first. Turn those Zaps off anyway.

`/attribution.js` keeps the first and latest campaign visit in a
`.pacificdiscovery.org` cookie (`pd_attr`, no personal data). Add it to every page
of the main website so a visitor who arrives from an ad and takes the quiz days
later is still credited to the ad:

```html
<script src="https://apply.pacificdiscovery.org/attribution.js" async></script>
```

HubSpot's "collected forms" script is deliberately blocked by the CSP here so it
doesn't submit the quiz a second time. Turn off HubSpot's notification emails on
the two forms if you don't want one per submission.

Setup: run `MIGRATION-quiz.sql` (dashboard repo) in Neon; in the dashboard click
**Lead Sources → Set up HubSpot properties**, then **Create in HubSpot** for the
form in both the Quiz and Apply Form settings, and publish both. Point the old
quiz link (and any Cloudflare redirect) at `https://apply.pacificdiscovery.org/quiz`.

## Testing the flow by hand (preview mode)

The quiz has the same switch: `/quiz?preview=1` scores locally and sends nothing.

Open `https://apply.pacificdiscovery.org/?preview=1` (or **Test the flow ↗** in the dashboard editor). A yellow bar lets you jump to any screen, and **Fill in test answers** pre-fills both forms. You can also go straight to a screen with `&step=step2|interview|payment|done`.

Nothing is saved or sent in preview: no application is created, and nothing goes to HubSpot, Jotform, Stripe or email. Field checks still run. Two notes:

- Preview shows the **published** form, so publish your edits first.
- The interview step embeds the real HubSpot scheduler, so booking a time there makes a real meeting. Use **Jump to → 4 · Fee** to skip past it.

For a full end-to-end test (HubSpot, alerts, real payment), use a real test application with your own email, then mark it **withdrawn** in the dashboard and delete the test contact and deal in HubSpot.

## Service API (for the portals and dashboard)

Every call needs the header `x-apply-key: $APPLY_SERVICE_KEY`.

- `GET /api/service/submissions?form=<jotformFormId>&email=`: applications in Jotform submission shape. IDs look like `pda_<uuid>`, and `jotform_id` is the mirrored Jotform submission.
- `GET|POST /api/service/submission/pda_<uuid>`: read, or apply a portal edit (`submission[qid]=…`, the same params as Jotform). Edits are mirrored to Jotform while the mirror is on.
- `POST /api/service/resync {id}`: re-run the Jotform/HubSpot sync (the dashboard's "Retry sync").
- `GET /api/file/<uuid>`: an uploaded file (the photo).

## Privacy and security

- The applicant's token is the only credential. It's random, stored hashed, and kept in the browser.
- Step-2 answers are never sent back to the browser. Unsent drafts stay in `sessionStorage` for that tab only and exclude the photo.
- Uploads accept photos only, up to the size set on the field (10 MB by default). They're stored in Netlify Blobs and only served with the service key.
- Light abuse protection: a honeypot field, and at most 8 new applications per IP per hour.
- HubSpot property writes skip any property HubSpot rejects (and log it on the application) rather than failing.

## Tests

```bash
npm install
npm test                           # engine + HubSpot routing (no services needed)
TEST_PG_URL=postgres://… npm run test:flow   # every step through the real handlers, against a local Postgres
TEST_PG_URL=postgres://… npm run test:ui     # the whole flow in Chromium, desktop + mobile
```

The flow and UI tests run the real functions against a local Postgres (with `MIGRATION-apply.sql` applied). HubSpot, Jotform and Stripe are faked in `test/harness.mjs`.
