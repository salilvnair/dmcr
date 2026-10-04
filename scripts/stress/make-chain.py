"""Writes scripts/stress/chain/: a realistic chain of DMCR changes for the stress run.

An online shop schema built up over 22 versioned changes plus a repeatable:
tables with foreign keys, 50k customers / 5k products / 200k orders / 600k order items,
an enum, a backfill, indexes, views on views, a statement-level trigger, a validated
CHECK constraint, a partitioned table, a column rename, moving a column into its own
table, price changes with backup tables, a 600k-row update, CREATE INDEX CONCURRENTLY,
and a danger_ change that DMCR must never run by itself.

Every verify.sql uses the DMCR guard: it asserts the applied state when the change is in
dmcr.change_log, and the reverted state when it is not. Run: python make-chain.py
"""
import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'chain')


def guard(cid, applied_cond, reverted_cond, what):
    # Each state's checks sit in their own branch: PL/pgSQL parses a condition only when it
    # runs, so the applied-state checks may name columns that the revert removes.
    return f"""DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '{cid}') THEN
    IF NOT ({applied_cond}) THEN RAISE EXCEPTION '{cid}: {what} missing after deploy'; END IF;
  ELSE
    IF NOT ({reverted_cond}) THEN RAISE EXCEPTION '{cid}: {what} still present after revert'; END IF;
  END IF;
END $$;
"""


def rel(name):
    return f"to_regclass('{name}') IS NOT NULL"


def norel(name):
    return f"to_regclass('{name}') IS NULL"


def col(t, c):
    s, tb = t.split('.')
    return f"EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '{s}' AND table_name = '{tb}' AND column_name = '{c}')"


CHANGES = []


def change(cid, deploy, revert, applied_cond, reverted_cond, what, meta=None):
    CHANGES.append((cid, deploy.strip() + '\n', revert.strip() + '\n', guard(cid, applied_cond, reverted_cond, what), meta))


change('001_create_shop_customers', """
CREATE SCHEMA IF NOT EXISTS shop;
CREATE TABLE shop.customers (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  name       text,
  address    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
""", """
DROP TABLE shop.customers;
DROP SCHEMA shop;
""", rel('shop.customers'), norel('shop.customers'), 'shop.customers')

change('002_create_products', """
CREATE TABLE shop.products (
  id    serial PRIMARY KEY,
  sku   text NOT NULL UNIQUE,
  name  text NOT NULL,
  price numeric(10,2) NOT NULL CHECK (price > 0)
);
""", "DROP TABLE shop.products;", rel('shop.products'), norel('shop.products'), 'shop.products')

change('003_create_orders', """
CREATE TABLE shop.orders (
  id          bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES shop.customers(id),
  status      text NOT NULL DEFAULT 'new',
  created_at  timestamptz NOT NULL DEFAULT now()
);
""", "DROP TABLE shop.orders;", rel('shop.orders'), norel('shop.orders'), 'shop.orders')

change('004_create_order_items', """
CREATE TABLE shop.order_items (
  id         bigserial PRIMARY KEY,
  order_id   bigint NOT NULL REFERENCES shop.orders(id) ON DELETE CASCADE,
  product_id int    NOT NULL REFERENCES shop.products(id),
  qty        int    NOT NULL CHECK (qty > 0),
  unit_price numeric(10,2) NOT NULL
);
-- index the foreign keys: deleting orders would otherwise scan every order item per row
CREATE INDEX idx_order_items_order ON shop.order_items (order_id);
CREATE INDEX idx_order_items_product_fk ON shop.order_items (product_id);
""", "DROP TABLE shop.order_items;", rel('shop.order_items'), norel('shop.order_items'), 'shop.order_items',
       {'requires': ['002_create_products', '003_create_orders']})

change('005_seed_customers', """
INSERT INTO shop.customers (email, name, address)
SELECT 'c' || g || '@shop.test', 'Customer ' || g, g || ' Market Street'
FROM generate_series(1, 50000) g;
""", "DELETE FROM shop.customers WHERE email LIKE 'c%@shop.test';",
       "(SELECT count(*) FROM shop.customers WHERE email LIKE 'c%@shop.test') = 50000",
       "NOT EXISTS (SELECT 1 FROM shop.customers WHERE email LIKE 'c%@shop.test')", '50k seeded customers')

