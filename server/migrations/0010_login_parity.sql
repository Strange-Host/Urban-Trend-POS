-- Phase B of the legacy-first plan: the login, session and permission behaviour the legacy screens already rely on.
--
--   * Email sign-in (usernames keep working: they are still the key on every earlier record and never change).
--   * Register PIN, locked separately from the password.
--   * Sessions that go idle, lock, expire and can be listed and revoked, with short-lived access tokens and
--     rotating refresh tokens inside them.
--   * Per-user permission overrides on top of the role defaults (admin is never restricted).
--   * A small settings store; the security rules (lock times, lockout) live there under the legacy key names.

ALTER TABLE users
  ADD COLUMN email                 text CHECK (email IS NULL OR (email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  ADD COLUMN phone                 text,
  ADD COLUMN pin_hash              text,
  ADD COLUMN pin_failed_attempts   integer NOT NULL DEFAULT 0,
  ADD COLUMN pin_locked_until      timestamptz,
  ADD COLUMN two_factor_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN password_changed_at   timestamptz;
CREATE UNIQUE INDEX users_email_unique ON users (email) WHERE email IS NOT NULL;

-- A session is one sign-in on one device. expires_at is its hard maximum; the access token inside it is short-lived and
-- is replaced (with a short overlap, so two browser tabs do not trip over each other) every time the refresh token is used.
ALTER TABLE sessions
  ADD COLUMN remember          boolean NOT NULL DEFAULT false,
  ADD COLUMN user_agent        text,
  ADD COLUMN ip                text,
  ADD COLUMN last_activity_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN reauth_at         timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN revoked_reason    text,
  ADD COLUMN access_expires_at timestamptz,
  ADD COLUMN prev_token_hash   text,
  ADD COLUMN prev_valid_until  timestamptz;
UPDATE sessions SET access_expires_at = expires_at;
ALTER TABLE sessions ALTER COLUMN access_expires_at SET NOT NULL;
CREATE INDEX sessions_prev_token ON sessions (prev_token_hash) WHERE prev_token_hash IS NOT NULL;

-- Only a hash is stored. A token that was already swapped for a new one and is presented again later means someone kept a copy.
CREATE TABLE refresh_tokens (
  id             bigserial PRIMARY KEY,
  session_id     bigint NOT NULL REFERENCES sessions (id),
  user_id        bigint NOT NULL REFERENCES users (id),
  token_hash     text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  replaced_by_id bigint REFERENCES refresh_tokens (id)
);
CREATE INDEX refresh_tokens_session ON refresh_tokens (session_id) WHERE revoked_at IS NULL;

-- Only differences from the role default are stored. An override that restates the default is removed, so a later change to
-- a role's defaults still reaches everyone who was never individually customised.
CREATE TABLE user_permissions (
  user_id     bigint NOT NULL REFERENCES users (id),
  permission  text NOT NULL,
  granted     boolean NOT NULL,
  updated_by  text NOT NULL CHECK (length(trim(updated_by)) > 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);

CREATE TABLE app_settings (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z0-9_.]+$'),
  value       text NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
