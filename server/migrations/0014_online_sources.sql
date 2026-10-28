-- Phase F: online stores (Shopify, WooCommerce) and the orders that came from them.
--
-- A connection's secrets (Shopify's client secret, WooCommerce's webhook secret) are NOT here: they live encrypted in
-- integration_secrets under the provider "source:<id>". The ids matter: webhook URLs already registered with the stores end in the
-- legacy connection's id (/api/integrations/webhooks/shopify/<id>), so the import at cutover must keep each connection's id.
CREATE TABLE income_sources (
  id                 bigserial PRIMARY KEY,
  platform           text NOT NULL CHECK (platform IN ('shopify', 'woocommerce')),
  name               text NOT NULL CHECK (length(trim(name)) > 0),
  shop_domain        text,
  is_active          boolean NOT NULL DEFAULT true,
  live_sync_enabled  boolean NOT NULL DEFAULT false,
  -- true: a to-ship online order becomes an order here (and reserves stock). false: the connection is recorded only.
  import_orders      boolean NOT NULL DEFAULT true,
  last_webhook_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One row per online order that became an order here. The unique key is what makes a re-delivery, a retry, or the same order
-- arriving as "created" and then "updated" produce exactly one order.
CREATE TABLE online_orders (
  id                 bigserial PRIMARY KEY,
  income_source_id   bigint NOT NULL REFERENCES income_sources (id),
  external_order_id  text NOT NULL,
  label              text NOT NULL,
  order_ref          text NOT NULL UNIQUE REFERENCES orders (order_ref),
  -- The customer paid on the store's own checkout (card, gateway). The ledger has no account for that money yet, so these orders
  -- show a balance until a person records the payment; this column is how to find them.
  paid_online        boolean NOT NULL DEFAULT false,
  gateway            text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (income_source_id, external_order_id)
);
CREATE INDEX online_orders_paid_online ON online_orders (created_at DESC) WHERE paid_online;
