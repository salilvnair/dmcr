-- 600k-row update; the statement-level trigger from 013 keeps orders.total in step
CREATE TABLE shop._bak_019_unit_prices AS SELECT id, unit_price FROM shop.order_items;
UPDATE shop.order_items i SET unit_price = p.price FROM shop.products p WHERE p.id = i.product_id;