change('006_seed_products', """
INSERT INTO shop.products (sku, name, price)
SELECT 'SKU-' || g, 'Product ' || g, ((g % 500) + 1) / 1.0
FROM generate_series(1, 5000) g;
""", "DELETE FROM shop.products WHERE sku LIKE 'SKU-%';",
       "(SELECT count(*) FROM shop.products) = 5000", "NOT EXISTS (SELECT 1 FROM shop.products WHERE sku LIKE 'SKU-%')", '5k seeded products')

change('007_seed_orders_and_items', """
-- 4 orders per customer, 3 items per order (ids taken from the rows, not assumed)
INSERT INTO shop.orders (customer_id, status)
SELECT c.id, CASE WHEN k = 4 THEN 'shipped' ELSE 'new' END
FROM shop.customers c CROSS JOIN generate_series(1, 4) k;

WITH p AS (SELECT array_agg(id ORDER BY id) AS ids FROM shop.products)
INSERT INTO shop.order_items (order_id, product_id, qty, unit_price)
SELECT o.id, p.ids[1 + ((o.id * k) % array_length(p.ids, 1))::int], 1 + (o.id % 3)::int, 9.99
FROM shop.orders o CROSS JOIN generate_series(1, 3) k CROSS JOIN p;
""", """
DELETE FROM shop.order_items WHERE order_id IN (SELECT id FROM shop.orders);
DELETE FROM shop.orders WHERE customer_id IN (SELECT id FROM shop.customers);
""", "(SELECT count(*) FROM shop.order_items) = 600000 AND (SELECT count(*) FROM shop.orders) = 200000",
       "NOT EXISTS (SELECT 1 FROM shop.orders)", '200k orders / 600k items',
       {'requires': ['004_create_order_items', '005_seed_customers', '006_seed_products']})

change('008_add_customer_tier', """
CREATE TYPE shop.tier AS ENUM ('basic', 'gold');
ALTER TABLE shop.customers ADD COLUMN tier shop.tier NOT NULL DEFAULT 'basic';
""", """
ALTER TABLE shop.customers DROP COLUMN tier;
DROP TYPE shop.tier;
""", col('shop.customers', 'tier'), f"NOT {col('shop.customers', 'tier')} AND to_regtype('shop.tier') IS NULL", 'customers.tier')

change('009_backfill_gold_tier', """
UPDATE shop.customers SET tier = 'gold'
WHERE id IN (
  SELECT o.customer_id FROM shop.orders o JOIN shop.order_items i ON i.order_id = o.id
  GROUP BY o.customer_id HAVING sum(i.qty * i.unit_price) > 200
);
""", "UPDATE shop.customers SET tier = 'basic' WHERE tier = 'gold';",
       "EXISTS (SELECT 1 FROM shop.customers WHERE tier = 'gold')",
       f"NOT {col('shop.customers', 'tier')} OR NOT EXISTS (SELECT 1 FROM shop.customers WHERE tier = 'gold')", 'gold customers',
       {'requires': ['007_seed_orders_and_items', '008_add_customer_tier']})

change('010_idx_orders_customer', "CREATE INDEX idx_orders_customer ON shop.orders (customer_id);",
       "DROP INDEX shop.idx_orders_customer;", rel('shop.idx_orders_customer'), norel('shop.idx_orders_customer'), 'idx_orders_customer')

change('011_view_customer_totals', """
CREATE VIEW shop.customer_totals AS
SELECT c.id AS customer_id, c.email, count(DISTINCT o.id) AS orders, sum(i.qty * i.unit_price) AS total
FROM shop.customers c
JOIN shop.orders o ON o.customer_id = c.id
JOIN shop.order_items i ON i.order_id = o.id
GROUP BY c.id, c.email;
""", "DROP VIEW shop.customer_totals;", rel('shop.customer_totals'), norel('shop.customer_totals'), 'customer_totals view')

change('012_view_top_customers', """
-- a view on a view
CREATE VIEW shop.top_customers AS
SELECT customer_id, email, total FROM shop.customer_totals WHERE total > 250 ORDER BY total DESC;
""", "DROP VIEW shop.top_customers;", rel('shop.top_customers'), norel('shop.top_customers'), 'top_customers view',
       {'requires': ['011_view_customer_totals']})

