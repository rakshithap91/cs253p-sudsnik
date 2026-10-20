create table if not exists webhooks (
  id text primary key,
  at integer not null
);

create table if not exists consumed (
  envelope_id text primary key,
  topic text not null,
  at integer not null
);

create table if not exists operators (
  tenant_id text primary key,
  pricing_tier text not null,
  region text not null,
  currency text not null
);

insert into operators (tenant_id, pricing_tier, region, currency) values
  ('op1', 'standard', 'us', 'USD'),
  ('op2', 'priority', 'eu', 'EUR'),
  ('op3', 'standard', 'apac', 'USD'),
  ('op4', 'priority', 'us', 'USD');

create table if not exists orders (
  order_id text primary key,
  tenant_id text not null,
  cycle_units integer,
  returned integer not null default 0
);

create table if not exists charges (
  charge_id text primary key,
  tenant_id text not null,
  order_id text not null,
  amount integer not null,
  currency text not null,
  state text not null,
  payment_ref text,
  updated_at integer not null
);
create unique index if not exists charges_tenant_order on charges (tenant_id, order_id);
create index if not exists charges_payment_ref on charges (payment_ref);
