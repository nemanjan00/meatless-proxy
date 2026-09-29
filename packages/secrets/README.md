# @mp/secrets

The secrets port (L1): named secret variables, scoped resolution, redaction.

## API

- `SecretStore`: `set(name, value, scope, actor?)`, `delete` (idempotent), `list()` (metadata only, never values),
  `resolve(names, ctx)` (most specific scope wins: tool > project > employee > global; missing names left out).
- `SecretScope`, `SecretMeta`, `SecretContext`, `scopeKey(scope)`.
- `createRedactor(values, mask?)`: masks values (4+ characters, longest first) in strings and deeply in JSON.
- `memorySecretStore({ clock? })`: in-memory implementation.
- Helpers shared by implementations: `SECRET_NAME_RE`, `checkSecret`, `scopesFor(ctx)`, `compareMeta`.
- `@mp/secrets/contract`: `secretStoreContract(name, make)`, the vitest suite every implementation must pass.

## Tests

`test/secrets.test.ts` runs the contract against the memory store, plus scopes and the redactor.

## Replacing it

Implement `SecretStore` (see `@mp/secrets-store`), run `secretStoreContract` against it, switch the composition root.
