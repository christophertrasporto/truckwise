# Truckwise: Progress

## Phase 0: Plan (approved)
Stack: Next.js 16 (App Router, Cache Components) + strict TypeScript, Postgres + Drizzle, Postgres RLS for tenancy,
Zod, pino, Vitest (real Postgres), Playwright (installed, not used yet), pg-boss (installed, not used yet).
Auth is hand-rolled server-side sessions (Lucia-style), not Auth.js: random token in an httpOnly cookie, SHA-256
hash stored in `sessions`.

## Phase 1: Foundation (built; see "Verified" for what was actually run)

**Built**
- Docker Compose (`docker-compose.yml`): Postgres 16, MinIO, Mailpit. No Redis (pg-boss uses Postgres).
- `.env.example` documenting every variable.
- Schema + migrations (`drizzle/0000_init.sql`, `0001_rls.sql`): tenants, users, memberships, sessions,
  partner_approvals, company_settings, customers, audit_log.
- Tenancy: RLS enabled and FORCED on every tenant-owned table. App connects as `smartload_app`
  (NOSUPERUSER, NOBYPASSRLS). Every query runs through `withContext/withTenant/withUser` in `src/server/db/index.ts`,
  which sets `app.tenant_id` / `app.user_id` per transaction. No unscoped client is exported; the owner client
  (`db/admin.ts`) is for scripts/tests and blocked from `src/` by ESLint.
- Audit log: append-only (privileges revoked + trigger), written in the same transaction as the change.
- Central policy module `src/server/policy` (`can` / `authorize`, default deny).
- Sessions, login/logout, `/api/me`, tenant switch, sample tenant-scoped `/api/customers`.
- Structured pino logging with request/tenant/user ids and redaction of contract-rate fields.
- Seed (`src/server/db/seed.ts`): 2 hauler tenants, 1 subcontractor tenant (approved partner), users per role, customers.
- UI: corporate landing page (`/`), login (`/login`), minimal workspace (`/app`). Light/dark, responsive.
- `npm run db:embedded`: no-Docker fallback that runs native Postgres on the same credentials.

**Verified (run in this session)**
- Migrations apply cleanly on a fresh database (embedded Postgres 5432).
- `vitest run`: 31 tests passed (policy matrix, cross-tenant read/insert/update/delete, audit immutability,
  session lifecycle, schema guard that every tenant table has forced RLS).
- `tsc --noEmit`, `eslint`, `next build` clean.
- Login and workspace exercised in the browser: dispatcher sees only Acme's customers.

**Not verified / gaps**
- Docker Compose was NOT run (Docker was not installed here). Tests ran against the embedded Postgres, not the compose one.
- API route handlers are not covered by automated tests yet (isolation is tested at the DB layer and via the browser).
- No login rate limiting yet. No password reset, invites or member-management UI yet.
- The landing page's dispatch board is an illustration with sample data; `hello@smartload.example` is a placeholder address.
- Playwright installed but no E2E yet (Phase 2).

**Stubbed / needs external credentials (later phases)**: SMS provider, Web Push VAPID keys, SMTP, S3/MinIO, malware scanner, billing provider.

## Phase 2: Core workflow vertical slice

Path: create trip -> broadcast or direct offer -> driver accepts -> driver status steps -> driver uploads proof -> dispatcher approves -> Ready for invoice.

**Built**
- Migrations 0002/0003: trips, trip_stops, trip_slots, trip_offers, trip_assignments, trip_status_events, epod_submissions, epod_attachments, pod_reviews, all with forced RLS.
- Slot claiming: trip row locked FOR UPDATE, trip must still be offered, plus a partial unique index (one active assignment per slot).
- Evidence immutability: status events, attachments and reviews are append-only; epod_submissions only allows changing status (column grant + trigger); nothing is deleted.
- State machine in src/shared/state-machines/trip.ts; every transition writes a trip_status_events row and an audit row in the same transaction.
- Field-level price hiding: separate serializers (src/server/dto/trip.ts). Drivers get payout only; the driver trip shape has no contract-rate field at all.
- ePOD: multiple photos, receiver, outcome, quantity, discrepancy notes, optional GPS with consent state, proxy submission records both identities, idempotency keys, versioning (reject then resubmit creates v2). Delivery time (driver-entered, unverified), server upload time and per-photo capture time (null, never inferred) are stored separately and shown separately. Images validated by magic bytes, max 8 files of 10 MB, SHA-256 stored.
- Local-disk object storage behind an interface; keys prefixed tenants/{tenantId}/; photos served only through short-lived HMAC-signed URLs issued after a permission check.
- Screens (mobile-first): trips list, new trip, trip detail (dispatch and driver variants), clients, team (owner adds members), account (change password).

