-- Phase F: what it takes to call a store, and where the safety-net poll has got to.
-- The secrets themselves (Shopify client secret and its cached access token, WooCommerce consumer key and secret) stay encrypted in
-- integration_secrets under "source:<id>". What is here is not secret: the shop's address, the app's public client id, and timings.
ALTER TABLE income_sources
  ADD COLUMN site_url          text,          -- WooCommerce: https://shop.example.com
  ADD COLUMN api_key           text,          -- Shopify: the app's client id (public); the matching secret is encrypted
  ADD COLUMN api_version       text,
  ADD COLUMN oauth_scopes      text,
  ADD COLUMN token_expires_at  timestamptz,   -- null on a pasted token that never expires
  ADD COLUMN last_poll_at      timestamptz,   -- the last ATTEMPT: paces the poll so a failing store is not hammered
  ADD COLUMN last_poll_ok_at   timestamptz,   -- the last SUCCESS: where the next poll starts looking, so a failure never skips orders
  ADD COLUMN last_poll_error   text;
