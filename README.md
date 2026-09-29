# meatless-proxy

A meat proxy, without the meat.

meatless-proxy is an AI harness.

A *meat proxy* is a person who just relays messages between their colleagues
and an AI. meatless-proxy fills that role without the person in the middle: an
AI employee that knows the company's people, projects, owners and procedures,
answers questions briefly and truthfully, and owns the tasks it's given.

- [docs/spec.md](docs/spec.md) is the harness spec.
- [docs/employee.md](docs/employee.md) defines the role: what it knows, how it
  interacts with people, and how it handles tasks.

## Development

Development runs natively, without Docker. Node, Postgres and Redis are
installed through [asdf](https://asdf-vm.com) and pinned in `.tool-versions`.

```sh
asdf plugin add postgres https://github.com/smashedtoatoms/asdf-postgres.git
asdf plugin add redis https://github.com/smashedtoatoms/asdf-redis.git
asdf install                      # builds Postgres and Redis from source

# one-time setup, data lives in .data/ (ignored by git)
initdb -D .data/postgres -U postgres --auth=trust -E UTF8
pg_ctl -D .data/postgres -l .data/postgres.log -o "-p 5432 -k /tmp" start
createdb -h 127.0.0.1 -U postgres meatless_proxy

# every session
pg_ctl -D .data/postgres -l .data/postgres.log -o "-p 5432 -k /tmp" start
redis-server --port 6379 --dir .data/redis --daemonize yes --logfile "$PWD/.data/redis.log"
```

Configuration is in `.env` (not committed): `OPENAI_BASE_URL`,
`OPENAI_API_KEY`, `MODEL`, `DATABASE_URL`
(`postgres://postgres@127.0.0.1:5432/meatless_proxy`) and `REDIS_URL`
(`redis://127.0.0.1:6379`).
