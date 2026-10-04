UPDATE shop.products p SET price = b.price FROM shop._bak_018_prices b WHERE b.id = p.id;
DROP TABLE shop._bak_018_prices;
