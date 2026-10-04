INSERT INTO shop.products (sku, name, price)
SELECT 'SKU-' || g, 'Product ' || g, ((g % 500) + 1) / 1.0
FROM generate_series(1, 5000) g;
