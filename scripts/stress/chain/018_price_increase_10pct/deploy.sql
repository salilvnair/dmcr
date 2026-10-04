-- keep the old prices so revert can restore them exactly
CREATE TABLE shop._bak_018_prices AS SELECT id, price FROM shop.products;
UPDATE shop.products SET price = round(price * 1.10, 2);
