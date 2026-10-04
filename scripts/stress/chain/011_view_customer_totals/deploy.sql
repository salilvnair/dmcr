CREATE VIEW shop.customer_totals AS
SELECT c.id AS customer_id, c.email, count(DISTINCT o.id) AS orders, sum(i.qty * i.unit_price) AS total
FROM shop.customers c
JOIN shop.orders o ON o.customer_id = c.id
JOIN shop.order_items i ON i.order_id = o.id
GROUP BY c.id, c.email;
