INSERT INTO shop.customers (email, name, address)
SELECT 'c' || g || '@shop.test', 'Customer ' || g, g || ' Market Street'
FROM generate_series(1, 50000) g;
