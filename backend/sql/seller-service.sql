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

-- Hosted seller row store. Each value is authenticated ciphertext, including
-- SQLite rows which were public metadata in the old encrypted snapshot.
-- The snapshot table above is retained as a rollback archive.
create table if not exists public.seller_roles (
  seller_id text primary key,
  profile_ciphertext jsonb not null,
  mandate_ciphertext jsonb not null,
  wrapped_state_key jsonb not null,
  source_revision bigint not null,
  source_hash text not null,
  imported_at timestamptz not null default now()
);
create table if not exists public.seller_records (
  seller_id text not null references public.seller_roles(seller_id),
  kind text not null,
  record_id text not null,
  plaintext_hash text not null,
  ciphertext jsonb not null,
  primary key (seller_id, kind, record_id)
);
create index if not exists seller_records_kind_idx on public.seller_records (seller_id, kind);
create table if not exists public.seller_artifacts (
  seller_id text not null references public.seller_roles(seller_id),
  artifact_key text not null,
  plaintext_hash text not null,
  ciphertext jsonb not null,
  primary key (seller_id, artifact_key)
);
create table if not exists public.seller_operation_intents (
  seller_id text not null references public.seller_roles(seller_id),
  operation_id text not null,
  action text not null,
  input_hash text not null,
  status text not null check (status in ('prepared','unresolved','confirmed')),
  evidence_hash text,
  updated_at timestamptz not null default now(),
  primary key (seller_id, operation_id)
);
create unique index if not exists seller_operation_evidence_idx on public.seller_operation_intents (evidence_hash) where evidence_hash is not null;
alter table public.seller_roles enable row level security;
alter table public.seller_records enable row level security;
alter table public.seller_artifacts enable row level security;
alter table public.seller_operation_intents enable row level security;
revoke all on public.seller_roles, public.seller_records, public.seller_artifacts, public.seller_operation_intents from anon, authenticated;
