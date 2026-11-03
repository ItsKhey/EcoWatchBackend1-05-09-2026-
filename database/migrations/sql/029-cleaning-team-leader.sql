-- Migration 029: Cleaning team leader.
--
-- Run with: npm run migrate:cleaning-team-leader
-- Additive and idempotent, so it is safe to re-run.
--
-- ---------------------------------------------------------------------------
-- Why this is needed
-- ---------------------------------------------------------------------------
-- A crew the administrator dispatches has always been a bag of people. The
-- Admin app's Teams screen now manages crews as units and the office has to know
-- who answers for one, so the team carries a leader.
--
-- The leader is also a member: they walk the route like everybody else, they
-- just answer for it. That is why there is no separate leader table and no
-- membership implication here -- the leader is a personnel_accounts row, and the
-- service keeps them on the crew whenever it writes the membership.
--
-- The column is nullable because every team created before this migration has no
-- leader, and inventing one (the first member by id) would name somebody who
-- never agreed to it. The Teams screen counts such a team as needing attention
-- until an administrator chooses.

SELECT pg_advisory_xact_lock(
  hashtext('myecowatch:cleaning-team-leader:v1')
);

ALTER TABLE public.cleaning_teams
  ADD COLUMN IF NOT EXISTS leader_personnel_id TEXT;

COMMENT ON COLUMN public.cleaning_teams.leader_personnel_id IS
  'The personnel member who leads this crew. NULL for a team created before leaders existed, which the Teams screen reports as needing attention.';

-- ON DELETE SET NULL mirrors the other personnel links: deleting an account
-- hard must not remove the crew, it only leaves the crew without a leader.
-- Added in a DO block so a re-run cannot fail on the constraint name.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cleaning_teams_leader_fk'
  ) THEN
    ALTER TABLE public.cleaning_teams
      ADD CONSTRAINT cleaning_teams_leader_fk
      FOREIGN KEY (leader_personnel_id)
      REFERENCES public.personnel_accounts(personnel_id)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_cleaning_teams_leader
  ON public.cleaning_teams (leader_personnel_id)
  WHERE leader_personnel_id IS NOT NULL;
