-- Carries the phone number through the staged registration flows.
--
-- residents.phone_number already exists (added with the residents table), and
-- messenger_link was added by 017-contact-information.sql. What is missing is
-- the staging column: the Firebase email-link and OTP flows both park the
-- signup in pending_registrations until the address is verified, then copy the
-- fields into residents. Without this column the phone number a resident typed
-- at signup would be dropped on the floor by the transport the app actually
-- uses (verificationMethod=EMAIL_LINK).
--
-- Nullable so rows staged by clients that predate this migration still verify.

ALTER TABLE public.pending_registrations
  ADD COLUMN IF NOT EXISTS phone_number varchar(25);
