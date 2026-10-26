# pd-apply — Pacific Discovery online application

The four-step application flow, hosted on Netlify (e.g. `apply.pacificdiscovery.org`):

| Step | What the applicant does | What happens behind the scenes |
|---|---|---|
| 1 · About you | Name, DOB, email, mobile, gender, program, travel dates (mirrors Jotform form `251668678208874`) | Application row created in Neon. Mirrored into Jotform form 1. HubSpot contact created or updated (always). With `HUBSPOT_SYNC=on`, a deal is created in **PD Applications** (amount = program price, `pd_program`, `travel_year`). An alert email goes to **admissions@pacificdiscovery.org** with their details and HubSpot links (reply-to is the applicant). |
| 2 · Application | The full application (mirrors Jotform form `240277257210046`), incl. photo upload | Saved + mirrored into Jotform form 2 with the same field IDs (identity fields carried over from step 1). HubSpot contact updated with any mapped fields. Unless the fee is already paid, the deal is put in **PD Applications → Application Complete**. If neither pd-apply nor the Zap has made a deal yet, one is created there; if the Zap put it in another pipeline, it's moved. Parent/guardian contacts are created (by email) and associated to the student (**Parent** label) and the deal; the student, parents and deal are associated to the matching **Pacific Discovery program** record (custom object `2-58411705`, matched by program + season + year from its start date) with the **Student** / **Parent** labels the portals use. |
| 3 · Interview | Books a time in the embedded HubSpot scheduler (`eda-admissions/pacific-discovery-interviews`), prefilled with name + email | The booking moves them on automatically. A note is added to the HubSpot contact/deal. |
|   | *Can't book?* | After 30 seconds (or straight away if the scheduler doesn't load) a **"Can't find a time, or the calendar won't load?"** option appears. They pick a reason, add an optional note, and continue to payment; admissions@ gets an **Interview needed** email and a note is added in HubSpot. Shown as *Interview needed* in the dashboard. Switch off or change the delay under *Fee, interview & text*. |
| 4 · Application fee | Pays **$250 + 3.5 % card fee = $258.75** via Stripe Checkout. The refund wording (dashboard → *Fee, interview & text*) and a link to the Program Terms & Conditions are shown on the payment screen and on Stripe's page. | Payment confirmed (return page + webhook, idempotent). The live terms version is recorded on the payment. The student **and every parent/guardian** get the "application fee received" email from admissions@ with the terms at the bottom, and admissions@ gets a "fee paid" alert (both once; only for fees paid in the last 3 days, so re-syncing an old application never emails anyone). Deal moved to the right **program pipeline** → **Application Fee Received**, with `pd_program`, `travel_year` and `payment_N = "250, pi_…, YYYY-MM-DD"`. |

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
5. **Stripe webhook:** Developers → Webhooks → Add endpoint `https://apply.pacificdiscovery.org/api/stripe-webhook`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed` (bank deposits that bounce). Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. Other Stripe sessions (the student portal's) are ignored.
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
   and lead status `NEW`.

Starting the application, completing it, and taking the quiz each set lead
status to `NEW` ("New lead") — always, whatever it was before (admissions'
working statuses included). Lifecycle stage moves to `lead` only from empty or
Subscriber: HubSpot won't move a stage backwards through the API, and a
customer or alumnus stays one.

**Wrong HubSpot account guard.** Before writing anything, every sync checks
which HubSpot account `HUBSPOT_TOKEN` belongs to (`/account-info/v3/details`)
against `HUBSPOT_PORTAL_ID` (default `3855728`). A token from any other account
(sandbox, test portal) is refused: nothing is written and the application /
quiz response shows the error instead of "Synced". Fix the token, then use
Retry sync / Resend.

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

## Tracking (Meta, Google, TikTok, GTM)

The quiz and the application load ad / analytics tags from `/tracking.js`. The
IDs live in **Netlify environment variables**, so adding or changing a code is
an env change + redeploy, no code change. Only what's set is loaded; nothing
loads in preview mode (`?preview=1`).

| Variable | Value |
|---|---|
| `META_PIXEL_ID` | Meta pixel / dataset ID (Events Manager) |
| `META_CAPI_TOKEN` | Conversions API token (Events Manager → the pixel → Settings → *Generate access token*). Server-side only, never sent to the browser |
| `META_TEST_EVENT_CODE` | optional, e.g. `TEST12345` while testing — events appear under *Test events*. **Remove before going live** |
| `META_GRAPH_VERSION` | optional, default `v23.0` |
| `GA4_MEASUREMENT_ID` | `G-XXXXXXX` |
| `GOOGLE_ADS_ID` | `AW-XXXXXXXXX` |
| `GOOGLE_ADS_LABELS` | conversion labels per event, e.g. `quiz_lead=AbC123,application_start=DeF456,application_fee_paid=GhI789` |
| `TIKTOK_PIXEL_ID` | TikTok pixel ID |
| `TIKTOK_EVENTS_API_TOKEN` | TikTok Events API token (Events Manager → the pixel → Settings → Events API → *Generate access token*). Server-side only. Without it, TikTok gets browser events only |
| `TIKTOK_TEST_EVENT_CODE` | Optional — server events show under *Test events* while testing. Remove when done |
| `GTM_ID` | optional `GTM-XXXXXXX`. Use GTM *or* the GA4/Ads variables, not both for the same tag, or events double |
| `TRACKING` | `off` switches every tag and server event off |

**Funnel events** (same names everywhere; also pushed to `dataLayer` as `pd_<name>`):

| Event | When | Meta | GA4 | TikTok |
|---|---|---|---|---|
| `quiz_start` | "Start the quiz" | `QuizStart` (custom) | `quiz_start` | — |
| `quiz_lead` | quiz submitted | **`Lead`** | `generate_lead` | `SubmitForm` |
| `application_start` | step 1 saved | `CompleteRegistration` | `application_start` | `CompleteRegistration` |
| `application_submit` | full application saved | `SubmitApplication` | `application_submit` | `SubmitApplication` |
| `interview_booked` | interview booked | `Schedule` | `interview_booked` | `Schedule` |
| `application_fee_paid` | fee paid | **`Purchase`** (value 250) | `purchase` | `CompletePayment` |

**Meta Conversions API.** Every Meta event except `QuizStart` is also sent
from the server (hashed email / phone / name, IP, user agent, `_fbp`, and `fbc`
from the `_fbc` cookie or the stored `fbclid`), so ad blockers and iOS don't
lose conversions. The browser and server share an event ID, so Meta counts each
once. The `Purchase` is sent when the payment is first confirmed (return page or
Stripe webhook), so it lands even if the applicant closes the tab at Stripe.

**When embedded** on www.pacificdiscovery.org, the tags still fire inside the
iframe (the host page's pixel counts the page view), and each event is also
posted to the parent as `{ pdTrack: { event, eventId, data } }`.

**CSP.** `netlify.toml` allows Meta, Google (gtag/GTM/Ads) and TikTok.
`'unsafe-inline'` stays off, so GTM *Custom HTML* tags won't run: use GTM's
built-in templates, or add the vendor to `/tracking.js` (and its domains to the CSP).

**Check it:** set `META_TEST_EVENT_CODE`, take the quiz, and watch *Test events*
in Events Manager. Each event should show *Browser* and *Server*, de-duplicated.

### HubSpot forms on the main site (program booklet, …)

`/hs-form-tracking.js` tracks HubSpot forms embedded on www.pacificdiscovery.org.
Add it once in GTM (container GTM-WJR7B3): **Tags → New → Custom HTML**, trigger
**All Pages**:

```html
<script src="https://apply.pacificdiscovery.org/hs-form-tracking.js" async></script>
```

When a tracked form is submitted it fires the Meta pixel event (with an event ID),
posts the submission to `/api/track/form`, which sends the same event through the
Conversions API (hashed email/phone/name, IP, user agent, `_fbp`/`_fbc` or the
`fbclid` from `pd_attr`), and pushes `pd_form_lead` to `dataLayer`.

| Form | HubSpot form ID | Meta event |
|---|---|---|
| Request a program booklet | `a0bba9a0-aead-4667-81a9-5fa634fae057` | `Lead` (content_name "Program booklet request") |

To track another form, add its ID to `FORMS` in `public/hs-form-tracking.js` **and**
`SITE_FORMS` in `netlify/functions/_lib/tracking.mjs` (the server only accepts listed
forms, and only from `*.pacificdiscovery.org`). Uses the same `META_PIXEL_ID` /
`META_CAPI_TOKEN`.

The browser pixel event goes to every Meta pixel on the page; the server event goes
to `META_PIXEL_ID`.

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
TEST_PG_URL=postgres://… node test/accept.smoke.mjs   # the acceptance page in Chromium
```

