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
