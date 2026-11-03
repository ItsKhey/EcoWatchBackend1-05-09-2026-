-- Firebase email verification + Firebase-assisted password reset.
-- Run with: npm run migrate:firebase-email-verification
--
-- This migration is additive and idempotent. It is safe to run before the new
-- code is deployed and safe to run twice.
--
-- NOTHING here changes how login works. No existing column is dropped, renamed,
-- retyped or re-constrained, and password_hash / resident_id / admin_id /
-- username / last_active / status are all left exactly as they are. Login
-- continues to read username + password_hash from Supabase and nothing in this
-- file is read by the login path.
--
-- The four new columns per table record WHO proved the email address, WHEN the
-- proof was requested, and WHEN it landed. They are audit data. email_verified
-- is deliberately NOT a login condition: accounts that predate this migration
-- are backfilled below so that not a single existing resident is ever asked to
-- re-verify an address they already proved under the old OTP flow.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:firebase-email-verification:v1')
);

-- ---------------------------------------------------------------------------
-- Account tables
-- ---------------------------------------------------------------------------
-- firebase_uid is the link to the Firebase Auth identity that owns the
-- verification for this address. It is nullable because accounts created before
-- this feature have no Firebase identity until they next use a password reset,
-- at which point the identity is created on demand and backfilled here.

ALTER TABLE public.residents
  ADD COLUMN IF NOT EXISTS firebase_uid text,
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

ALTER TABLE public.admins
  ADD COLUMN IF NOT EXISTS firebase_uid text,
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

COMMENT ON COLUMN public.residents.firebase_uid IS
  'Firebase Auth identity that proves this email address. NULL for accounts predating Firebase verification.';
COMMENT ON COLUMN public.residents.email_verified IS
  'True when this email address was proven (Firebase email-link, or the legacy OTP code). Audit only; never a login condition.';
COMMENT ON COLUMN public.residents.verification_sent_at IS
  'When a verification link was last issued to this address. Also the resend cooldown clock.';
COMMENT ON COLUMN public.residents.verified_at IS
  'When this email address was first proven.';

COMMENT ON COLUMN public.admins.firebase_uid IS
  'Firebase Auth identity that proves this email address. NULL for accounts predating Firebase verification.';
COMMENT ON COLUMN public.admins.email_verified IS
  'True when this email address was proven (Firebase email-link, or the legacy OTP code). Audit only; never a login condition.';
COMMENT ON COLUMN public.admins.verification_sent_at IS
  'When a verification link was last issued to this address. Also the resend cooldown clock.';
COMMENT ON COLUMN public.admins.verified_at IS
  'When this email address was first proven.';

-- One Firebase identity, one account. This is the database-level guarantee that
-- a resident and an admin row can never end up sharing a uid, which would let a
-- password reset for one of them touch the other's credential. The index is
-- partial so the many NULL uids of unmigrated accounts do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS residents_firebase_uid_key
  ON public.residents (firebase_uid)
  WHERE firebase_uid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS admins_firebase_uid_key
  ON public.admins (firebase_uid)
  WHERE firebase_uid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Backfill existing accounts
-- ---------------------------------------------------------------------------
-- Every existing resident and admin completed the legacy 4-digit OTP flow,
-- which was itself a proof of email ownership. is_verified already records that
-- outcome, so it is the honest source for email_verified and it keeps the
-- backfill consistent with data the system already trusted.
--
-- verified_at falls back to created_at because the true proof time was never
-- stored. It is audit data, and a value that is merely accurate beats a NULL
-- that reads as "never verified".

UPDATE public.residents
SET email_verified = COALESCE(is_verified, false),
    verified_at = COALESCE(created_at, NOW())
WHERE verified_at IS NULL;

UPDATE public.admins
SET email_verified = COALESCE(is_verified, false),
    verified_at = COALESCE(created_at, NOW())
WHERE verified_at IS NULL;

-- ---------------------------------------------------------------------------
-- Registration staging table
-- ---------------------------------------------------------------------------
-- pending_registrations is shared by both verification transports, discriminated
-- by verification_flow:
--   'OTP'        legacy 4-digit code. Rows and behaviour unchanged.
--   'EMAIL_LINK' Firebase email link. otp_hash is NULL and firebase_uid is set.
--
-- CREATE TABLE IF NOT EXISTS is a no-op on an installation that already has the
-- table, which is the same defensive shape the earlier migrations in this
-- project use. The ALTERs below are what actually apply the new shape.

CREATE TABLE IF NOT EXISTS public.pending_registrations (
  registration_id varchar(32) PRIMARY KEY,
  username varchar(50) NOT NULL,
  email varchar(254) NOT NULL,
  first_name varchar(100),
  last_name varchar(100),
  password_hash text NOT NULL,
  otp_hash text,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0
);

ALTER TABLE public.pending_registrations
  ADD COLUMN IF NOT EXISTS firebase_uid text,
  ADD COLUMN IF NOT EXISTS verification_flow text NOT NULL DEFAULT 'OTP',
  ADD COLUMN IF NOT EXISTS verification_sent_at timestamptz;

-- The email-link flow has no OTP to store, so the column that was mandatory for
-- the OTP flow has to permit NULL. Existing rows keep their hashes untouched.
ALTER TABLE public.pending_registrations
  ALTER COLUMN otp_hash DROP NOT NULL;

COMMENT ON COLUMN public.pending_registrations.firebase_uid IS
  'Unverified Firebase identity for this signup. NULL for legacy OTP registrations.';
COMMENT ON COLUMN public.pending_registrations.verification_flow IS
  'OTP = legacy 4-digit code, EMAIL_LINK = Firebase verification link. Selects which verification branch applies.';
COMMENT ON COLUMN public.pending_registrations.verification_sent_at IS
  'When a verification link was last issued. Also the resend cooldown clock.';

-- A signup is looked up by email when Firebase reports the address already has
-- an unverified identity, so this lookup has to be indexed.
CREATE INDEX IF NOT EXISTS pending_registrations_email_idx
  ON public.pending_registrations (lower(email));

-- Sweeps abandoned signups. The two flows expire on different clocks, which is
-- why this is driven by expires_at rather than by a fixed age.
CREATE INDEX IF NOT EXISTS pending_registrations_expires_at_idx
  ON public.pending_registrations (expires_at);

-- ---------------------------------------------------------------------------
-- Password-reset rate limiting
-- ---------------------------------------------------------------------------
-- The Firebase reset flow needs to remember that a link was recently issued to
-- an address, so one address cannot be used to flood an inbox. It records that
-- in this same table with otp_hash left NULL, reusing the existing per-address
-- row instead of introducing a new table.
--
-- otp_hash therefore has to tolerate NULL. Existing rows keep their hashes and
-- the legacy OTP flow still always writes one.
ALTER TABLE public.password_reset_otps
  ALTER COLUMN otp_hash DROP NOT NULL;

COMMENT ON COLUMN public.password_reset_otps.otp_hash IS
  'Legacy 4-digit OTP hash. NULL when this row is only a rate-limit marker for a Firebase reset link.';
