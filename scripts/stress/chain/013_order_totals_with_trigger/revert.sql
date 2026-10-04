DROP TRIGGER trg_items_upd ON shop.order_items;
DROP TRIGGER trg_items_del ON shop.order_items;
DROP TRIGGER trg_items_ins ON shop.order_items;
DROP FUNCTION shop.recalc_order_totals_upd();
DROP FUNCTION shop.recalc_order_totals();
ALTER TABLE shop.orders DROP COLUMN total;
