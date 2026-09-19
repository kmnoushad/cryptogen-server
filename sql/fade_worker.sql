-- Run AFTER sql/fade_execution.sql. Existing runtime/jobs are preserved.
create table if not exists public.nexio_fade_control (
  scope text primary key check (scope in ('testnet:primary', 'live:primary')),
  paused boolean not null default true,
  close_requested boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.nexio_fade_control(scope) values ('testnet:primary'), ('live:primary') on conflict do nothing;
create table if not exists public.nexio_fade_worker_status (
  scope text primary key,
  report text not null,
  updated_at timestamptz not null default now()
);
alter table public.nexio_fade_control enable row level security;
alter table public.nexio_fade_worker_status enable row level security;
revoke all on public.nexio_fade_control, public.nexio_fade_worker_status from public, anon, authenticated;
grant select, insert, update on public.nexio_fade_control, public.nexio_fade_worker_status to service_role;
create or replace function public.nexio_fade_control_set(p_scope text, p_action text)
returns setof public.nexio_fade_control language plpgsql security invoker set search_path = public as $$
begin
  if p_action not in ('pause', 'resume', 'close') then raise exception 'Invalid action'; end if;
  return query update nexio_fade_control set
    paused = p_action <> 'resume',
    close_requested = case when p_action = 'close' then true when p_action = 'resume' then false else close_requested end,
    updated_at = clock_timestamp()
    where scope = p_scope returning *;
end;
$$;
revoke all on function public.nexio_fade_control_set(text, text) from public, anon, authenticated;
grant execute on function public.nexio_fade_control_set(text, text) to service_role;
create index if not exists nexio_fade_worker_events_idx on public.nexio_events(created_at, id)
  where event_type = 'FADE_WORKER_SIGNAL_V1';
