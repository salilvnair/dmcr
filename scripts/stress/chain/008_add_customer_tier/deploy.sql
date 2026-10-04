CREATE TYPE shop.tier AS ENUM ('basic', 'gold');
ALTER TABLE shop.customers ADD COLUMN tier shop.tier NOT NULL DEFAULT 'basic';
