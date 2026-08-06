-- Security-hardening plan §7 step 4 / §5.2: the developer axis.
--
-- The developer is NOT a rank in the owner>admin>member hierarchy — it is an
-- independent flag that rides on top of whatever org rank the person holds
-- (§5.2 "כובעים מצטברים"). A developer sees every feature (to build) but is
-- excluded, explicitly, from user management (§5.3) and from key exposure
-- (§5.4). Modelling it as a boolean column — rank × developer-axis, two
-- independent fields — keeps the CHECK on `role` untouched and lets the same
-- person be, say, an org owner AND a developer.
--
-- Additive and reversible (DROP COLUMN). Default false: every existing member
-- keeps their exact current behaviour until the flag is explicitly set.
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS is_developer boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.org_members.is_developer IS
  'Security plan §5.2: independent developer axis (not a rank). true = full '
  'feature visibility for building, but hard-excluded from user management '
  '(§5.3) and key exposure (§5.4), and from impersonation (§9.7). Enforced in '
  'code (req.member.isDeveloper) and, when direct DB access is provisioned, by '
  'a non-service_role DB role (§5.5, docs/aymen-env-handoff.md).';
