-- Step 2 of the build-out: master data. Products, stock, customers, leads and messages.
--
-- STOCK is an append-only list of movements; what is on hand is the sum of them, never a stored counter (the same idea as Rule 2
-- for money). A database trigger refuses any change that would leave a product below zero, and movements can never be edited.
--   receipt (+)  adjustment (+/-, needs a reason)  write_off (-, needs a reason)
--   sale (-)  void_reversal (+)  refund_restock (+)  dispatch (-)  return_restock (+, used when returned parcels are handled)
-- Each sale/dispatch/void/refund movement carries the id of what caused it and can be recorded only once for that cause.

-- ---------------------------------------------------------------- products
CREATE TABLE products (
  id             bigserial PRIMARY KEY,
  sku            text NOT NULL CHECK (sku ~ '^[A-Z0-9][A-Z0-9._-]{0,39}$'),
  name           text NOT NULL CHECK (length(trim(name)) > 0),
  category       text,
  price_cents    bigint NOT NULL CHECK (price_cents >= 0),
  cost_cents     bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  track_stock    boolean NOT NULL DEFAULT true,
  reorder_level  integer NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  active         boolean NOT NULL DEFAULT true,
  created_by     text NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_sku_unique ON products (sku);

-- A SKU is what orders and sales lines point at, so it never changes and a product is never deleted: deactivate it.
CREATE FUNCTION products_protect() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Products cannot be deleted: deactivate the product instead' USING ERRCODE = '55000';
  END IF;
  IF NEW.sku <> OLD.sku THEN
    RAISE EXCEPTION 'A SKU cannot be changed: orders and sales point at it' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER products_protect_update BEFORE UPDATE OR DELETE ON products FOR EACH ROW EXECUTE FUNCTION products_protect();
CREATE TRIGGER products_no_truncate BEFORE TRUNCATE ON products FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- stock movements
CREATE TABLE stock_movements (
  id               bigserial PRIMARY KEY,
  product_id       bigint NOT NULL REFERENCES products (id),
  type             text NOT NULL CHECK (type IN ('receipt', 'adjustment', 'write_off', 'sale', 'void_reversal', 'refund_restock', 'dispatch', 'return_restock')),
  quantity         integer NOT NULL CHECK (quantity <> 0),
  unit_cost_cents  bigint CHECK (unit_cost_cents >= 0),
  reason           text,
  ref_type         text CHECK (ref_type IN ('order', 'sale', 'refund')),
  ref_id           bigint,
  actor            text NOT NULL CHECK (length(trim(actor)) > 0),
  at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sign_matches_type CHECK (
       (type IN ('receipt', 'void_reversal', 'refund_restock', 'return_restock') AND quantity > 0)
    OR (type IN ('write_off', 'sale', 'dispatch') AND quantity < 0)
    OR  type = 'adjustment'),
  CONSTRAINT reason_required CHECK (type NOT IN ('adjustment', 'write_off') OR length(trim(coalesce(reason, ''))) > 0),
  CONSTRAINT ref_pair CHECK ((ref_type IS NULL) = (ref_id IS NULL)),
  CONSTRAINT caused_movements_have_a_cause CHECK (type NOT IN ('sale', 'void_reversal', 'refund_restock', 'dispatch', 'return_restock') OR ref_id IS NOT NULL)
);
CREATE INDEX stock_movements_product ON stock_movements (product_id, at);
-- The same cause (this sale, this dispatch) can move a product's stock only once, so a retry can never deduct twice.
CREATE UNIQUE INDEX stock_movements_once ON stock_movements (type, ref_type, ref_id, product_id) WHERE ref_id IS NOT NULL;
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

CREATE FUNCTION stock_not_negative() RETURNS trigger AS $$
DECLARE total bigint;
BEGIN
  SELECT COALESCE(sum(quantity), 0) INTO total FROM stock_movements WHERE product_id = NEW.product_id;
  IF total < 0 THEN
    RAISE EXCEPTION 'product % would have % in stock: stock can never go below zero', NEW.product_id, total USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER stock_movements_not_negative AFTER INSERT ON stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stock_not_negative();

-- Orders and sales lines point at the product they sold (nullable: an item with no known SKU is simply not stock-tracked,
-- unless the "stock.strict" setting is on).
ALTER TABLE order_items ADD COLUMN product_id bigint REFERENCES products (id);
ALTER TABLE sale_items  ADD COLUMN product_id bigint REFERENCES products (id);
CREATE INDEX order_items_product ON order_items (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX sale_items_product  ON sale_items (product_id)  WHERE product_id IS NOT NULL;

-- ---------------------------------------------------------------- customers
-- One record per phone number (the last nine digits, the same key orders use). Created automatically by the first order or lead.
CREATE TABLE customers (
  id                bigserial PRIMARY KEY,
  name              text NOT NULL CHECK (length(trim(name)) > 0),
  phone             text NOT NULL CHECK (length(trim(phone)) > 0),
  phone_normalized  text NOT NULL CHECK (phone_normalized ~ '^[0-9]{7,9}$'),
  alt_phone         text,
  town              text,
  address           text,
  notes             text,
  -- A customer who must pay before anything is dispatched to them.
  prepay_required   boolean NOT NULL DEFAULT false,
  prepay_reason     text,
  created_by        text NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prepay_needs_reason CHECK (NOT prepay_required OR length(trim(coalesce(prepay_reason, ''))) > 0)
);
CREATE UNIQUE INDEX customers_phone_unique ON customers (phone_normalized);
CREATE FUNCTION customers_protect() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Customers cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW.phone_normalized <> OLD.phone_normalized THEN RAISE EXCEPTION 'A customer''s phone key cannot be changed' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER customers_protect_update BEFORE UPDATE OR DELETE ON customers FOR EACH ROW EXECUTE FUNCTION customers_protect();
CREATE TRIGGER customers_no_truncate BEFORE TRUNCATE ON customers FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

ALTER TABLE orders ADD COLUMN customer_id bigint REFERENCES customers (id);
CREATE INDEX orders_customer ON orders (customer_id) WHERE customer_id IS NOT NULL;

-- ---------------------------------------------------------------- leads and their messages
CREATE TABLE leads (
  id                   bigserial PRIMARY KEY,
  name                 text,
  phone                text NOT NULL CHECK (length(trim(phone)) > 0),
  phone_normalized     text NOT NULL CHECK (phone_normalized ~ '^[0-9]{7,9}$'),
  source               text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'whatsapp', 'website', 'phone', 'walk_in', 'shopify', 'other')),
  product_interest     text,
  notes                text,
  status               text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'lost')),
  assigned_to          text,
  lost_reason          text,
  converted_order_ref  text UNIQUE REFERENCES order_refs (ref),
  converted_at         timestamptz,
  created_by           text NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT converted_has_order CHECK ((status = 'converted') = (converted_order_ref IS NOT NULL)),
  CONSTRAINT lost_has_reason CHECK (status <> 'lost' OR length(trim(coalesce(lost_reason, ''))) > 0)
);
CREATE INDEX leads_status ON leads (status, created_at);
CREATE INDEX leads_assigned ON leads (assigned_to) WHERE assigned_to IS NOT NULL;
-- One OPEN lead per phone number: a repeat enquiry adds to the existing lead instead of creating a second.
CREATE UNIQUE INDEX leads_one_open_per_phone ON leads (phone_normalized) WHERE status IN ('new', 'contacted', 'qualified');
CREATE TRIGGER leads_no_truncate BEFORE TRUNCATE ON leads FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE FUNCTION leads_no_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Leads cannot be deleted: mark them lost with a reason' USING ERRCODE = '55000'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER leads_no_delete BEFORE DELETE ON leads FOR EACH ROW EXECUTE FUNCTION leads_no_delete();

-- The conversation with a lead: what they sent, what we sent, and internal notes. Never edited.
CREATE TABLE lead_messages (
  id         bigserial PRIMARY KEY,
  lead_id    bigint NOT NULL REFERENCES leads (id),
  direction  text NOT NULL CHECK (direction IN ('inbound', 'outbound', 'note')),
  channel    text NOT NULL DEFAULT 'internal' CHECK (channel IN ('whatsapp', 'sms', 'call', 'website', 'internal')),
  body       text NOT NULL CHECK (length(trim(body)) > 0),
  actor      text NOT NULL CHECK (length(trim(actor)) > 0),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_messages_lead ON lead_messages (lead_id, at);
CREATE TRIGGER lead_messages_immutable BEFORE UPDATE OR DELETE ON lead_messages FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER lead_messages_no_truncate BEFORE TRUNCATE ON lead_messages FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
