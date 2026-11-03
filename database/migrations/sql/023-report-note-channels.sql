-- Migration 023: Split the report note channels by audience
--
-- A report has three separate conversations, and until now all of them were
-- squeezed into `reports.admin_response`:
--
--   1. The official administrator answer to the resident (resident-facing).
--   2. Working instructions for the assigned cleaner (personnel-only).
--   3. The reviewer's reason for sending the finished work back (personnel-only).
--
-- Channels 2 and 3 are internal operations detail. Writing them into the
-- resident-facing field leaked them: requesting a revision stored the note in
-- `admin_response`, so the resident could read an internal "the after photos do
-- not show the drainage grate was cleared" instruction that was never meant for
-- them, and it also raised a resident notification claiming the admin had updated
-- their report response.
--
-- This migration adds `reports.personnel_note` as the personnel-only channel.
-- `admin_response` keeps its single meaning: the answer the resident is meant to
-- read. Nothing here rewrites history; `personnel_note` starts empty and is only
-- populated by the assignment and revision commands once they are redeployed.
--
-- The cleaner's own completion notes already live in
-- `personnel_assignments.completion_notes`. They are surfaced to the resident
-- by the API as `personnelResponse`, so no column is needed for them.
--
-- `trash_reports` is only a marker table (report_id, resident_id, deleted_at) and
-- deliberately carries no report content, so it needs no change.
--
-- Idempotent so it can be re-run on an already-migrated database.

-- 1. Active reports: the column the assignment and revision commands write.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS personnel_note TEXT;

-- 2. Archived reports: a report keeps its notes when it leaves the active
--    collection, so the resident-facing history view stays consistent with the
--    active one. This mirrors how admin_response is carried across the move.
ALTER TABLE archived_reports ADD COLUMN IF NOT EXISTS personnel_note TEXT;