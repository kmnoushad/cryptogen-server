-- Run once in Supabase SQL Editor. Backend service_role access ONLY.
create table if not exists public.nexio_fade_runtime (
  scope text primary key,
  owner uuid,
  lease_until timestamptz not null default '-infinity',
  revision bigint not null default 0,
  state jsonb not null default '{"jobs":[],"paused":false}'::jsonb
);
alter table public.nexio_fade_runtime enable row level security;
revoke all on public.nexio_fade_runtime from public, anon, authenticated;
grant select, insert, update on public.nexio_fade_runtime to service_role;

create or replace function public.nexio_fade_lease(p_scope text, p_owner uuid)
returns setof public.nexio_fade_runtime language plpgsql security invoker set search_path = public as $$
begin
  insert into nexio_fade_runtime(scope) values (p_scope) on conflict do nothing;
  return query update nexio_fade_runtime
    set owner = p_owner, lease_until = clock_timestamp() + interval '30 seconds'
    where scope = p_scope and (owner = p_owner or lease_until < clock_timestamp()) returning *;
end;
$$;

create or replace function public.nexio_fade_save(p_scope text, p_owner uuid, p_revision bigint, p_state jsonb)
returns setof public.nexio_fade_runtime language plpgsql security invoker set search_path = public as $$
begin
  if jsonb_typeof(p_state->'jobs') <> 'array' then raise exception 'Invalid jobs'; end if;
  if (select count(*) from jsonb_array_elements(p_state->'jobs') j where j->>'phase' <> 'CLOSED') > 3 then
    raise exception 'Maximum three active fade intents';
  end if;
  return query update nexio_fade_runtime
    set state = p_state, revision = revision + 1
    where scope = p_scope and owner = p_owner and revision = p_revision
      and lease_until > clock_timestamp() returning *;
end;
$$;
revoke all on function public.nexio_fade_lease(text, uuid) from public, anon, authenticated;
revoke all on function public.nexio_fade_save(text, uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.nexio_fade_lease(text, uuid) to service_role;
grant execute on function public.nexio_fade_save(text, uuid, bigint, jsonb) to service_role;
