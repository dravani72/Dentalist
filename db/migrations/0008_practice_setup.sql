-- 0008 Practice setup (MASTER_SPEC §3, §8).
--
-- Staff administration, provider working hours and authenticator replay protection.
--
-- Workforce identities (user_account) are global and stay read-only to the application role.
-- The few writes staff administration needs go through the narrow SECURITY DEFINER functions
-- below, each of which checks that the target account belongs only to the calling practice, so
-- one practice's administrator can never take over a person's sign-in at another practice.

-- ---------------------------------------------------------------- authenticator replay

-- Highest 30-second TOTP step ever accepted for this account. A code is accepted only for a later
-- step, so a code seen over someone's shoulder (or replayed from a captured request) is useless.
ALTER TABLE user_account ADD COLUMN totp_last_step bigint;
-- Set by an administrator's sign-in reset; the person must finish setup before signing in again.
ALTER TABLE user_account ADD COLUMN setup_required boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION auth_totp_consume(p_user uuid, p_step bigint) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (
    UPDATE user_account SET totp_last_step = p_step
     WHERE id = p_user AND (totp_last_step IS NULL OR totp_last_step < p_step)
    RETURNING id
  )
  SELECT EXISTS (SELECT 1 FROM u)
$$;

-- ---------------------------------------------------------------- provider kind

-- Whether a staff member can be booked as a dentist or hygienist provider. Set explicitly by an
-- administrator: a scheduling attribute only, it grants no authority (privileges and verified
-- credentials do that).
ALTER TABLE staff_member ADD COLUMN provider_kind text CHECK (provider_kind IN ('dentist', 'hygienist'));
ALTER TABLE staff_member ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE staff_member ADD COLUMN version integer NOT NULL DEFAULT 1;
-- One-time carry-over for practices created before this column existed.
UPDATE staff_member SET provider_kind = role_template WHERE role_template IN ('dentist', 'hygienist');

-- ---------------------------------------------------------------- credential verification

-- Administrator-entered licenses start as pending and count for nothing until someone other than
-- the holder records a primary-source verification.
ALTER TABLE credential DROP CONSTRAINT credential_status_check;
ALTER TABLE credential ADD CONSTRAINT credential_status_check
  CHECK (status IN ('pending_verification', 'active', 'expired', 'suspended', 'revoked'));
ALTER TABLE credential ADD COLUMN verification_source text;
ALTER TABLE credential ADD COLUMN created_by uuid;
ALTER TABLE credential ADD COLUMN status_changed_at timestamptz;
ALTER TABLE credential ADD COLUMN status_changed_by uuid;
ALTER TABLE credential ADD COLUMN status_reason text;
ALTER TABLE credential ADD CONSTRAINT credential_active_is_verified
  CHECK (status <> 'active' OR kind = 'npi' OR verified_at IS NOT NULL) NOT VALID;
ALTER TABLE credential ADD CONSTRAINT credential_not_self_verified
  CHECK (verified_by IS NULL OR verified_by <> staff_member_id);

-- ---------------------------------------------------------------- working hours

-- A provider's weekly hours at one location. Changes never rewrite history: a new set of hours
-- starts on a date and the previous rows end the day before, so past schedules stay explainable.
-- Planned hours that are replaced before they ever started are marked superseded, not deleted.
CREATE TABLE provider_hours (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id          uuid NOT NULL REFERENCES organization(id),
  staff_member_id uuid NOT NULL,
  location_id     uuid NOT NULL,
  weekday         smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday
  start_minute    smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute      smallint NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  effective_from  date NOT NULL,
  effective_to    date,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  superseded_at   timestamptz,
  CHECK (end_minute > start_minute),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  FOREIGN KEY (org_id, staff_member_id) REFERENCES staff_member(org_id, id),
  FOREIGN KEY (org_id, location_id) REFERENCES location(org_id, id)
);
CREATE INDEX provider_hours_lookup ON provider_hours (org_id, location_id, staff_member_id, weekday) WHERE superseded_at IS NULL;
SELECT enable_tenant_rls('provider_hours');

-- Vacation, training and other blocks. The reason is a category, never patient information.
CREATE TABLE provider_time_off (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id          uuid NOT NULL REFERENCES organization(id),
  staff_member_id uuid NOT NULL,
  during          tstzrange NOT NULL,
  reason          text NOT NULL CHECK (reason IN ('vacation', 'sick', 'training', 'meeting', 'other')),
  note            text,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  cancelled_at    timestamptz,
  cancelled_by    uuid,
  CHECK (NOT isempty(during)),
  FOREIGN KEY (org_id, staff_member_id) REFERENCES staff_member(org_id, id)
);
CREATE INDEX provider_time_off_lookup ON provider_time_off USING gist (staff_member_id, during);
SELECT enable_tenant_rls('provider_time_off');

