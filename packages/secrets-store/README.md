# @mp/secrets-store

Secrets adapter (L2): a `SecretStore` whose values are encrypted and stored as records through `@mp/store`.

## API

`storeSecretStore({ store, key, clock? })` returns a `SecretStore`. Also `deriveKey`, `SECRET_KIND`, `SecretRecord`,
`SecretDecryptError`.

- One record of kind `secret` per name and scope, keyed `<scopeKey>:<name>` (e.g. `project:prj_1:STAGING_DB_URL`).
- The value is encrypted with AES-256-GCM: a random 12-byte IV per write, the auth tag stored, and the scope and name as
  associated data (a ciphertext copied onto another secret's record won't decrypt).
- The 32-byte key is derived from the master `key` (16+ characters) with scrypt. A short public `keyId` is stored with
  each record, so a wrong master key fails with a clear `SecretDecryptError` ("encrypted with a different master key").
- `list()` reads metadata only and never decrypts. Record revisions only ever contain ciphertext.
- Key rotation isn't implemented yet (re-set every secret with the new key).

## Tests

`test/secrets-store.test.ts` runs the `@mp/secrets` contract on `memoryStore()`, and checks that stored data never
contains the plaintext, IVs are fresh, wrong keys and tampering are detected, and ciphertexts are bound to their record.

## Replacing it

Implement `SecretStore` on something else (Vault, a cloud secret manager), run the contract, switch the composition root.
