-- Server-side tables. Revoke client roles; only the Render service-role key may read or write.
create table if not exists public.seller_state (
  seller_id text primary key,
  payload jsonb not null,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists public.seller_catalog (
  capability_id text primary key,
  seller_id text not null,
  manifest jsonb not null,
  blob_id text not null,
  signature text not null,
  transport_public_key text not null,
  preview jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.seller_events (
  id bigint generated always as identity primary key,
  run_id text not null,
  seller_id text not null,
  stage text not null,
  status text not null,
  details jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists public.seller_payment_claims (
  digest text primary key,
  request_id text not null unique,
  seller_id text not null,
  created_at timestamptz not null default now()
);
create index if not exists seller_events_run_idx on public.seller_events (run_id, id);
alter table public.seller_state enable row level security;
alter table public.seller_catalog enable row level security;
alter table public.seller_events enable row level security;
alter table public.seller_payment_claims enable row level security;
revoke all on public.seller_state, public.seller_catalog, public.seller_events, public.seller_payment_claims from anon, authenticated;
