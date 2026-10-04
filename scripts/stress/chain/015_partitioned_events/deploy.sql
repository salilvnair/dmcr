CREATE TABLE shop.events (
  id   bigint NOT NULL,
  at   timestamptz NOT NULL,
  kind text NOT NULL
) PARTITION BY RANGE (at);
CREATE TABLE shop.events_2026_01 PARTITION OF shop.events FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE shop.events_2026_02 PARTITION OF shop.events FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE shop.events_2026_03 PARTITION OF shop.events FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
INSERT INTO shop.events
SELECT g, timestamptz '2026-01-01' + (g % 89) * interval '1 day', CASE g % 3 WHEN 0 THEN 'view' WHEN 1 THEN 'cart' ELSE 'buy' END
FROM generate_series(1, 90000) g;
