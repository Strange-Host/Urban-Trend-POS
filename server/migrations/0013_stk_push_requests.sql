-- An STK push (the prompt on the customer's phone) is answered later by a callback that does NOT say which order it was for.
-- So the push is recorded when it is sent, and the callback finds it again by CheckoutRequestID.
CREATE TABLE stk_push_requests (
  id                   bigserial PRIMARY KEY,
  checkout_request_id  text NOT NULL UNIQUE,
  merchant_request_id  text,
  account_reference    text NOT NULL,
  phone                text,
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0),
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  result_code          integer,
  result_desc          text,
  requested_by         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at          timestamptz
);
CREATE INDEX stk_push_requests_pending ON stk_push_requests (created_at) WHERE status = 'pending';
