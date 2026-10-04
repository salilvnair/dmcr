DELETE FROM shop.order_items WHERE order_id IN (SELECT id FROM shop.orders);
DELETE FROM shop.orders WHERE customer_id IN (SELECT id FROM shop.customers);