**Verified (run in this session)**
- vitest: 59 tests passed, including 8 simultaneous claims with exactly 1 winner, contract rate absent from driver payloads, proof timestamps distinct, immutability, cross-tenant 404s.
- Playwright E2E (Pixel 7 viewport, production build): full path passed, plus raw driver API response contains no contract rate and drivers get 403 on the dispatch list.
- tsc, eslint, next build clean.

**Not done / known gaps**
- Claim mode setting (immediate vs approval) is NOT honored yet: claims are always immediate. Phase 3.
- No eligibility checks (vehicle, license, schedule overlap), no trucks table, no subcontractor offers, no offer expiry job, no reassign. Phase 3.
- Dispatch is not notified of submitted proof (no notification table yet). Phase 6.
- One slot per trip in the UI (model supports several). Per-stop proof, signatures, PDFs, compression, malware scan adapter, offline drafts: Phase 4.
- S3/MinIO storage adapter not built (local disk only). Docker Compose still unrun.
- API routes have no unit tests; they are covered by the E2E and the service tests.
- No login rate limiting. Newly added members have a password set by the owner; there is no invite flow.
- Trip editing and rate-change auditing screens are not built.

## Phase 3: Dispatch depth

**Built**
- Migrations 0004/0005: trucks, driver_profiles, trip_offer_targets, trip_applications; offer modes (broadcast_internal / broadcast_partners / broadcast_all / selected / direct / applicants), assignment company + truck + driver snapshots and release fields. Forced RLS on every new table.
- Three dispatch modes. (A) private broadcast to our drivers, approved subcontractors, both, or chosen drivers; (B) direct to one driver or one subcontractor company; (C) open call where eligible people apply and dispatch picks. Optional "answer by" time on every offer.
- Immediate vs approval-required acceptance (company setting, screen at Settings). Open calls always need approval. A request becomes an assignment only when dispatch approves, and approval re-checks eligibility.
- Offer expiry: overdue offers are hidden at once, then swept (expired offers and their pending requests; trip returns to "created"). The sweep runs whenever offers are read and as `npm run jobs:expire`. A real scheduler arrives with the Phase 6 job runner.
- Decline (direct offers), withdraw an offer, withdraw a request, cancel, and reassign (before cargo is loaded; the assignment is released with a reason and kept as history).
- Eligibility, enforced when accepting and again when dispatch approves: truck type, capacity, truck in service, registration and inspection valid through the END of the job, driver license present and valid through the end of the job, driver and truck not already on an overlapping trip (checked across all companies by security-definer SQL that returns only booleans). Pure rules in src/shared/eligibility.ts.
- Subcontractor portal: approved partners see only trips offered to them, choose one of their trucks and one of their drivers (each shown with the reasons it would be refused), and follow the hauler's acceptance setting. Their drivers run the trip and submit proof with no money visible. All cross-company access goes through one gateway (src/server/services/scope.ts) that proves an approved partnership or an active assignment first; partners cannot read the hauler's tables at the database level.
- Subcontractor management (invite company + owner login, approve, revoke), fleet (trucks, license details, expiry badges), dispatch calendar (week view in Asia/Manila + unscheduled list), available-trips board with filters (place, date range, truck type, minimum payout) with "offered to you" kept apart from "open to the company".

**Verified (run in this session)**
- vitest: 104 tests passed (adds 36 dispatch tests: offer visibility per mode, both acceptance modes, applicants, eligibility reasons, overlap blocking, expiry, cancel, reassign, partner accept and completion, partner isolation at service and database level, revocation, partner-vs-internal race, filters, calendar, fleet, invitations) and pure eligibility unit tests.
- Playwright: 5 E2E tests passed on a phone-sized viewport (core path; subcontractor accepting with its own truck and driver who completes the trip; approval-required flow; fleet/calendar/partners/settings screens; cross-company check).
- tsc, eslint, next build clean.

