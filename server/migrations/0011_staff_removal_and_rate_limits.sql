-- Removing staff accounts, and limiting sign-in attempts per address.
--
-- A person is the TEXT username on every record, never a foreign key, so history can only be kept by never letting that name
-- point at someone else. Three ways to remove an account:
--   * deactivate (already there): cannot sign in, everything they did stays, can be reactivated;
--   * delete permanently: only for an account that never did anything. The row goes, and the username is RETIRED so nobody can
--     ever be given it again (the few sign-in records under that name would otherwise attach to a stranger);
--   * erase personal data: for former staff with history. Name, email, phone, password and PIN are wiped; the username stays
--     because it is the key on their records, and an erased account can never be reactivated.

ALTER TABLE users ADD COLUMN erased_at timestamptz;
ALTER TABLE users ADD CONSTRAINT users_erased_inactive CHECK (erased_at IS NULL OR NOT active);

CREATE TABLE retired_usernames (
  username    text PRIMARY KEY,
  retired_at  timestamptz NOT NULL DEFAULT now(),
  retired_by  text NOT NULL CHECK (length(trim(retired_by)) > 0)
);
CREATE TRIGGER retired_usernames_immutable BEFORE UPDATE OR DELETE ON retired_usernames FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER retired_usernames_no_truncate BEFORE TRUNCATE ON retired_usernames FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

CREATE FUNCTION users_no_retired_name() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM retired_usernames WHERE username = NEW.username) THEN
    RAISE EXCEPTION 'That username belonged to a deleted account and can never be used again'
      USING ERRCODE = '23505', CONSTRAINT = 'retired_username';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER users_no_retired_name BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION users_no_retired_name();

-- A stray DELETE still fails. The one permitted path (deleting an account that never did anything) switches the guard off for
-- its own transaction only, after the application has checked every table for activity.
CREATE OR REPLACE FUNCTION users_protect() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_user_delete', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'Users cannot be deleted: deactivate the account instead, so history keeps pointing at a real person'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.username <> OLD.username THEN
    RAISE EXCEPTION 'A username cannot be changed: it is the key on every earlier record'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- One row per address and time window. Kept in the database, not in memory, so every server instance counts the same attempts
-- and a restart does not hand an attacker a fresh allowance.
CREATE TABLE rate_limits (
  key           text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);
