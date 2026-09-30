-- Independent directional Futures state. Run once in Supabase SQL Editor.
create table if not exists public.nexio_futures_runtime (
  scope text primary key check (scope in ('testnet:directional', 'live:directional')),
  owner uuid,
  lease_until timestamptz not null default '-infinity',
  revision bigint not null default 0,
  state jsonb not null default '{"jobs":[],"paused":true}'::jsonb
);
alter table public.nexio_futures_runtime enable row level security;
revoke all on public.nexio_futures_runtime from public, anon, authenticated;
grant select, insert, update on public.nexio_futures_runtime to service_role;

create or replace function public.nexio_futures_lease(p_scope text, p_owner uuid)
returns setof public.nexio_futures_runtime language plpgsql security invoker set search_path = public as $$
begin
  insert into nexio_futures_runtime(scope) values (p_scope) on conflict do nothing;
  return query update nexio_futures_runtime
    set owner = p_owner, lease_until = clock_timestamp() + interval '30 seconds'
    where scope = p_scope and (owner = p_owner or lease_until < clock_timestamp()) returning *;
end;
$$;

create or replace function public.nexio_futures_save(p_scope text, p_owner uuid, p_revision bigint, p_state jsonb)
returns setof public.nexio_futures_runtime language plpgsql security invoker set search_path = public as $$
begin
  if jsonb_typeof(p_state->'jobs') is distinct from 'array' then raise exception 'Invalid jobs'; end if;
  if exists (select 1 from jsonb_array_elements(p_state->'jobs') j
    where j->>'phase' is null or j->>'phase' not in ('SUBMITTING', 'OPEN', 'CLOSED')
      or j->>'direction' is null or j->>'direction' not in ('LONG', 'SHORT')) then
    raise exception 'Invalid Futures job direction/phase';
  end if;
  if (select count(*) from jsonb_array_elements(p_state->'jobs') j where j->>'phase' is distinct from 'CLOSED') > 5 then
    raise exception 'Maximum five active Futures intents';
  end if;
  return query update nexio_futures_runtime
    set state = p_state, revision = revision + 1
    where scope = p_scope and owner = p_owner and revision = p_revision
      and lease_until > clock_timestamp() returning *;
end;
$$;
revoke all on function public.nexio_futures_lease(text, uuid) from public, anon, authenticated;
revoke all on function public.nexio_futures_save(text, uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.nexio_futures_lease(text, uuid) to service_role;
grant execute on function public.nexio_futures_save(text, uuid, bigint, jsonb) to service_role;


create table if not exists public.nexio_futures_control (
  scope text primary key check (scope in ('testnet:directional', 'live:directional')),
  paused boolean not null default true,
  close_requested boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.nexio_futures_control(scope) values ('testnet:directional'), ('live:directional') on conflict do nothing;
create table if not exists public.nexio_futures_worker_status (
  scope text primary key,
  report text not null,
  updated_at timestamptz not null default now()
);
alter table public.nexio_futures_control enable row level security;
alter table public.nexio_futures_worker_status enable row level security;
revoke all on public.nexio_futures_control, public.nexio_futures_worker_status from public, anon, authenticated;
grant select, insert, update on public.nexio_futures_control, public.nexio_futures_worker_status to service_role;
create or replace function public.nexio_futures_control_set(p_scope text, p_action text)
returns setof public.nexio_futures_control language plpgsql security invoker set search_path = public as $$
begin
  if p_action not in ('pause', 'resume', 'close') then raise exception 'Invalid action'; end if;
  return query update nexio_futures_control set
    paused = p_action <> 'resume',
    close_requested = case when p_action = 'close' then true when p_action = 'resume' then false else close_requested end,
    updated_at = clock_timestamp()
    where scope = p_scope returning *;
end;
$$;
revoke all on function public.nexio_futures_control_set(text, text) from public, anon, authenticated;
grant execute on function public.nexio_futures_control_set(text, text) to service_role;
