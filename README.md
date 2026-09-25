# MyEcoWatchBackend1

The production-ready backend for the EcoWatch ecosystem.

## Features

* JWT Authentication
* Multi-resident email OTP verification
* Permanent Resident IDs (`RES-XXXXXXXX`)
* Cloudinary Image Upload
* Report Management
* Admin-managed Personnel Accounts and Report Assignments
* Supabase PostgreSQL database
* Request Correlation Logging

## Setup

1. Copy `.env.example` to `.env` (or use an existing `.env`).

2. Fill in the required environment variables:

   * `SUPABASE_DATABASE_URL`
   * `JWT_SECRET`
   * `RESEND_API_KEY`
   * `EMAIL_FROM`
   * `CLOUDINARY_CLOUD_NAME`
   * `CLOUDINARY_API_KEY`
   * `CLOUDINARY_API_SECRET`

3. For legacy MongoDB-to-PostgreSQL migration only, configure:

   * `MONGODB_MIGRATION_URI`

   This variable is used exclusively by the migration scripts and is not required by the production API runtime.

4. Install dependencies:

   `npm install`

5. Run the backend in development mode:

   `npm run dev`

## Database

The production API uses Supabase PostgreSQL as its database.

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

`npm test` performs a syntax check across all project JavaScript files and runs the assignment request-contract checks. After applying `003`, `005`, and `006` to an approved staging project, run the read-only `npm run verify:schema` command; it checks required columns, constraints, indexes, legacy administrator identifiers, assignment references, and duplicate active assignments without changing data. `npm run verify:personnel` performs a real Supabase-backed create/hash/login verification with a uniquely named temporary account and cleans that account up afterward.

## API Endpoints

### Auth

* `POST /api/auth/register` - Step 1: Register and receive `registrationId`
* `POST /api/auth/verify-otp` - Step 2: Verify OTP and create resident account
* `POST /api/auth/login` - Login with `username` and `password`
* `GET /api/auth/me` - Get the current profile (Protected; admins also receive the canonical `admin` object)
* `GET /api/admin/me` - Get the authenticated administrator account and server-owned activity timestamps (Protected, Admin)

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

The equivalent management routes are also mounted under `/api/personnel`; `POST /api/personnel/login` is public and accepts `username` (or `identifier`, `email`, or `gmail`) plus `password`. Future protected personnel routes should use `protectPersonnel` from `middleware/authMiddleware.js`; it validates the JWT against PostgreSQL and rejects missing, disabled, or deleted accounts.

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

### Render deployment

Render should run `npm install` and `npm start`; the service listens on `process.env.PORT`. Configure `SUPABASE_DATABASE_URL`, `JWT_SECRET`, and the existing email/Cloudinary variables in Render environment settings. Run `npm run migrate:admin-identifiers`, `npm run migrate:personnel`, `npm run migrate:report-assignments`, `npm run migrate:admin-account-activity`, and `npm run migrate:resident-account-activity` once against the target Supabase project before starting the new service version. Verify the resulting schema and constraints in an approved staging project before production deployment; do not run the real-account personnel verification script against production.

Before release, rotate any credential or Maps key that has ever appeared in a local environment file, shell history, source control, or application logs. Remove plaintext password copies/backups, restrict service-account keys to the deployed project, and verify the rotation in the provider dashboards. This repository intentionally does not reproduce or automate those owner-only rotations.
