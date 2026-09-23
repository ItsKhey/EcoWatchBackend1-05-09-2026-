# MyEcoWatchBackend1

The production-ready backend for the EcoWatch ecosystem.

## Features

* JWT Authentication
* Multi-resident email OTP verification
* Permanent Resident IDs (`RES-XXXXXXXX`)
* Cloudinary Image Upload
* Report Management
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

## API Endpoints

### Auth

* `POST /api/auth/register` - Step 1: Register and receive `registrationId`
* `POST /api/auth/verify-otp` - Step 2: Verify OTP and create resident account
* `POST /api/auth/login` - Login with `username` and `password`
* `GET /api/auth/me` - Get current resident profile (Protected)

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
