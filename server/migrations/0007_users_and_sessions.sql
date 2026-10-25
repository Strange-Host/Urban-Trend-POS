-- Step 1 of the build-out: login, sessions and roles.
--
-- A user's USERNAME is the key every earlier phase already stores as text (actor names, orders.assigned_to, payroll staff_key,
-- cashier). So usernames can never change and users can never be deleted: deactivate instead. History keeps pointing at a real person.
-- Roles come from the logged-in user, never from a request parameter.

CREATE TABLE users (
  id                    bigserial PRIMARY KEY,
  username              text NOT NULL CHECK (username ~ '^[a-z0-9][a-z0-9._-]{1,31}$'),
  display_name          text NOT NULL CHECK (length(trim(display_name)) > 0),
  role                  text NOT NULL CHECK (role IN ('admin', 'manager', 'cashier')),
  password_hash         text NOT NULL,
  active                boolean NOT NULL DEFAULT true,
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_attempts       integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text NOT NULL CHECK (length(trim(created_by)) > 0)
);
CREATE UNIQUE INDEX users_username_unique ON users (username);

CREATE FUNCTION users_protect() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Users cannot be deleted: deactivate the account instead, so history keeps pointing at a real person'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.username <> OLD.username THEN
    RAISE EXCEPTION 'A username cannot be changed: it is the key on every earlier record'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER users_protect_update BEFORE UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION users_protect();
CREATE TRIGGER users_no_truncate BEFORE TRUNCATE ON users FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Only a SHA-256 of the token is stored, so a copy of the database cannot be used to take over a session.
CREATE TABLE sessions (
  id            bigserial PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users (id),
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;
