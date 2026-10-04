ALTER TABLE shop.customers ADD COLUMN address text;
UPDATE shop.customers c SET address = a.line1 FROM shop.addresses a WHERE a.customer_id = c.id;
DROP TABLE shop.addresses;