The flow and UI tests run the real functions against a local Postgres (with pd-dashboard's `MIGRATION-apply.sql`, `-reminders`, `-decisions` and `-enrolment` applied). HubSpot, Jotform and Stripe are faked in `test/harness.mjs`.

## Program Terms & Conditions

Edited and published in the dashboard (Apply Form → **Terms**; tables in pd-dashboard's `MIGRATION-terms.sql`). This site serves them:

| | |
|---|---|
| `GET /api/terms` | live version as `{ title, version, publishedAt, markdown, html }` — any origin may read it |
| `GET /api/terms?v=3` | a specific version (what a family agreed to) |
| `/terms` | stand-alone page (`/terms?v=3` for a version) |
| `/terms-embed.js` | the website embed: `<div id="pd-terms"></div><script src="https://apply.pacificdiscovery.org/terms-embed.js" defer></script>` |

Format and email helpers are in `public/terms-kit.mjs` (pinned copy in the dashboard's `apply-form/`).

## Emails to families

Sent to the student and every parent/guardian email on the application, **from** `APPLICANT_FROM_EMAIL` (default `admissions@pacificdiscovery.org`, display name `APPLICANT_FROM_NAME`, default "Pacific Discovery Admissions"), reply-to the same, through the existing `SMTP_USER` / `SMTP_PASS` mailbox.

**Gmail only uses that From address if the `SMTP_USER` mailbox is allowed to send as it.** Either set `SMTP_USER` to the admissions@ mailbox (with its own App Password), or in the `SMTP_USER` mailbox go to Settings → Accounts → *Send mail as* → add admissions@pacificdiscovery.org. Otherwise Gmail silently sends from `SMTP_USER`.

Wording is edited in the dashboard (Fee, interview & text → *Email: application fee received*); empty fields use the defaults in `terms-kit.mjs`.

## Application-fee reminders

`netlify/functions/apply-reminders.mjs` runs hourly (Netlify scheduled function). For each application with the full application in, no fee paid, not withdrawn and not stopped by admissions, it sends reminder 1–4 at **1, 4, 10 and 21 days** after `step2_at`, then marks it closed at 28 days (`_lib/reminders.mjs`). Emails go to the student and every parent/guardian (same sender setup as above) with a personal **continue your application** link — a fresh resume token per email, stored hashed in `applications.link_token_hashes` (all kept, so every emailed link keeps working for good), and the applicant's own browser token keeps working.

Off until switched on in the dashboard (Fee, interview & text → Reminders, then Publish). The switch-on time is recorded and only applications completed after it are reminded. Needs pd-dashboard's `MIGRATION-reminders.sql`. A missed run sends only the latest due reminder; each send is claimed in the database first so overlapping runs can't double-send; a failed send is released and retried next hour (`reminders.lastError`). At most 60 emails per run.

Tests: `node test/reminders.test.mjs` (needs `TEST_PG_URL`, included in `npm run test:flow`).

## HubSpot activity

Every email sent to a family (fee confirmation, the four fee reminders, and the later acceptance / payment emails) is logged as an outgoing email on the **student's and each parent's contact timeline and on the deal** (`_lib/email-log.mjs` → CRM Emails object, association types 198 contact / 210 deal). Reminder links are logins, so the logged copy has the personal link replaced with the plain site address.

Logging needs the HubSpot private app to be allowed to create email engagements. If HubSpot refuses (403, missing scope), the email still goes; the application shows *Fee confirmation logged in HubSpot — needs a look* with HubSpot's message. Add the scope it names to the private app, then **Retry sync** — the log is written then, and the family is not emailed again. Admissions-only alerts (new applicant, interview needed, fee paid) are not logged on the family's timeline.

## Interviews booked outside the application

Families can also book from the "Book your interview" button in their emails, a link admissions sends, or on a call — those bookings go straight into HubSpot. Before any email to the family (fee confirmation, each reminder) and on every sync / **Retry sync**, `_lib/interview-check.mjs` looks at the meetings on the student's HubSpot contact. A meeting counts when its title contains the dashboard's *interview match* text (default "interview"), it was created after the application started, and it isn't cancelled, rescheduled or a no-show; the earliest upcoming one wins. The application is then marked interview-booked (`interview.source = "hubspot"`), emails say "pay the fee" instead of "book your interview", and the dashboard shows it. The time is shown in `INTERVIEW_TZ` (default `America/Denver`). Needs the HubSpot private app to read meetings; if it can't, nothing breaks — the application just stays "not booked".

## Decisions: accept / decline

Made in the dashboard (Applications → open an applicant → **Accept** / **Decline**; roles in the dashboard's `APPLY_DECISION_ROLES`, default admin + admissions) and carried out here through `POST /api/service/decision` (`_lib/decisions.mjs`). Needs pd-dashboard's `MIGRATION-decisions.sql`.

- **Accept** (fee must be paid; the program's HubSpot record must have a *Program Start Date*): the offer is fixed — tuition (deal amount, else the price in Programs & dates), start date, $2,250 deposit. Place held for 7 days (`settings.acceptance.holdDays`; admissions can **Extend hold**), HubSpot deal → "Interview Complete", note on the timeline. The student and parents get the editable *accepted* email with a personal **Confirm my place** link (logged in HubSpot with the link removed).
- **Decline**: refunds the application fee in full through Stripe first — the default unless they had been accepted, and admissions can untick it. If Stripe refuses, nothing else happens. Then the student and parents get the editable "not accepted" email (logged in HubSpot), the deal moves to "Closed Lost", and a note records the refund. Reminders stop. Declines are final from the dashboard.
- One decision at a time per application, so a double click can't refund or email twice.

## Acceptance page and deposit (`/accept`)

The personal link opens `public/accept.html`. Needs pd-dashboard's `MIGRATION-enrolment.sql` (`applications.enrolment`).

- Options come from `public/plans-kit.mjs` (pure, tested): more than 90 days to the start → **monthly** (highlighted), **two instalments**, **pay in full**, and — quietly, as a text link — **deposit now, balance by 90 days before the start**; 75–90 days → two instalments (half with the deposit) or in full; under 75 days → in full. Instalments always finish 60 days before the start.
- Card or US bank account; the surcharge for each is set in the dashboard (Fee, interview & text) and added to every payment. They must tick the Program Terms & Conditions; the version is recorded.
- Today's payment goes through Stripe Checkout. For plans with instalments the card / bank account is saved (`setup_future_usage=off_session`) for automatic charges.
- Paid (return page or webhook, whichever is first — recorded once): schedule stored, deal → **Deposit Paid/Customer**, `payment_N` filled, note with the plan, the editable *place confirmed* email to student + parents (logged in HubSpot) with the schedule and the student-portal link, and an admissions alert. A bank payment shows as *clearing* and is confirmed when Stripe says the money arrived; if it bounces, the page offers the payment again and a HubSpot note is added.
- After the hold passes the page says so and won't take payment until admissions extends it. The link itself never expires.

**Not in this release (4b — must be live before the first instalment is due, about a month after the first deposit):** the daily job that charges the saved card / bank account, the 3-day notice emails, retries and the admissions hand-off on a failed payment, deposit-unpaid reminders, and withdrawals (→ *Cancelled*, keep what's been paid).

### HubSpot stages (PD program pipelines)

Application Fee Received → Interview → Interview Complete → Deposit Paid/Customer → Closed Won / Closed Lost / Cancelled. Fee paid → *Application Fee Received*, or *Interview* if the interview is already booked; interview booked later → *Interview*; accepted → *Interview Complete*; declined → *Closed Lost*. Automatic moves only ever go forward (`routing.isForward`) — a deal admissions has already moved on is never dragged back; closing a deal is always allowed.
