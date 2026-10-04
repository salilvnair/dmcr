-- 4 orders per customer, 3 items per order (ids taken from the rows, not assumed)
INSERT INTO shop.orders (customer_id, status)
SELECT c.id, CASE WHEN k = 4 THEN 'shipped' ELSE 'new' END
FROM shop.customers c CROSS JOIN generate_series(1, 4) k;

WITH p AS (SELECT array_agg(id ORDER BY id) AS ids FROM shop.products)
INSERT INTO shop.order_items (order_id, product_id, qty, unit_price)
SELECT o.id, p.ids[1 + ((o.id * k) % array_length(p.ids, 1))::int], 1 + (o.id % 3)::int, 9.99
FROM shop.orders o CROSS JOIN generate_series(1, 3) k CROSS JOIN p;
