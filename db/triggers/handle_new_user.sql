-- Trigger: auto-create Profile when a new user signs up via Supabase Auth
--
-- Not a migration: applied by hand on each Supabase project (and before the
-- migrations on a stand-in / restore — docs/superpowers/ops-runbook.md). Every
-- change here has to be applied to BOTH projects (dev, prod) by the owner:
--   psql "$DATABASE_URL_DIRECT" -1 -v ON_ERROR_STOP=1 -f db/triggers/handle_new_user.sql
-- Failure look if one project is skipped: nothing errors; on that project a new
-- account whose provider name is the system label signs up under it.
--
-- #1782 — the OAuth full_name is copied without any validator, so a provider
-- name that IS the system's left label (「已離開的夥伴」 and its zh-CN / en /
-- ja forms, plus the retired en wording 'a partner who left';
-- lib/reservedDisplayName.ts) falls back to the email, the same fallback as no
-- full_name at all. Compared on a normalised copy, the SQL twin
-- of normalizeForReservedCheck: NFKC → drop default-ignorable / format
-- characters → collapse whitespace → trim → lower → fold 離開夥 to 离开伙.
-- The name is stored as given when it is not reserved. Look-alike characters
-- still pass (accepted residual; the system style is the main control).
-- Check after applying (both must be the email / the name):
--   __tests__/actions/leftLabelMarker1782.test.ts › handle_new_user
--
-- #1885 — with no usable name AND no email the insert used to write NULL into
-- display_name (NOT NULL), which rolls back the auth.users INSERT: GoTrue
-- answers `unexpected_failure` and that person can never sign up, however
-- often they retry. iOS native Apple sign-in sends an identity token with no
-- full_name, and some Apple IDs share no email (seen in prod 2026-10-29). A
-- blank name or email counts as missing; the last fallback is the fixed
-- neutral '新成員' (not localised; the user can rename in settings).
-- Check after applying: SELECT prosrc LIKE '%新成員%' FROM pg_proc
--   WHERE oid = 'public.handle_new_user()'::regprocedure;  -- must be true
--
-- SET search_path and the grants repeat 0022 / 0023: CREATE OR REPLACE resets
-- the function's SET clauses, so leaving the clause out here would quietly
-- undo 0022's hardening on every manual apply.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  v_name text := NEW.raw_user_meta_data->>'full_name';
  v_cmp text;
BEGIN
  IF v_name IS NOT NULL THEN
    v_cmp := translate(
      lower(btrim(regexp_replace(
        regexp_replace(
          normalize(v_name, NFKC),
          '[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￻؀-؅۝܏࢐࢑࣢\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0000-\U000E0FFF]',
          '', 'g'),
        '\s+', ' ', 'g'))),
      '離開夥', '离开伙');
    IF v_cmp IN ('已离开的伙伴', 'partner who left', 'a partner who left', '退出したパートナー') THEN
      v_name := NULL;
    END IF;
  END IF;

  INSERT INTO public."Profiles" (id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(
      CASE WHEN btrim(v_name) <> '' THEN v_name END,
      CASE WHEN btrim(NEW.email) <> '' THEN NEW.email END,
      '新成員'
    ),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO postgres, service_role;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
