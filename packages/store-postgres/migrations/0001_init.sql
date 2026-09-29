-- Initial schema for @mp/store-postgres. Runs with search_path set to the target schema.

create table records (
  id text primary key,
  kind text not null,
  key text,
  version integer not null,
  data jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint records_kind_key_unique unique (kind, key)
);
create index records_kind_created_idx on records (kind, created_at, id);
create index records_data_gin_idx on records using gin (data jsonb_path_ops);

create table record_revisions (
  id bigserial primary key,
  record_id text not null,
  kind text not null,
  version integer not null,
  op text not null check (op in ('create', 'update', 'delete')),
  data jsonb,
  actor jsonb not null,
  at timestamptz not null
);
create index record_revisions_record_idx on record_revisions (record_id, id);

create table links (
  id text primary key,
  from_kind text not null,
  from_id text not null references records (id),
  to_kind text not null,
  to_id text not null references records (id),
  role text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null,
  constraint links_pair_unique unique (from_id, to_id, role)
);
create index links_to_idx on links (to_id, role);
create index links_from_kind_idx on links (from_kind, role);
create index links_to_kind_idx on links (to_kind, role);

create table blobs (
  hash text primary key,
  content jsonb not null
);

create table entries (
  seq bigserial not null unique,
  id text primary key,
  parent text references entries (id),
  kind text not null,
  hash text not null references blobs (hash),
  meta jsonb not null default '{}',
  created_at timestamptz not null
);
create index entries_parent_idx on entries (parent, seq);
create index entries_kind_idx on entries (kind);
create index entries_meta_gin_idx on entries using gin (meta jsonb_path_ops);
