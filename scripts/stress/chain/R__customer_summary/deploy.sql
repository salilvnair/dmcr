CREATE OR REPLACE VIEW shop.customer_summary AS
SELECT tier, count(*) AS customers FROM shop.customers GROUP BY tier;
