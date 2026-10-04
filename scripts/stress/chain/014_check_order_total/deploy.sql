ALTER TABLE shop.orders ADD CONSTRAINT ck_orders_total_nonneg CHECK (total >= 0) NOT VALID;
ALTER TABLE shop.orders VALIDATE CONSTRAINT ck_orders_total_nonneg;
