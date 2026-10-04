CREATE TABLE shop.products (
  id    serial PRIMARY KEY,
  sku   text NOT NULL UNIQUE,
  name  text NOT NULL,
  price numeric(10,2) NOT NULL CHECK (price > 0)
);
