-- NEXIO v6.9.6 BTC recorder table. Run ONCE in the Supabase SQL editor.
-- One row per closed BTCUSDT 1m candle (~1,440 rows/day). If this table is
-- missing the recorder logs one clear warning and disables itself; the BTC
-- bias engine keeps working in-memory either way.

create table if not exists public.btc_snapshots (
  ts timestamptz primary key,
  close numeric not null,
  ema9 numeric,
  ema21 numeric,
  ema50 numeric,
  buy_ratio_1m numeric,
  buy_ratio_5m numeric,
  buy_ratio_15m numeric,
  cvd_15m numeric,
  book_imb_top10 numeric,
  bid_wall_bps numeric,
  ask_wall_bps numeric,
  bid_wall_x numeric,
  ask_wall_x numeric,
  vol_velocity numeric,
  oi_chg_pct numeric,
  funding numeric,
  score15 integer,
  label15 text,
  conf15 integer,
  score30 integer,
  label30 text,
  conf30 integer
);

create index if not exists btc_snapshots_ts_idx on public.btc_snapshots(ts desc);
