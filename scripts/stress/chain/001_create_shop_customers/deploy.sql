CREATE SCHEMA IF NOT EXISTS shop;
CREATE TABLE shop.customers (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  name       text,
  address    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