change('013_order_totals_with_trigger', """
ALTER TABLE shop.orders ADD COLUMN total numeric(12,2) NOT NULL DEFAULT 0;

UPDATE shop.orders o SET total = t.total
FROM (SELECT order_id, sum(qty * unit_price) AS total FROM shop.order_items GROUP BY order_id) t
WHERE t.order_id = o.id;

-- keeps orders.total right; statement-level with transition tables so bulk changes stay fast
CREATE FUNCTION shop.recalc_order_totals() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE shop.orders o SET total = coalesce((SELECT sum(qty * unit_price) FROM shop.order_items i WHERE i.order_id = o.id), 0)
  WHERE o.id IN (SELECT order_id FROM changed);
  RETURN NULL;
END $fn$;

CREATE FUNCTION shop.recalc_order_totals_upd() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE shop.orders o SET total = coalesce((SELECT sum(qty * unit_price) FROM shop.order_items i WHERE i.order_id = o.id), 0)
  WHERE o.id IN (SELECT order_id FROM changed_new UNION SELECT order_id FROM changed_old);
  RETURN NULL;
END $fn$;

CREATE TRIGGER trg_items_ins AFTER INSERT ON shop.order_items
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION shop.recalc_order_totals();
CREATE TRIGGER trg_items_del AFTER DELETE ON shop.order_items
  REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION shop.recalc_order_totals();
CREATE TRIGGER trg_items_upd AFTER UPDATE ON shop.order_items
  REFERENCING NEW TABLE AS changed_new OLD TABLE AS changed_old FOR EACH STATEMENT EXECUTE FUNCTION shop.recalc_order_totals_upd();
""", """
DROP TRIGGER trg_items_upd ON shop.order_items;
DROP TRIGGER trg_items_del ON shop.order_items;
DROP TRIGGER trg_items_ins ON shop.order_items;
DROP FUNCTION shop.recalc_order_totals_upd();
DROP FUNCTION shop.recalc_order_totals();
ALTER TABLE shop.orders DROP COLUMN total;
""", f"{col('shop.orders', 'total')} AND NOT EXISTS (SELECT 1 FROM shop.orders WHERE total = 0)",
       f"NOT {col('shop.orders', 'total')}", 'orders.total + triggers',
       {'requires': ['007_seed_orders_and_items']})

change('014_check_order_total', """
ALTER TABLE shop.orders ADD CONSTRAINT ck_orders_total_nonneg CHECK (total >= 0) NOT VALID;
ALTER TABLE shop.orders VALIDATE CONSTRAINT ck_orders_total_nonneg;
""", "ALTER TABLE shop.orders DROP CONSTRAINT ck_orders_total_nonneg;",
       "EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_orders_total_nonneg' AND convalidated)",
       "NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_orders_total_nonneg')", 'validated check constraint',
       {'requires': ['013_order_totals_with_trigger']})

change('015_partitioned_events', """
CREATE TABLE shop.events (
  id   bigint NOT NULL,
  at   timestamptz NOT NULL,
  kind text NOT NULL
) PARTITION BY RANGE (at);
CREATE TABLE shop.events_2026_01 PARTITION OF shop.events FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE shop.events_2026_02 PARTITION OF shop.events FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE shop.events_2026_03 PARTITION OF shop.events FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
INSERT INTO shop.events
SELECT g, timestamptz '2026-01-01' + (g % 89) * interval '1 day', CASE g % 3 WHEN 0 THEN 'view' WHEN 1 THEN 'cart' ELSE 'buy' END
FROM generate_series(1, 90000) g;
""", "DROP TABLE shop.events;",
       "(SELECT count(*) FROM shop.events) = 90000", norel('shop.events'), '90k partitioned events')

change('016_rename_product_name_to_title', "ALTER TABLE shop.products RENAME COLUMN name TO title;",
       "ALTER TABLE shop.products RENAME COLUMN title TO name;",
       col('shop.products', 'title'), col('shop.products', 'name'), 'products.title')