**Not done / known gaps**
- Revoking a partner does not cancel jobs already assigned to them (by design: they can finish).
- Eligibility for a partner is evaluated outside the claim transaction (their truck and driver live in another tenant); the unique index still guarantees one assignment per slot, and approval re-checks.
- Truck double-booking and driver overlap use the stop times; a trip with no times can never conflict.
- Dispatch is still not notified of requests or proof; drivers are not notified of offers (Phase 6). The expiry sweep needs a scheduler.
- One slot per trip in the UI; multi-truck trips are not offered yet.
- "Selected" offers target our own drivers only (not individual partner users).
- Calendar is a week list, not a drag-and-drop planner.

## Phase 4: ePOD depth

**Built**
- Migrations 0006/0007: per-stop proof versions, signature/PDF attachment kinds, offline flags, mutable file-processing state, automatic-approval reviews, a jobs table; settings for PDF receipts and automatic approval.
- Multi-stop proofs. Each delivery stop has its own proof and versions. The trip stays "at destination" until every stop has usable proof, becomes "ready for invoice" only when every stop is approved, and any stop reporting a problem makes it a delivery exception. With one delivery stop it behaves exactly as before.
- Receiver signature (drawn on screen, stored as a PNG) and optional PDF receipts (off until the company enables them). Files are checked by content, not name or type header: size limits, one signature, up to 3 PDFs, up to 8 photos.
- Background jobs (own queue in Postgres): unique dedupe keys, retries with exponential backoff to a limit, crash recovery, safe with several workers. Runs in the web server, or separately with `npm run jobs:work`.
- Malware scanning behind an adapter. Default is a STUB that only flags the EICAR test string. A ClamAV client (clamd INSTREAM) is built and used when CLAMD_HOST is set. An infected file is quarantined: no link, approval refused, the reviewer can still reject. A scan that errors is retried and blocks approval meanwhile.
- Compressed display copies (max 1600 px JPEG) for photos; originals are kept untouched as evidence and stay one click away.
- Capture time is read from a photo's EXIF only when it also states its UTC offset. Otherwise it stays empty (never guessed). Four clocks are kept apart and shown: delivery time (driver-confirmed, unverified), phone queue time (device-reported), server upload time, photo capture time.
- Automatic approval (off by default, Settings): only complete deliveries, every file clean, and a signature or 2+ photos. The review is recorded as the policy, not a person. Exceptions and infected files are never auto-approved.
- Offline: drafts and queued proofs are stored on the phone (IndexedDB) with states draft / queued / uploading / synced / failed / conflict. Submitting always saves first, then uploads; retries use one idempotency key so a version is never duplicated. Network and server errors stay queued and upload on reconnect, on a 30 s timer and on page open. Trip reassigned, trip cancelled, wrong state or already-submitted are shown as conflicts with a reason; they are never retried or overwritten and the person discards them. Installable PWA: manifest, icons, service worker (production builds only).

**Verified (run in this session)**
- vitest: 135 tests passed (31 new: per-stop flow and reviews, signatures, PDF rules, scan and quarantine, display copies, auto-approval policy, offline fields and clocks, conflict codes, tenant privacy of evidence, job queue retry/dedupe/concurrency/recovery, EXIF parsing, clamd protocol against a fake daemon).
- Playwright: 9 E2E tests passed (adds: proof filled in with the network switched off, queued on the phone, auto-uploaded on reconnect and shown to dispatch with the offline marker, signature and display copy; two-stop trip; automatic approval; manifest/icons/service worker served).
- tsc, eslint, next build clean.

