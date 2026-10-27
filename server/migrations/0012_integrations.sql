-- Phase F: what outside systems send us, and the credentials we need to talk to them.

-- Credentials and webhook secrets, encrypted by the application (AES-256-GCM, key from SECRETS_KEY) before they are stored.
-- The database never holds a readable secret, so a copied backup does not hand out the keys to the paybill or the stores.
CREATE TABLE integration_secrets (
  provider    text NOT NULL,
  name        text NOT NULL,
  ciphertext  text NOT NULL,
  updated_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, name)
);

-- One row per distinct thing an outside system told us (a paybill confirmation, a store's order event). The unique key is what
-- makes a replay change nothing: the same notice arriving again finds its row and stops. The raw payload is kept as received,
-- so a notice the system could not understand is still on file for a person to look at, and money is never lost silently.
--   processed : handled; result holds what the engine did with it
--   malformed : could not be understood or was refused as invalid; a person must look (an alert is raised)
--   failed    : the server could not finish (for example the database was unavailable); the sender is told to try again,
--               and a later successful delivery of the same notice turns this row into processed
CREATE TABLE webhook_events (
  id           bigserial PRIMARY KEY,
  provider     text NOT NULL,
  kind         text NOT NULL,
  event_key    text NOT NULL,
  status       text NOT NULL CHECK (status IN ('processed', 'malformed', 'failed')),
  payload      jsonb NOT NULL,
  result       jsonb,
  error        text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, kind, event_key)
);
CREATE INDEX webhook_events_attention ON webhook_events (received_at DESC) WHERE status <> 'processed';