change('017_move_address_to_table', """
CREATE TABLE shop.addresses (
  customer_id bigint PRIMARY KEY REFERENCES shop.customers(id) ON DELETE CASCADE,
  line1       text NOT NULL
);
INSERT INTO shop.addresses (customer_id, line1)
SELECT id, address FROM shop.customers WHERE address IS NOT NULL;
ALTER TABLE shop.customers DROP COLUMN address;
""", """
ALTER TABLE shop.customers ADD COLUMN address text;
UPDATE shop.customers c SET address = a.line1 FROM shop.addresses a WHERE a.customer_id = c.id;
DROP TABLE shop.addresses;
""", f"{rel('shop.addresses')} AND NOT {col('shop.customers', 'address')}",
       f"{norel('shop.addresses')} AND {col('shop.customers', 'address')}", 'addresses table')

change('018_price_increase_10pct', """
-- keep the old prices so revert can restore them exactly
CREATE TABLE shop._bak_018_prices AS SELECT id, price FROM shop.products;
UPDATE shop.products SET price = round(price * 1.10, 2);
""", """
UPDATE shop.products p SET price = b.price FROM shop._bak_018_prices b WHERE b.id = p.id;
DROP TABLE shop._bak_018_prices;
""", rel('shop._bak_018_prices'), norel('shop._bak_018_prices'), 'price backup')

change('019_reprice_order_items', """
-- 600k-row update; the statement-level trigger from 013 keeps orders.total in step
CREATE TABLE shop._bak_019_unit_prices AS SELECT id, unit_price FROM shop.order_items;
UPDATE shop.order_items i SET unit_price = p.price FROM shop.products p WHERE p.id = i.product_id;
""", """
UPDATE shop.order_items i SET unit_price = b.unit_price FROM shop._bak_019_unit_prices b WHERE b.id = i.id;
DROP TABLE shop._bak_019_unit_prices;
""", f"{rel('shop._bak_019_unit_prices')} AND NOT EXISTS (SELECT 1 FROM shop.order_items WHERE unit_price = 9.99 AND product_id IN (SELECT id FROM shop.products WHERE price <> 9.99))",
       norel('shop._bak_019_unit_prices'), 'repriced items',
       {'requires': ['013_order_totals_with_trigger', '018_price_increase_10pct']})

change('020_idx_items_product_concurrently',
       "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_items_product ON shop.order_items (product_id);",
       "DROP INDEX CONCURRENTLY IF EXISTS shop.idx_items_product;",
       rel('shop.idx_items_product'), norel('shop.idx_items_product'), 'idx_items_product',
       {'transaction': False})

change('021_danger_drop_legacy_events', "DROP TABLE shop.events_2026_01;",
       "CREATE TABLE shop.events_2026_01 PARTITION OF shop.events FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');",
       norel('shop.events_2026_01'), rel('shop.events_2026_01'), 'legacy partition drop')

change('022_add_order_note', "ALTER TABLE shop.orders ADD COLUMN note text;",
       "ALTER TABLE shop.orders DROP COLUMN note;",
       col('shop.orders', 'note'), f"NOT {col('shop.orders', 'note')}", 'orders.note')


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    for cid, deploy, revert, verify, meta in CHANGES:
        d = os.path.join(OUT, cid)
        os.makedirs(d)
        for name, text in (('deploy.sql', deploy), ('revert.sql', revert), ('verify.sql', verify)):
            with open(os.path.join(d, name), 'w', encoding='utf-8', newline='\n') as f:
                f.write(text)
        m = {'change_id': cid, 'description': f'stress chain: {cid[4:].replace("_", " ")}', 'tags': ['stress'], 'requires': [], 'author': 'dmcr-stress'}
        m.update(meta or {})
        with open(os.path.join(d, 'meta.json'), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(m, f, indent=2)
    r = os.path.join(OUT, 'R__customer_summary')
    os.makedirs(r)
    with open(os.path.join(r, 'deploy.sql'), 'w', encoding='utf-8', newline='\n') as f:
        f.write("CREATE OR REPLACE VIEW shop.customer_summary AS\nSELECT tier, count(*) AS customers FROM shop.customers GROUP BY tier;\n")
    with open(os.path.join(r, 'verify.sql'), 'w', encoding='utf-8', newline='\n') as f:
        f.write("SELECT 1 FROM shop.customer_summary LIMIT 1;\n")
    print(f'wrote {len(CHANGES)} changes + 1 repeatable to {OUT}')


if __name__ == '__main__':
    main()
