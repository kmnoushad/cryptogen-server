-- NEXIO v6.4 migration for an existing v6.1-v6.3 database.
-- Safe to run once before deploying v6.4. The DO blocks avoid changing the
-- delivery state of outcome messages if this file is accidentally run again.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'nexio_trades'
      and column_name = 'exit_alert_sent'
  ) then
    alter table public.nexio_trades
      add column exit_alert_sent boolean not null default true;
    alter table public.nexio_trades
      alter column exit_alert_sent set default false;
  end if;
end $$;

create table if not exists public.nexio_alpha_trades (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  chain_id text not null,
  chain_name text not null,
  contract_address text not null,
  symbol text not null,
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED','CANCELLED')),
  outcome text check (outcome is null or outcome in ('WIN','LOSS','SCRATCH','TIMEOUT')),
  entry numeric not null,
  initial_sl numeric not null,
  active_sl numeric not null,
  tp1 numeric not null,
  tp2 numeric not null,
  tp3 numeric not null,
  entry_liquidity numeric not null,
  current_liquidity numeric not null,
  peak_price numeric not null,
  lowest_price numeric not null,
  current_price numeric not null,
  max_gain_pct numeric not null default 0,
  max_drawdown_pct numeric not null default 0,
  setup_score numeric not null,
  security_rating text,
  risk_score numeric,
  setup jsonb not null default '{}'::jsonb,
  alert_sent boolean not null default false,
  exit_alert_sent boolean not null default false,
  exit_price numeric,
  exit_reason text,
  pnl_pct numeric,
  created_at timestamptz not null default now(),
  last_checked_at timestamptz,
  closed_at timestamptz
);

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'nexio_alpha_trades'
      and column_name = 'exit_alert_sent'
  ) then
    alter table public.nexio_alpha_trades
      add column exit_alert_sent boolean not null default true;
    alter table public.nexio_alpha_trades
      alter column exit_alert_sent set default false;
  end if;
end $$;

create unique index if not exists nexio_one_open_alpha_trade_per_contract
  on public.nexio_alpha_trades(chain_id, contract_address) where status = 'OPEN';
create index if not exists nexio_alpha_trades_created_idx
  on public.nexio_alpha_trades(created_at desc);
create index if not exists nexio_alpha_trades_open_idx
  on public.nexio_alpha_trades(status) where status = 'OPEN';

alter table public.nexio_alpha_trades enable row level security;