-- Existing providers keep the hours online booking used before this migration (Mon–Fri 8–17).
INSERT INTO provider_hours (org_id, staff_member_id, location_id, weekday, start_minute, end_minute, effective_from, created_by)
SELECT s.org_id, s.id, l, d, 480, 1020, current_date, s.id
  FROM staff_member s, unnest(s.location_ids) AS l, generate_series(1, 5) AS d
 WHERE s.provider_kind IS NOT NULL AND s.active;

-- ---------------------------------------------------------------- account setup

-- One-time link an administrator gives a new or reset staff member to choose a password and
-- enrol an authenticator. Only a hash of the link's token is stored.
CREATE TABLE account_setup (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  org_id           uuid NOT NULL REFERENCES organization(id),
  user_id          uuid NOT NULL REFERENCES user_account(id),
  token_hash       text NOT NULL UNIQUE,
  pending_totp_enc text,
  attempts         integer NOT NULL DEFAULT 0,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  completed_at     timestamptz,
  revoked_at       timestamptz
);
SELECT enable_tenant_rls('account_setup');

-- True when every practice membership of the account is in the calling practice.
CREATE OR REPLACE FUNCTION staff_account_is_local(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_org() IS NOT NULL
     AND EXISTS (SELECT 1 FROM staff_member WHERE user_id = p_user AND org_id = app_org())
     AND NOT EXISTS (SELECT 1 FROM staff_member WHERE user_id = p_user AND org_id <> app_org())
$$;

-- Finds or creates the sign-in for a new staff member. A new account cannot sign in until setup
-- is finished; an existing account (someone who already works at another practice) is returned
-- unchanged, with created = false, and keeps its own password and authenticator.
CREATE OR REPLACE FUNCTION staff_account_find_or_create(p_email text, p_display_name text)
RETURNS TABLE (user_id uuid, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v uuid;
BEGIN
  IF app_org() IS NULL THEN RAISE EXCEPTION 'no tenant' USING ERRCODE = '42501'; END IF;
  SELECT id INTO v FROM user_account WHERE lower(email) = lower(p_email);
  IF v IS NOT NULL THEN
    RETURN QUERY SELECT v, false;
    RETURN;
  END IF;
  INSERT INTO user_account (email, display_name, password_hash, totp_secret_enc, setup_required)
  VALUES (p_email, p_display_name, '!', '', true) RETURNING id INTO v;
  RETURN QUERY SELECT v, true;
END $$;

-- Administrator's sign-in reset: wipes the password and authenticator, ends every session.
-- Refused for accounts that also belong to another practice.
CREATE OR REPLACE FUNCTION staff_account_reset(p_user uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT staff_account_is_local(p_user) THEN RETURN false; END IF;
  UPDATE user_account SET password_hash = '!', totp_secret_enc = '', totp_last_step = NULL, setup_required = true WHERE id = p_user;
  UPDATE user_session SET revoked_at = now() WHERE user_id = p_user AND revoked_at IS NULL;
  RETURN true;
END $$;

-- Resolves a setup token to its practice before the request knows its tenant.
CREATE OR REPLACE FUNCTION account_setup_org(p_token_hash text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT org_id FROM account_setup
   WHERE token_hash = p_token_hash AND completed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
$$;

-- Finishes setup: stores the new password hash and authenticator secret for the setup's account.
CREATE OR REPLACE FUNCTION account_setup_apply(p_setup uuid, p_password_hash text, p_totp_enc text, p_step bigint) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v uuid;
BEGIN
  UPDATE account_setup SET completed_at = now()
   WHERE id = p_setup AND org_id = app_org() AND completed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
  RETURNING user_id INTO v;
  IF v IS NULL THEN RETURN false; END IF;
  UPDATE user_account SET password_hash = p_password_hash, totp_secret_enc = p_totp_enc, totp_last_step = p_step, setup_required = false
   WHERE id = v AND setup_required;
  RETURN FOUND;
END $$;

-- ---------------------------------------------------------------- grants

GRANT SELECT, INSERT, UPDATE ON provider_hours, provider_time_off, account_setup TO teeth_app;
GRANT EXECUTE ON FUNCTION auth_totp_consume(uuid, bigint), staff_account_is_local(uuid),
  staff_account_find_or_create(text, text), staff_account_reset(uuid), account_setup_org(text),
  account_setup_apply(uuid, text, text, bigint) TO teeth_app;
REVOKE EXECUTE ON FUNCTION auth_totp_consume(uuid, bigint), staff_account_is_local(uuid),
  staff_account_find_or_create(text, text), staff_account_reset(uuid), account_setup_org(text),
  account_setup_apply(uuid, text, text, bigint) FROM PUBLIC;
