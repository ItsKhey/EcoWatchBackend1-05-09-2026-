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
npm run migrate:personnel
npm run migrate:admin-account-activity
```

The second migration adds the server-owned `admins.last_active` timestamp used by the admin Account Details screen. The same SQL files can be pasted into the Supabase SQL editor. The personnel migration creates `personnel_accounts`, `PERS-XXXX` ID generation, bcrypt-hash storage, Gmail/username constraints, lifecycle timestamps, admin audit fields, current-report assignment fields, indexes, and the `updated_at` trigger. PostgreSQL advisory-lock-backed triggers also serialize identity writes and enforce case-insensitive username/Gmail uniqueness across Personnel, Resident, and Admin tables, closing concurrent create/edit races in addition to the controller pre-checks.

`npm test` performs a syntax check across all project JavaScript files. `npm run verify:personnel` performs a real Supabase-backed create/hash/login verification with a uniquely named temporary account and cleans that account up afterward.

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

### Reports

* `POST /api/reports` - Submit report with image (Multipart) (Protected)
* `GET /api/reports/my-reports?view=default|archive|trash|all` - Get filtered reports for the current resident (Protected)
* `PATCH /api/reports/:id/trash` - Move a report to trash (Protected)
* `PATCH /api/reports/:id/soft-delete` - Legacy alias for moving a report to trash (Protected)
* `PATCH /api/reports/:id/restore` - Restore a report from trash (Protected)
* `PATCH /api/reports/:id/archive` - Archive a report (Protected)
* `POST /api/reports/bulk-soft-delete` - Move reports to trash; body is an array of IDs (Protected)
* `POST /api/reports/bulk-restore` - Restore reports; body is an array of IDs (Protected)
* `POST /api/reports/bulk-archive` - Archive reports; body is an array of IDs (Protected)

### Report assignment integration

`POST /api/admin/reports/:id/assign` accepts new `PERS-XXXX` IDs and legacy `RES-XXXXXXXX` IDs already present in historical report/client data. `handledById` is optional for admin requests; when supplied by a personnel client it must be a `PERS-XXXX` ID. Legacy IDs remain stored in `assignedPersonnelIds` for compatibility but are validated against legacy `residents.role = 'Environmental Services Personnel'`; they are not copied into `personnel_accounts` or synchronized to current-assignment fields. New `PERS-XXXX` assignments are. Legacy resident rows are not silently reclassified as personnel because their identity, Gmail, role, and lifecycle data require explicit admin review. Report updates and new personnel current-assignment updates run in one PostgreSQL transaction. Assigned `PERS` accounts are set to `CLEANING`, their report coordinates are stored as the assignment location snapshot, and report approval clears the assignment and returns personnel to `OFFLINE`. A personnel account with a current assignment cannot be disabled or deleted until the assignment is removed/reassigned.

### Render deployment

Render should run `npm install` and `npm start`; the service listens on `process.env.PORT`. Configure `SUPABASE_DATABASE_URL`, `JWT_SECRET`, and the existing email/Cloudinary variables in Render environment settings. Run `npm run migrate:personnel` once against the target Supabase project before starting the new service version.
