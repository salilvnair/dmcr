CREATE TABLE shop.addresses (
  customer_id bigint PRIMARY KEY REFERENCES shop.customers(id) ON DELETE CASCADE,
  line1       text NOT NULL
);
INSERT INTO shop.addresses (customer_id, line1)
SELECT id, address FROM shop.customers WHERE address IS NOT NULL;
ALTER TABLE shop.customers DROP COLUMN address;
