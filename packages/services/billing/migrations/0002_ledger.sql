create table if not exists ledger (
  entry_id text primary key,
  tenant_id text not null,
  order_id text not null,
  kind text not null,
  amount integer not null,
  currency text not null,
  at integer not null,
  ref text
);

-- One authorize, capture, or refund per order when the row names a provider payment.
create unique index if not exists ledger_kind_with_ref on ledger (tenant_id, order_id, kind) where ref is not null;

create trigger if not exists ledger_no_update before update on ledger
begin
  select raise(abort, 'ledger is append-only');
end;

create trigger if not exists ledger_no_delete before delete on ledger
begin
  select raise(abort, 'ledger is append-only');
end;
