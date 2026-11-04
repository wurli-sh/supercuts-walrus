-- Public signed registrations for independently hosted Testnet sellers.
-- Access remains server-only; the service exposes a bounded public catalog.
create table if not exists public.seller_directory (
  capability_id text primary key,
  seller_id text not null,
  registration jsonb not null,
  endpoint_origin text not null,
  expires_at bigint not null,
  updated_at timestamptz not null default now()
);
create index if not exists seller_directory_expiry_idx on public.seller_directory (expires_at);
create or replace function public.enforce_seller_directory_owner() returns trigger
language plpgsql as $$
begin
  if new.seller_id <> old.seller_id then
    raise exception 'seller_directory capability identity cannot change';
  end if;
  return new;
end;
$$;
drop trigger if exists seller_directory_owner_guard on public.seller_directory;
create trigger seller_directory_owner_guard before update on public.seller_directory
for each row execute function public.enforce_seller_directory_owner();
alter table public.seller_directory enable row level security;
revoke all on public.seller_directory from anon, authenticated;

