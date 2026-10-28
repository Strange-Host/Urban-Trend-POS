-- Phase F: customer text messages (SMS), sent through the Zettatel gateway.
--
-- A message is first written here, in the SAME transaction as the thing it is about (an order, a receipt), so an order that rolls back
-- never sends a text, and sending itself (a network call, which can be slow or fail) never holds up or breaks taking an order or a payment.
-- A worker then sends what is due.
--   queued   : waiting for its turn (or for credentials, or for a retry)
--   sending  : claimed by a worker; if the worker dies, it is put back after 10 minutes
--   sent     : the gateway accepted it
--   failed   : gave up after 5 attempts; a person can retry it
--   expired  : still unsent after 24 hours, so dropped rather than delivered late ("your payment was received" a day later helps nobody)
CREATE TABLE sms_outbox (
  id                 bigserial PRIMARY KEY,
  to_phone           text NOT NULL,
  template           text NOT NULL,
  body               text NOT NULL,
  related_type       text,
  related_id         text,
  -- The same event queued twice (a redelivered payment notice, a retried request) is one message: this is the guard.
  dedupe_key         text,
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'expired')),
  attempts           integer NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  last_error         text,
  provider_response  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sms_outbox_dedupe ON sms_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX sms_outbox_due ON sms_outbox (next_attempt_at) WHERE status = 'queued';
CREATE INDEX sms_outbox_recent ON sms_outbox (id DESC);
