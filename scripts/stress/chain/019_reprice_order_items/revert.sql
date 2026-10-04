UPDATE shop.order_items i SET unit_price = b.unit_price FROM shop._bak_019_unit_prices b WHERE b.id = i.id;
DROP TABLE shop._bak_019_unit_prices;
