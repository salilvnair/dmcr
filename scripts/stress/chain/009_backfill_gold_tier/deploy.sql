UPDATE shop.customers SET tier = 'gold'
WHERE id IN (
  SELECT o.customer_id FROM shop.orders o JOIN shop.order_items i ON i.order_id = o.id
  GROUP BY o.customer_id HAVING sum(i.qty * i.unit_price) > 200
);
