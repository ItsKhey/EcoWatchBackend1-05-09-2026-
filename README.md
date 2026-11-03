# MyEcoWatchBackend1

The production-ready backend for the EcoWatch ecosystem.

> **Testing on a phone?** See [TESTING.md](../TESTING.md) for the full local
> test runbook: start the database, start the server, turn on the hotspot, and
> install both apps against it.

## Features

* JWT Authentication
* Multi-resident email OTP verification
* Permanent Resident IDs (`RES-XXXXXXXX`)
* Local disk image upload, with Cloudinary still supported
* Report Management
* Admin-managed Personnel Accounts and Report Assignments
* Resident-chosen Waste Scale driving scale-aware dispatch (individual / cleaning team / cleaning team with a collection vehicle)
* Backend-backed Resident Notification Center with Firebase Cloud Messaging
* PostgreSQL database, local or hosted
* Request Correlation Logging

## Project structure

Runtime code is organized by business domain under `src/modules/`. The entry
point remains `server.js` at the project root. See
[`src/README.md`](src/README.md) for the module layout and dependency rules.

## Setup

1. Copy `.env.example` to `.env` (or use an existing `.env`).

2. Fill in the required environment variables:

   * `DATABASE_URL` — the local PostgreSQL server (see [Local setup](#local-setup))
   * `JWT_SECRET`
   * `RESEND_API_KEY`
   * `EMAIL_FROM`

   Report and profile photos are written to `./uploads` and served by this
   server, so no Cloudinary credentials are needed while
   `IMAGE_STORAGE_PROVIDER=local`. Set that variable to `cloudinary` to go back
   to the CDN, which then needs `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`,
   and `CLOUDINARY_API_SECRET`.

   For resident push delivery, also configure either
   `FIREBASE_SERVICE_ACCOUNT_JSON` or the split `FIREBASE_PROJECT_ID`,
   `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` variables. The service
   account file/key must remain in Render environment settings only.

3. For legacy MongoDB-to-PostgreSQL migration only, configure:

   * `MONGODB_MIGRATION_URI`

   This variable is used exclusively by the migration scripts and is not required by the production API runtime.

4. Install dependencies:

   `npm install`

5. Run the backend in development mode:

   `npm run dev`

## Local setup

Everything the API needs runs on one machine: a local PostgreSQL server and this
Node server. No third party is in the request path except the optional Firebase
and Resend services, which are separate concerns.

### 1. Database

Point `DATABASE_URL` at the local server:

```
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/ecowatch
```

`src/config/database.js` prefers `DATABASE_URL` and falls back to
`SUPABASE_DATABASE_URL`, so commenting that one line out is all it takes to go
back to a hosted database. The identical schema runs on both. SSL is negotiated
for remote hosts only, because a local server has no certificate.

To rebuild the database from a `pg_dump` archive:

```bash
node scripts/restore-local-db.js path/to/dump.dump
```

The script refuses to run against a remote host, and drops the existing local
database first unless `--keep` is passed.

To confirm the connection:

```bash
node tests/manual/test-supabase.js   # legacy filename, reports whichever target is active
```

`GET /api/health` also reports the active target:

```json
{ "status": "UP", "databaseTarget": "LOCAL_POSTGRES", "imageStorage": "LOCAL_DISK" }
```

### 2. Server

```bash
npm run dev
```

The server binds to `HOST` (default `0.0.0.0`, so a phone on the same network
can reach it) on `PORT` (default `5000`).

### 3. Apps

Both Android apps take their API target from Gradle instead of hardcoded source.
The default is the emulator's alias for the host loopback, which is what the
server above serves, so no configuration is needed to run in the emulator.

```bash
# Emulator
./gradlew installDebug

# Physical phone on the same WiFi, using this machine's address from `ipconfig`
./gradlew installDebug -PecowatchApiBaseUrl=http://192.168.1.20:5000/api/
```

A phone build also needs the Windows firewall to allow inbound TCP on the port.
`app/src/main/res/xml/network_security_config.xml` permits the cleartext traffic
that a plain HTTP local server requires; Android blocks it by default.

Stored image references are site relative (`/uploads/...`) and are expanded
against whichever server the build targets, so the same database works locally
and against a hosted deployment. Rows that still hold an absolute Cloudinary URL
keep rendering as they are.

### Account creation

Registration picks its verification transport per build, not per environment:

```bash
# Local 4-digit code emailed through Resend. No Firebase is contacted.
./gradlew installDebug -PecowatchRegistrationMethod=OTP

# Firebase verification link. Kept working as a fallback.
./gradlew installDebug -PecowatchRegistrationMethod=EMAIL_LINK
```

`OTP` is the default. The backend has supported both since the email-link flow
was added: a request carrying `verificationMethod: "EMAIL_LINK"` is staged as a
Firebase verification identity, and any other request takes the code path, which
emails a 4-digit code through `src/modules/auth/emailServices.js` and creates the
resident on `POST /api/auth/verify-otp`. The Admin app has always used the code
path.

The build fails fast on an unrecognised value rather than silently falling back
to a transport you did not ask for.

Login is unaffected either way. The username and password JWT in
`src/shared/generateToken.js` is the only credential the system honours, and Firebase
is never an authentication authority.

#### Turning verification off entirely

`REGISTRATION_REQUIRES_VERIFICATION=false` (the default) creates the account on
the register request itself. No OTP is generated, no email is sent, no pending
registration row is written, and the client sends the resident straight to the
login screen. The response carries `requiresVerification: false` so a client can
tell the two paths apart.

This is the only mode that needs no external service. It is the right choice for
a local-server setup, and the trade-off is real and worth stating plainly: the
server no longer checks that whoever registered can receive mail at that address.
A person could register someone else's email address, and password recovery for
that account would be awkward. That is acceptable for a classroom deployment and
is not appropriate for a real public sign-up.

Set the variable to `true` to restore the emailed-code flow, or set it per
request with `verificationMethod`. A client can also ask for
`verificationMethod: EMAIL_LINK` to use Firebase regardless of this setting.

Note that registration validates through `src/modules/auth/authValidation.js` in the direct
mode, which is stricter about password shape than the staged code path is.

## Database

The API runs on PostgreSQL. The local server is the default target;
`SUPABASE_DATABASE_URL` remains supported as a hosted fallback.

MongoDB Atlas is retained only as a legacy data source for migration and verification scripts. The production application no longer uses Mongoose models or MongoDB repositories.

### Personnel schema migration (Phase 2A)

Run the idempotent migrations before deploying the new API:

```bash
npm run migrate:admin-identifiers
npm run migrate:personnel
npm run migrate:report-assignments
npm run migrate:admin-account-activity
npm run migrate:resident-account-activity
```

The account-activity migrations add the server-owned `admins.last_active` and `residents.last_active` timestamps used by the admin account and reporter dashboards, plus their report lookup indexes. The same SQL files can be pasted into the Supabase SQL editor. Run `npm run migrate:admin-identifiers` (`003-normalize-admin-identifiers.sql`) before deploying the canonical `ADM-XXXX` admin identity contract; it is idempotent, takes an advisory lock, and fails visibly if a legacy `RES-XXXXXXXX` administrator conflicts with an existing `ADM-XXXX` row. The personnel migration creates `personnel_accounts`, `PERS-XXXX` ID generation, bcrypt-hash storage, Gmail/username constraints, lifecycle timestamps, admin audit fields, current-report assignment fields, indexes, and the `updated_at` trigger. PostgreSQL advisory-lock-backed triggers also serialize identity writes and enforce case-insensitive username/Gmail uniqueness across Personnel, Resident, and Admin tables, closing concurrent create/edit races in addition to the controller pre-checks.

### Canonical report assignment migration (Phase 2B)

Run `npm run migrate:report-assignments` after the Phase 2A personnel migration and before deploying the assignment endpoints. The idempotent migration adds `reports.assigned_personnel_id`, `assigned_by_admin_id`, and `assigned_at` (the existing `admin_response` column is populated by the API); mirrors those fields on archived reports; and adds the personnel `is_cleaning`, `current_assignment`, and optional `profile_image` compatibility fields. Existing single-`PERS-XXXX` array assignments are backfilled conservatively, while ambiguous multi-person legacy assignments remain in `assigned_personnel_ids` until an administrator explicitly replaces them.

The migration also adds foreign keys, assignment indexes, synchronization checks/triggers, and an optional personnel `profile_image` URL for assignment avatars. It is safe to run repeatedly, but the API must not be deployed against a database that has not completed this migration. The migration command is intentionally not part of `npm test` and must be run explicitly against the target Supabase project.

### Resident notifications and report timestamp repair (Phase 2C)

Run the idempotent Phase 2C migration after the report-assignment migration and
before deploying the new notification routes:

```bash
npm run migrate:resident-notifications
npm run verify:phase-2c
```

The migration creates the canonical `notification_id` contract, adds
`residents.fcm_token`, adds notification ownership/read/trash indexes and
foreign keys, removes invalid legacy personnel rows from the resident
notification table, and enables RLS. A generated `id` alias preserves rolling
compatibility with the previous Render deployment while new code uses
`notification_id`.

The same migration repairs report submission time without adding a duplicate
field. It backfills each legacy `reports.created_at` or
`archived_reports.created_at` from that report's authoritative `SUBMITTED`
history event, then enforces `DEFAULT NOW()` and `NOT NULL`. The migration
fails visibly if a report has neither an existing timestamp nor a submitted
history event; it never substitutes `updated_at` or the device clock.

Notification content is always server-owned. Clients can read/move their own
rows and update their own FCM token, but cannot supply a resident recipient,
title, message, read state, or creation time. Admin assignment, response,
Cleaning Started, Denied, and Completed mutations create their event
content and report ID on the server.

### Resident account lifecycle (Phase 2D)

Run the idempotent Phase 2D migration after Phase 2C and before deploying the
resident account lifecycle routes:

```bash
npm run migrate:resident-account-lifecycle
```

`residents.status` already blocks authentication for disabled accounts, so the
pause itself adds no new lifecycle column. The migration adds only
`residents.disabled_by_resident` and `residents.disabled_at`, which record that
the *resident* paused the account. That marker is what makes the pause
reversible without weakening administrator control: the next successful login
restores only a self-paused account, and an account disabled by an
administrator stays blocked.

A pause preserves the entire account. Profile, reports (active, archive and
trash), history and settings are all left untouched, so signing in again
returns the resident to exactly the state they left. The device token is
released while the account is paused because a paused account must not receive
push notifications. The resident client logs out immediately afterwards.

A permanent deletion is irreversible. The account and every row it owns are
removed inside one transaction and in dependency order: trashed notifications,
notifications, report histories, the active/archive/trash report collections,
pending password resets, and finally the account itself.

`npm test` performs a syntax check across all project JavaScript files and runs
unit/assignment request-contract checks. After applying `003`, `005`, `006`,
`007`, and `008` to an approved staging project, run the read-only
`npm run verify:schema` and `npm run verify:phase-2c` commands.
`npm run verify:personnel` performs a real Supabase-backed create/hash/login
verification with a uniquely named temporary account and cleans that account up
afterward.

### Waste scale, cleaning teams, and collection vehicles

Run the idempotent migration after the report-assignment migration and before
deploying the scale-aware assignment routes:

```bash
npm run migrate:waste-scale
```

A resident now says how big their problem is when they file a report, and that
single label decides what has to be sent to the site:

| Scale | Dispatch |
| --- | --- |
| `Small-Scale Waste` | one individual personnel member |
| `Medium-Scale Waste` | a cleaning team |
| `Large-Scale Waste` | a cleaning team **and** a collection vehicle |

The migration adds `reports.waste_scale`, the reusable `cleaning_teams` and
`cleaning_team_members` tables, `reports.assigned_team_id`, and
`reports.assigned_vehicle_id`. It also mirrors the crew and the vehicle onto
`personnel_assignments` so the personnel app can show the crew and the truck on
the task it is working on. Reports filed before the migration are backfilled to
`Small-Scale Waste`, which is the only way they could have been handled then.

A personnel account may sit on more than one team, so a crew is a reusable
named group rather than a second identity. The rules are enforced server-side
in `src/shared/wasteScaleValidation.js` and are not negotiable from a client: a
small job refuses a crew or a truck, a medium job needs at least two people and
refuses a truck, and a large job needs both a crew and a truck.

`npm test` covers the vocabulary and the dispatch rules in
`tests/wasteScale.test.js`, and `tests/wasteScaleDispatch.test.js` walks the
whole chain against the database: a resident files a report, an administrator
dispatches a crew and a truck, and the crew and the truck come back to the
resident's own view. As with the other migrations, the command is
intentionally not part of `npm test` and must be run explicitly against the
target Supabase project.

## API Endpoints

### Auth

* `POST /api/auth/register` - Step 1: Register and receive `registrationId`
* `POST /api/auth/verify-otp` - Step 2: Verify OTP and create resident account
* `POST /api/auth/login` - Login with `username` and `password`
* `GET /api/auth/me` - Get the current profile (Protected; admins also receive the canonical `admin` object)
* `GET /api/admin/me` - Get the authenticated administrator account and server-owned activity timestamps (Protected, Admin)
* `POST /api/auth/disable-account` - Pause the caller's own resident account (Protected, Resident). Preserves the profile, reports, history and settings; releases the device token. Logging in again restores the same account. Administrator-disabled accounts are not restored.
* `DELETE /api/auth/account` - Permanently delete the caller's own resident account and all data it owns (Protected, Resident). Irreversible.

### Personnel Management

All management routes require `Authorization: Bearer <admin-token>`. Personnel have no registration endpoint; accounts can only be created by an authenticated admin.

Canonical admin-app routes:

* `GET /api/admin/personnel?includeDisabled=false` - List personnel as a raw JSON array (Admin)
* `POST /api/admin/personnel` - Create an account (Admin)
* `GET /api/admin/personnel/:personnelId` - Get account details and current assignment (Admin)
* `PATCH /api/admin/personnel/:id` - Edit account fields (Admin)
* `POST /api/admin/personnel/:id/reset-password` - Reset password with `newPassword` (Admin)
* `PATCH /api/admin/personnel/:id/status` - Set status with `online`, `cleaning`, and/or `status` (Admin)
* `PATCH /api/admin/personnel/:id/disable` - Disable an account without deleting it (Admin)
* `DELETE /api/admin/personnel/:id` - Soft-delete an account (Admin)

The equivalent management routes are also mounted under `/api/personnel`; `POST /api/personnel/login` is public and accepts `username` (or `identifier`, `email`, or `gmail`) plus `password`. Future protected personnel routes should use `protectPersonnel` from `src/middleware/authMiddleware.js`; it validates the JWT against PostgreSQL and rejects missing, disabled, or deleted accounts.

### Reporter Account Management

All management routes require `Authorization: Bearer <admin-token>`. Read routes:

* `GET /api/admin/residents?search=&status=&limit=&offset=` - List reporter accounts (Admin)
* `GET /api/admin/residents/:residentId` - Account details and report counts (Admin)
* `GET /api/admin/residents/:residentId/reports?page=&limit=` - Paged report history (Admin)
* `GET /api/admin/residents/:residentId/reports/statistics` - Report status totals (Admin)

Account-management routes, mirroring the personnel ones:

* `POST /api/admin/residents/:residentId/reset-password` - Reset password with `newPassword` (Admin). The administrator chooses the password and reads it back from `temporaryPassword`; **no email is sent**, so this does not depend on the reporter's inbox. Supabase is written first and is the authority, then the Firebase identity is re-aligned best-effort — a Firebase failure returns `success: true` with a `warning`, because the reset already succeeded for EcoWatch. Recorded in the Admin History trail as `RESIDENT_PASSWORD_RESET` without the password.
* `PATCH /api/admin/residents/:residentId/disable` - Disable an account without deleting it (Admin). Preserves the profile, reports, history and settings and releases the device token, exactly like the resident's own pause. **The difference is reversibility:** this route deliberately does not set `disabled_by_resident`, and the login path restores an account only when that marker is true, so the reporter cannot undo it by signing in again. 409 if already disabled. Recorded as `RESIDENT_ACCOUNT_DISABLED`.
* `PATCH /api/admin/residents/:residentId/enable` - Restore an account disabled above (Admin). The undo, and the only way back, since a disabled account carries no self-service marker. Returns the account to `AVAILABLE` and clears `disabled_at` and `disabled_by_admin_id`, leaving no trace of who blocked it. 409 if not disabled. Recorded as `RESIDENT_ACCOUNT_ENABLED`.

Distinct from `POST /api/auth/disable-account`, which is mounted `protect, protectResident` and therefore pauses the **caller's own** account: an administrator token can never aim it at somebody else.

#### 30-day retention for disabled accounts

A daily job (`src/modules/residents/residentPurgeService.js`, 4:00 AM) permanently deletes every reporter account an administrator disabled more than 30 days ago, reusing the same cascade as a self-service `DELETE /api/auth/account` — reports across the active, archived and trashed collections, notifications, history and Cloudinary photos. Each account is recorded as `RESIDENT_ACCOUNT_PURGED` with no `adminId`, so an expiry stays distinguishable from an administrator's decision.

**Only administrator-disabled accounts expire.** The filter is `disabled_by_resident = false`, not the status: a resident who paused their own account also carries `DISABLED`, but that pause is explicitly reversible and they may return at any time, so the job never touches it. The 30-day window matches the trashed-report cleanup, making "discarded data is kept for a month" one rule rather than two. Set `RESIDENT_PURGE_DISABLED=true` to stop the job starting at all.

Account-management routes require migration 026 (`npm run migrate:reporter-account-management`), which adds `residents.disabled_by_admin_id` for attribution and admits `RESIDENT` as an Admin History subject kind. The code tolerates a database that has not run it — disable and enable still work, the attribution is simply absent.

Create body (the backend accepts `gmail`, `email`, or both when they match):

```json
{
  "firstName": "Juan",
  "lastName": "Dela Cruz",
  "address": "Barangay Example",
  "gmail": "juan.delacruz@gmail.com",
  "email": "juan.delacruz@gmail.com",
  "username": "juan.cleaner",
  "password": "StrongPass123",
  "phoneNumber": "+63 900 000 0000"
}
```

Passwords must be 8-72 UTF-8 bytes. Only a bcrypt hash is stored. Create/reset responses include `temporaryPassword` once for the admin credential handoff; list, detail, login, and error responses never return it. Password hashes are never returned.

Personnel objects use camelCase and include both `email` and `gmail`, `personnelId`, `status`, `online`, `cleaning`, `enabled`, `lastActive`, lifecycle timestamps, and a `currentAssignment` object when assigned. List filtering supports `includeDisabled`, `includeDeleted`, `status=ONLINE|OFFLINE|CLEANING`, `search`, `page`, and `limit` (maximum 100). The original `POST /api/admin/create-personnel` alias remains available. `DELETE` is deliberately a soft delete, and disabled/deleted usernames and Gmail addresses remain reserved.

### Reporter account management (Admin)

All routes below are mounted under `/api/admin`, require a database-verified
administrator token, and use `req.admin` rather than a client-supplied identity.
Resident IDs are validated and looked up in PostgreSQL before any report query
is run.

* `GET /api/admin/residents?search=&status=ALL|ACTIVE|DISABLED&limit=&offset=` - List reporter accounts and their server-calculated total report badges.
* `GET /api/admin/residents/:residentId` - Get a reporter profile, address, lifecycle timestamps, and account status.
* `GET /api/admin/residents/:residentId/reports?page=&limit=` - Return a chronological page of the resident's complete report history, including archived and trashed report state.
* `GET /api/admin/residents/:residentId/reports/statistics` - Return server-aggregated `total`, `pending`, `inProgress`, `completed`, and `denied` counts.

`/api/admin/residents/:residentId/statistics` is a compatibility alias for the
statistics endpoint. Resident responses never include `password_hash`.

### Reports

Resident-owned routes remain available for the resident app:

* `POST /api/reports` - Submit report with image (Multipart) (Protected)
* `GET /api/reports/my-reports?view=default|archive|trash|all` - Get filtered reports for the current resident (Protected)
* `PATCH /api/reports/:id/trash` - Move a resident-owned report to trash (Protected)
* `PATCH /api/reports/:id/soft-delete` - Legacy alias for moving a report to trash (Protected)
* `PATCH /api/reports/:id/restore` - Restore a resident-owned report from trash (Protected)
* `PATCH /api/reports/:id/archive` - Archive a resident-owned report (Protected)
* `POST /api/reports/bulk-soft-delete` - Move reports to trash; body may be an array or `{ "ids": [...] }` (Protected)
* `POST /api/reports/bulk-restore` - Restore reports; body may be an array or `{ "ids": [...] }` (Protected)
* `POST /api/reports/bulk-archive` - Archive reports; body may be an array or `{ "ids": [...] }` (Protected)

Administrator-owned report routes use the same canonical report IDs but do not
require a resident identity or infer an administrator from client input:

* `GET /api/admin/reports?view=all|active|archive|trash&search=` - Return the deduplicated active/archive/trash directory with lifecycle and assignment metadata (Admin)
* `POST /api/admin/reports/:id/move-to-archive` - Archive a report and release its active personnel assignment (Admin)
* `POST /api/admin/reports/:id/move-to-trash` - Move a report to trash and release its active personnel assignment (Admin)
* `POST /api/admin/reports/:id/restore` - Restore a report from trash or archive (Admin)
* `DELETE /api/admin/reports/:id` - Permanently delete a report after releasing any active assignment (Admin)
* `POST /api/admin/reports/bulk-move-to-archive` - Admin bulk archive with `{ "ids": ["REP-..."] }` (Admin)
* `POST /api/admin/reports/bulk-move-to-trash` - Admin bulk trash with `{ "ids": ["REP-..."] }` (Admin)
* `POST /api/admin/reports/bulk-restore` - Admin bulk restore with `{ "ids": ["REP-..."] }` (Admin)
* `POST /api/admin/reports/bulk-delete` - Admin bulk permanent delete with `{ "ids": ["REP-..."] }` (Admin)
* `POST /api/admin/reports/:id/approve` - Approve an in-progress cleanup as Completed and release its personnel assignment (Admin)

Admin lifecycle writes and their history audit run in one database transaction.
The authenticated `req.admin.admin_id` is the only actor written to the audit;
client-supplied resident or administrator identifiers are never trusted.

### Report assignment integration (Phase 2B)

All assignment routes require a database-verified administrator token. The actor written to `assigned_by_admin_id` and assignment history is always `req.admin.admin_id`; body fields such as `adminId`, `assignedByAdminId`, and `residentId` are rejected as server-owned.

* `POST /api/admin/reports/:id/assign` - Assign one active `PERS-XXXX` account. The request accepts `personnelId` (or `assignedPersonnelId`), a non-empty `adminResponse`, and optional `priority`.
* `POST /api/admin/reports/:id/reassign` - Atomically replace the current assignment with one different active `PERS-XXXX` account; the canonical request also requires a non-empty `adminResponse`.
* `GET /api/admin/reports/:id/assignment` (or `/assignments`) - Return the report, canonical assignment metadata, and safe personnel details. An unassigned report is returned with null assignment fields.
* `POST /api/admin/reports/:id/unassign` - Explicitly clear the assignment. Active reports whose status is `In Progress` return to `Pending`.
* `DELETE /api/admin/reports/:id/assignment` - REST alias for unassign.

The original `assignedPersonnelIds` array and `handledById` request shape remain supported for rolling-deployment compatibility. Legacy `RES-XXXXXXXX` IDs must resolve to `residents.role = 'Environmental Services Personnel'`; they remain in the compatibility array and are never silently reclassified as `personnel_accounts`. New `PERS-XXXX` assignments set `is_cleaning`, `current_assignment`, `current_assignment_report_id`, `current_assignment_location`, `current_assignment_assigned_at`, and `status = 'CLEANING'`. Disabled/deleted personnel and personnel already assigned to another report return `409`; missing personnel return `404`; malformed requests return `400`.

The report row and all old/new personnel rows are locked in a deterministic order inside one transaction. Reassignment clears the old personnel state, and unassignment explicitly clears the report and personnel assignment fields. History is written transactionally; notification delivery is best-effort after commit and cannot turn a committed assignment into a false failure. Responses retain both snake_case database fields and camelCase aliases, plus the legacy assignment array. Report approval clears personnel assignment state in the same transaction and returns the account to `OFFLINE`.

### Waste scale and cleaning teams

All routes require a database-verified administrator token.

* `GET /api/admin/cleaning-teams` - List the reusable crews (Admin)
* `POST /api/admin/cleaning-teams` - Create a crew (Admin)
* `GET /api/admin/cleaning-teams/:teamId` - Get one crew with its members (Admin)
* `PUT /api/admin/cleaning-teams/:teamId` - Rename or re-describe a crew (Admin)
* `DELETE /api/admin/cleaning-teams/:teamId` - Soft-delete a crew (Admin)
* `GET /api/admin/cleaning-teams/:teamId/members` - List the people on a crew (Admin)
* `POST /api/admin/cleaning-teams/:teamId/members` - Put a personnel account on a crew (Admin)
* `DELETE /api/admin/cleaning-teams/:teamId/members/:personnelId` - Take a personnel account off a crew (Admin)

`POST /api/admin/reports/:id/assign` and `POST /api/admin/reports/:id/reassign`
accept the scale and the dispatch alongside the personnel. One id is sent as
`personnelId`; a crew is sent as the `assignedPersonnelIds` array together with
`wasteScale`, and a large job also carries `vehicleId`. A crew assignment sends
no `personnelId`. The crew may be ad hoc --2 or more selected personnel with no
named team (`teamId` omitted, stored as null) -- or a saved, named crew sent
with `teamId`; when a team is named, the server rejects a crew whose members
are not all on it.

The scale itself is fixed by the resident when the report is filed. The
administrator dispatches against it rather than choosing it, so an assignment
that does not match the report's scale is refused with `400` instead of
quietly sending one cleaner to a large job. A request that carries a scale is
therefore ignored whenever the report already has one: the stored scale is the
one that is enforced, so a stale or altered client value cannot rewrite what
the resident asked for.

The resident may correct the scale while the report is still open. Once a crew
is on the job the scale is settled, and a request to change it is refused with
`400` -- the dispatch was made under the label the report carried then, and
relabelling the report afterwards would leave the crew that went out
contradicting it.

Reports, personnel tasks, and the resident's own view all carry the crew and
the vehicle, so the resident can see who turned out.

### Resident notifications (Phase 2C)

* `GET /api/notifications/my-notifications` - Resident-owned active rows (Resident)
* `GET /api/notifications/trash` - Resident-owned trash rows (Resident)
* `GET /api/notifications/unread-count` - Current unread count (Resident)
* `PATCH /api/notifications/:id/read` - Idempotently mark one owned row read (Resident)
* `PATCH /api/notifications/mark-as-read` - Mark all active owned rows read (Resident)
* `PUT /api/notifications/fcm-token` - Upsert the authenticated resident's device token (Resident)
* `DELETE /api/notifications/fcm-token` - Remove the authenticated resident's device token (Resident)
* `POST /api/notifications/events` - Admin-only server event creation; accepts only `reportId` and a supported event `type` (Admin)

The event endpoint rejects recipient/content/read/creation fields. Normal
clients do not need to call it: assignment, status, response, and completion
routes invoke the same notification service after their database transaction
commits. Push failure is logged and never rolls back the report mutation.

### Render deployment

Render should run `npm install` and `npm start`; the service listens on `process.env.PORT`. Configure `SUPABASE_DATABASE_URL`, `JWT_SECRET`, the existing email/Cloudinary variables, and Firebase service-account variables in Render environment settings. Run `npm run migrate:admin-identifiers`, `npm run migrate:personnel`, `npm run migrate:report-assignments`, `npm run migrate:admin-account-activity`, `npm run migrate:resident-account-activity`, `npm run migrate:resident-notifications`, and `npm run migrate:waste-scale` once against the target Supabase project before starting the new service version. Verify the resulting schema and constraints in an approved staging project before production deployment; do not run the real-account personnel verification script against production.

Before release, rotate any credential or Maps key that has ever appeared in a local environment file, shell history, source control, or application logs. Remove plaintext password copies/backups, restrict service-account keys to the deployed project, and verify the rotation in the provider dashboards. This repository intentionally does not reproduce or automate those owner-only rotations.
