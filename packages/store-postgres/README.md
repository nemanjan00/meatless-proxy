# @mp/store-postgres

Postgres adapter (L2) for the storage port `@mp/store`: records, links and the
entry tree live in five tables of one schema, created by numbered SQL
migrations. Its behaviour follows the in-memory reference store
(`memoryStore`) and passes the shared contract suite.

## Public API

- `postgresStore(opts): Promise<PostgresStore>`: the `Store`. Options: `pool` or
  `connectionString`, `schema` (default `public`), `bus`, `clock`, `logger`,
  `migrate` (default `false`: the server runs migrations at startup). It fails
  with `UnavailableError` if the schema has no store tables, and logs a warning
  when migrations are pending. `close()` ends the pool only if the store created it.
- `runMigrations({ pool, schema?, logger?, dir? }): Promise<{ applied }>`:
  applies pending migrations, each in its own transaction, recorded in
  `schema_migrations(version, name, applied_at)`, under a per-schema advisory
  lock, so concurrent callers wait for each other.
- `pendingMigrations({ pool, schema?, dir? })`, `loadMigrations(dir?)`, `migrationsDir`.
- `createTestSchema(pool, prefix?)`: creates and migrates a uniquely named
  schema and returns `{ schema, drop }`, for other packages' tests.
- `mapPgError(e)`: maps driver errors to `@mp/core` errors (unique violation to
  `ConflictError`, and so on).

## Tables (`migrations/0001_init.sql`)

`records` (unique `(kind, key)`, GIN on `data`), `record_revisions`, `links`
(foreign keys to `records`, unique `(from_id, to_id, role)`), `blobs`
(content-addressed by `contentHash`), `entries` (parent foreign key, a `seq` for
creation order, GIN on `meta`). Table names are always schema-qualified, so one
pool can serve several schemas.

## Semantics

- Every write runs in its own transaction, or under a savepoint inside
  `transaction(fn)`, so a failed operation (for example a `ConflictError` the
  caller catches) doesn't abort the surrounding transaction. Operations on one
  transaction run one at a time. Bus notifications are published only after COMMIT.
- CAS is `UPDATE … WHERE version = $expected`. Row locks make racing updates
  safe: exactly one of N concurrent CAS updates wins.
- Conditions become SQL over `jsonb` paths (`data #> '{a,b}'`) and top-level
  fields. `contains` uses `@>` on an element, `like` uses `ILIKE`, and `text`
  is `data::text ILIKE`.

Known differences from the in-memory store:
- `gt`/`gte`/`lt`/`lte` compare only values of the same type (a number field
  against a number, a string against a string). JS coercion like `'30' > 25` isn't reproduced.
- `contains` with nested arrays inside the value matches by jsonb containment
  (a subset, in any order), not exact array equality.
- `text` search runs on Postgres' jsonb text form (`{"a": 1}`, with spaces), so
  a search that spans JSON punctuation can differ.
- Postgres can't store `\u0000` in jsonb. Such writes fail with `ValidationError`.
- Object key order in `data` isn't kept (jsonb normalises it).

## Tests

`test/contract.test.ts` runs `storeContract` from `@mp/store/contract`, with a
fresh schema for each test. `test/postgres.test.ts` covers migrations
(idempotent, concurrent, failing ones roll back), setup and pool ownership,
large and unusual JSON, revisions, concurrency and transactions, and a query
parity check against `memoryStore`. Both skip when `DATABASE_URL` isn't set.
`test/sql.test.ts` (the SQL builder and error mapping) always runs.

    DATABASE_URL=postgres://postgres@127.0.0.1:5432/meatless_proxy npx vitest run --project node packages/store-postgres

## Replacing it

To replace it, implement `Store` from `@mp/store` in a new L2 package and run
`storeContract` against it. Then switch the composition root in `@mp/server`.
