-- Adds the fields the admin app's "Contact Information" card renders.
--
-- phone_number already exists on both tables, so only the messenger deep link
-- is introduced here. The link is stored verbatim and handed straight to
-- Messenger by the client, which is why it is kept as text rather than being
-- normalised into a username: Messenger accepts m.me and facebook.com forms.
--
-- Both columns are nullable so existing rows stay valid and the client hides
-- the row when no link is stored.

ALTER TABLE public.personnel_accounts
  ADD COLUMN IF NOT EXISTS messenger_link varchar(500);

ALTER TABLE public.residents
  ADD COLUMN IF NOT EXISTS messenger_link varchar(500);
