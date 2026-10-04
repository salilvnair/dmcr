-- a view on a view
CREATE VIEW shop.top_customers AS
SELECT customer_id, email, total FROM shop.customer_totals WHERE total > 250 ORDER BY total DESC;