**Not done / known gaps (be aware)**
- EXIF reading is tested against hand-built metadata, not photos from real phones. Many phones strip EXIF or omit the offset, in which case capture time stays empty by design.
- The ClamAV client is tested only against a fake daemon, not a real ClamAV (Docker is not available here).
- Background sync (the service worker retrying with the app closed) exists only in Chrome-based browsers and was NOT exercised by tests; the page-level upload on reconnect is what the E2E covers. iOS Safari has no background sync.
- Offline page caching is best-effort: pages the driver already opened are kept (cleared on sign-out) so the form still opens without a signal. A page never opened cannot be loaded offline. Cached pages remain on a shared device until sign-out.
- A phone that drops its signal mid-upload may retry; the idempotency key protects against duplicates, but large files over a poor link will be slow (no chunked or resumable upload).
- Large originals are re-uploaded as-is (no on-phone compression before sending).
- The job worker polls (15 s in-process); no dashboard for failed jobs yet.
- Notifications (dispatch alerted of new proof, conflicts) are still Phase 6.

## Phase 5: Finance

**Built**
- Migrations 0008/0009: invoices, invoice lines, settlements, settlement lines, trip expenses, per-company document counters, VAT setting. Forced RLS on all of them.
- Invoices: issued for the finished trips of ONE client, with each trip's customer rate fixed at that moment; VAT added at the company rate (rounded to the centavo); gap-free numbers (INV-2026-0001). Mark paid with a payment reference, or void with a reason (a paid invoice cannot be voided; a voided one stays on record and frees its trips).
- Never billed twice: the same idempotency key returns the same invoice; trip rows are locked before billing and a unique index allows one active invoice line per trip; "invoice everything ready" run twice finds nothing the second time; two people billing at once get exactly one invoice.
- Issued amounts are immutable: the app role has no update right on them (column grants) and a trigger blocks even the table owner. Only status and payment/void fields change, and only issued -> paid or issued -> void.
- Proof attached: the invoice page shows, for every billed trip, the newest APPROVED proof of each delivery stop (receiver, the separate delivery / server / approval times, photos, signature, who approved). `Download PDF with proof` builds a real PDF (bill, then a proof page per trip with images). Quarantined files are excluded.
- Subcontractor settlements: for finished trips done by a partner company, at the payout agreed on the trip; same duplicate protections, numbering (SET-...), paid/void. A subcontractor can read only the settlements addressed to its own company, and never sees a customer rate.
- Expenses: a company driver reports a cost with a receipt photo (scanned, content-checked); finance approves (and decides who bears it, defaulting from the trip's fuel/toll terms) or rejects with a reason. Office staff can enter a company-paid expense directly. Amounts and receipts are immutable once submitted; a decision is final.
- Trip profit: customer charge - subcontractor payout - driver pay - approved company-borne expenses, before overhead and taxes. Driver pay and subcontractor cost are separate lines and only one applies to a given trip. Rejected, undecided and not-company-borne expenses never reduce profit. Per-trip money panel and a profit table with totals.
- Money edits: owner/ops/accountant can change a trip's customer rate or payout with a reason; the audit log keeps old and new values. A rate cannot change once invoiced, nor a payout once settled (void first).
- Role visibility: finance screens and APIs are for owner, ops manager and accountant (invoice and settlement creation: owner and accountant). Dispatch, drivers and partners get 403 on them. A company driver has an Earnings page showing only their own payouts and reimbursements.

**Verified (run in this session)**
- vitest: 169 tests passed (34 new: 28 finance integration tests including the duplicate-billing races, immutability, PDF with unusual characters, partner isolation, role visibility; 6 pure finance-rule tests).
- Playwright: 12 E2E tests passed (3 new: accountant issues an invoice with proof, downloads the PDF and records payment; a driver's expense is reviewed and reduces profit by the right amount while the driver sees only their earnings; a subcontractor sees its settlement with no customer rate or profit).
- tsc, eslint, next build clean.

**Fixed along the way (important)**
- The local Postgres created on Windows defaulted to WIN1252, which cannot store the peso sign, emoji or most non-Latin names. New test/E2E/reset databases are now created as UTF8, and the embedded server initialises new clusters as UTF8. Your dev database was converted with `npm run db:to-utf8` (all rows copied and counted; the old one is kept as smartload_old_win1252 and can be dropped once you are happy). Docker Postgres is already UTF8.

**Not done / known gaps**
- No credit notes, partial payments, or editing an issued invoice (void and re-issue instead). One client per invoice.
- VAT is one company-wide rate; no withholding tax or other taxes, and no BIR-formatted official receipt.
- No reimbursement tracking: approved driver expenses are listed on Earnings but there is no "paid back" action yet.
- Settlement adjustments (deductions for damage and similar) are not built; a settlement is exactly the agreed payouts.
- Sub-driver and partner expenses are not supported (only company drivers and office staff); a partner handles its own costs.
- Profit ignores overhead, taxes and driver pay beyond the trip payout by design. Date-range filters and CSV export for the profit table are not built.
- The PDF uses standard fonts, so characters outside Latin-1 print as "?". Peso amounts print as "PHP".
- Invoice PDFs are generated on demand (nothing is stored), so they reflect current proof links.

## Phase 6: Notifications and automations (built; final full verification NOT completed)

**Built**
- Migrations 0010-0012: notifications (one per person per event, unique dedupe key, readable only by that person), delivery log, push subscriptions, personal SMS settings.
- Events are recorded in the same transaction as the change and turned into notifications by the background worker, so a retry never notifies anyone twice. Covered: new offers (broadcast, direct, chosen drivers, partners, open calls), request/approval/decline, trip accepted, trip taken by someone else, reassignment, cancellation, driver arrival, proof uploaded, exceptions, proof approved/rejected/more requested (including automatic approval), trip completed, invoice-ready, expense submitted/decided, settlement issued/paid, offer timeout, exception escalation.
- Alerts page, unread badge, mark as read; Account page for device alerts and an opt-in mobile number. Notification text never contains money.
- Web Push via VAPID (request built by web-push and sent with fetch; a dead device is forgotten). SMS fallback only for urgent items when push did not reach the person, opt-in, capped per day; adapters for Semaphore and Twilio, default is a STUB that sends nothing.
- Timers: a once-a-minute job expires overdue offers and escalates unreviewed exceptions (once each); background work also runs right after any change.

**Verified**: vitest passed for the 41 new tests (29 integration, 12 unit incl. a real encrypted VAPID request against a local fake push service, SMS adapters against fake servers). The two new Playwright tests passed/ran; the complete E2E suite, lint and production build were NOT re-run after Phase 6 changes.

**Not verified / gaps**: real browser push and real SMS providers (Semaphore/Twilio) were never tested against live services; email is not built; no per-event notification preferences; the service-worker push handler has no automated test.

## Costs, quotes and subcontractor applications (added after Phase 6)

- **Cost ledger** (`/app/costs`): diesel, RFID, toll, maintenance, tires, salary, insurance, registration and more, per month, tied optionally to a truck or trip. Voiding keeps the row (struck through). Salaries are visible to owner and accountant only.
- **Quote box**: on New trip and the offer panel, shows customer pays vs. your offer to the subcontractor, margin, a loss/thin/healthy verdict, and the highest offer that keeps a 15% margin.
- **Company P&L** (`/app/profit`): monthly, split subcontractor vs own trucks, overhead and net profit.
- **Subcontractor applications**: public form at `/apply/<token>` (six photos: left, right, front, back, plate, license; truck type and size incl. Other). Staff review at `/app/applications`; approving creates the subcontractor company, owner login (one-time password) and truck. Link is on the Subcontractors page.
- **Rename**: user-visible name is now Truckwise. Internal identifiers (IndexedDB, cache names) unchanged on purpose.
- **Status**: 228 vitest tests pass, lint clean (one img warning), production build passes. The full Playwright suite was not re-run after these changes.

## Phase 7: SaaS administration

Built on the existing company model (hauler and subcontractor companies); the single-organization redesign in the newer build prompt was deliberately not adopted.

- **Platform area** (`/app/admin`, platform administrators only): overview (companies, paying/trial/expired, monthly recurring revenue, subscriptions ending in 14 days), company list and detail, create a trucking company (owner login with a one-time password, optional free trial), suspend/reactivate with a reason, change plan, record a subscription payment by hand, plans (price, period, limits, feature flags), platform activity log. The platform sees names, plans and head counts only; nothing in it reads trips, clients, rates or documents.
- **Plans and limits**: max trucks, drivers and people are enforced on the server when adding a truck or a team member (HTTP 402). Feature flags (cost ledger, profit and loss, public application form) are enforced in the services and the public link. A company with no subscription (Lalolu, the operator's own company) is not limited.
- **Subscriptions**: manual payments only, idempotent by key, immutable once recorded. A payment extends the period; paying late starts from today. A subscription that lapsed is marked expired and its company suspended by the once-a-minute timer; a payment reactivates it. A company suspended by hand stays suspended until reactivated by hand. Owners get an in-app reminder 7 days ahead (deduplicated).
- **Suspended companies**: people can sign in but see only a renewal notice. The public application form stops working for a suspended company.
- **Application form**: owners with several units can add more trucks, each with its own driver and six photos. Approval puts every truck on the new company's fleet.
- **Accessibility**: skip-to-content link added; visible focus and reduced-motion handling already existed. No automated accessibility scan was run.
- **Migrations**: 0017 to 0020.

### Not built (still open)
- Custom domains, branding and white-label (DNS verification, SSL adapter, branded login). The build prompt lists these; they were not requested here.
- Automatic subscription payments (a gateway adapter). Manual recording only.
- Invitation emails; new owners and approved subcontractors get a one-time password the administrator hands over. Email, SMS and push providers still need real credentials.
- Public self-service sign-up for trucking companies (the administrator creates companies).
- File storage is local disk; production needs S3-compatible storage. The malware scanner is a stub. The public form's abuse limit is in memory per server.
- Plans created so far are placeholders; prices and limits are the operator's decision. A "Starter" plan (999 PHP monthly, 5 trucks, 5 drivers, 10 people, no profit and loss) was added to the dev database as an example.

## Client documents and separate pay fields

- **Documents per client**: the owner or operations manager sets, per client, which documents every trip needs (name, required or optional, who uploads it, instructions). Each new trip gets its own copy of the list; later changes to the client's list do not touch trips already booked. Dispatch can add or remove an item for one trip; the owner or operations manager can mark a required item "not needed" with a reason.
- **Upload and review**: the assigned driver (company or subcontractor) or office staff upload a photo or PDF once the trip has arrived at the destination. Dispatch approves or rejects (reject needs a reason). Every upload is a new version; nothing is overwritten or deleted. Files are checked by content, size and the malware scanner (stub by default).
- **Billing gate**: after every delivery stop's proof is approved, the trip stays at "Proof submitted" until every required document is approved or waived, and then moves to "Ready for invoice". An optional document never blocks.
- **Not built**: documents are not attached to the invoice PDF yet; no "download everything" bundle; uploads do not work offline (online only); no notification when a document is uploaded (dispatch sees it on the trip page).
- **Pay fields on a trip**: driver pay (own driver, the existing payout), a separate subcontractor rate (blank means the same as the driver pay) and helper pay (own trucks only; a subcontractor pays their own helper). Subcontractors see and are settled at their own rate; profit uses the subcontractor rate for subcontracted trips and driver pay plus helper pay for own-truck trips. All three can be changed later with a reason on record. Trips created before this keep working (no subcontractor rate, helper pay 0).
- **Migrations**: 0021 to 0023.

## Income ledger, spreadsheet import, truck body size

- **Income** (`/app/income`, owner and accountant): money received from clients, by client and month, with "received minus costs". Cash record only; separate from trip invoices and trip profit. Entries are never edited or deleted, only voided with a reason.
- **Spreadsheet import** (`scripts/import-costs.mts`): loads a sheet of date, type, category, amount, description into Costs and Income. Expense rows become costs (the description is kept; for Salary it is the person paid). A description starting DIESEL or RFID decides that category; PASSWAY, PASSTHRU or toll become Toll; plates named in the description (CCB, KAS, TYV, XJP) link the cost to that truck; income rows become payments from the client named in the category column. Safe to rerun (fixed keys). `--dry-run` shows what would happen; `--create-trucks` adds missing trucks; `--wipe-previous-import` clears an earlier import but only on a database on this computer.
- **Trucks** now have an optional body size (for example 14ft), also carried over when a subcontractor application is approved.
- **Migrations**: 0026 to 0028.
