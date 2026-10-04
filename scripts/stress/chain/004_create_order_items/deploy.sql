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
