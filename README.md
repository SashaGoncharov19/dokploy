<div align="center">
  <a href="https://dokploy.com">
    <img src=".github/sponsors/logo.png" alt="Dokploy" width="100%" />
  </a>
</div>

# Dokploy Bun

Self-hosted PaaS — deploy applications, databases and Docker Compose stacks on your own
servers, with Traefik routing, backups, monitoring and multi-server support.

This is [Dokploy](https://github.com/Dokploy/dokploy) running on [Bun](https://bun.sh)
instead of Node.js. Same product, same features, different runtime.

**Images:** `ghcr.io/sashagoncharov19/dokploy-bun` · `linux/amd64` + `linux/arm64`

---

## Install

On a server you intend to dedicate to it, as root:

```bash
curl -sSL https://raw.githubusercontent.com/SashaGoncharov19/dokploy-bun/canary/install.sh | sh
```

Then open `http://<your-server-ip>:3000`.

The installer sets up Docker, initialises Swarm, generates credentials into Docker
Secrets and starts Postgres, Traefik and the app. It detects Proxmox LXC and adjusts
service discovery accordingly.

**Updating**, keeping your data:

```bash
curl -sSL https://raw.githubusercontent.com/SashaGoncharov19/dokploy-bun/canary/install.sh | sh -s update
```

Re-running the *full* installer over an existing database is refused with instructions,
because it would regenerate credentials the database will not accept. To wipe and start
clean — **this destroys all data** — `export DOKPLOY_RESET_DB=true` first.

### Requirements

Any x86-64 or arm64 host with Docker. A Raspberry Pi 5 works; use an SSD rather than an
SD card, since deployments do a lot of disk I/O, and expect to want 8GB of RAM once
Postgres, Traefik and your own containers are running.

---

## Features

Everything upstream Dokploy does, and all of it available — this build ships no licence
gating, so white-labelling, SSO, SCIM, custom roles, audit logs and forward-auth are on
by default.

- **Applications** in any language — Node, PHP, Python, Go, Ruby, Rust
- **Databases** — PostgreSQL, MySQL, MariaDB, MongoDB, Redis, libsql, with scheduled backups
- **Docker Compose** stacks, deployed and managed natively
- **Multi-server** — deploy to remote hosts over SSH; **multi-node** via Docker Swarm
- **Templates** — one-click open-source apps (Plausible, Pocketbase, Cal.com, …)
- **Traefik** routing and TLS, configured for you
- **Monitoring** — live CPU, memory, storage and network per resource
- **Terminals and logs** in the browser, per container and per server
- **Notifications** — Slack, Discord, Telegram, email
- **CLI and API**, with a generated OpenAPI spec

Documentation for the product itself: [docs.dokploy.com](https://docs.dokploy.com).

---

## What running on Bun changes

Nothing about how you use it. The differences are in the build and the runtime:

| | Node + pnpm | Bun |
|---|---|---|
| Install (warm cache) | 21.9s | **5.5s** |
| CI build job | 3m51s | **2m39s** |
| api service image | 1.25GB | **234MB** |
| web image | 3.25GB | 3.22GB |

The service images collapse because `bun build` produces a self-contained bundle — they
ship no `node_modules` at all. The web image does not shrink, and that is worth saying
plainly: its bulk is the Docker CLI, nixpacks, railpack and buildpacks, which a runtime
swap cannot touch.

Removed along the way: `tsx`, `esbuild`, `rimraf`, `tsc-alias`, `node-pty`, `bcrypt`,
`postgres.js`, `@hono/node-server`, `redis`, `ioredis`. Two native modules became
built-in APIs — `node-pty` → `Bun.Terminal`, `bcrypt` → `Bun.password` — and existing
password hashes keep working in both directions, so upgrading and rolling back are both
safe.

There are no request-latency or throughput numbers here. Nothing has been measured under
sustained production traffic, and this README will not claim otherwise.

**The migration is documented in full**, including what broke and how:
[docs/bun-migration/](docs/bun-migration/PLAN.md).

---

## Status

Running and verified on arm64 hardware: all six WebSocket features (container terminal
and logs, server terminal, deployment console, monitoring, drawer logs), registration,
the migration chain, and a multi-service Compose deployment.

The full test suite — 874 tests — passes on Bun in CI.

Known gaps are listed honestly in
[SPIKE-RESULTS.md](docs/bun-migration/SPIKE-RESULTS.md); the notable one is that no
instance has yet run under sustained production load.

---

## Development

```bash
git clone https://github.com/SashaGoncharov19/dokploy-bun.git
cd dokploy-bun
bun install
bun run --filter '*' typecheck
bun run test
```

Requires [Bun](https://bun.sh) 1.3.14+. Node.js and pnpm are not needed.

Conventions live in [CLAUDE.md](CLAUDE.md), branch naming in
[docs/BRANCHING.md](docs/BRANCHING.md), and the rules for staying mergeable with upstream
in [docs/FORK-STRATEGY.md](docs/FORK-STRATEGY.md).

### Versioning

`v0.30.0-bun.1` means upstream's v0.30.0 running on Bun. The suffix appears in the UI,
the startup log and the image tags.

---

## Credits

Dokploy is built by [Mauricio Siu](https://github.com/Siumauricio) and
[its contributors](https://github.com/dokploy/dokploy/graphs/contributors). This fork
changes the runtime; the software is theirs.

It tracks upstream and merges their releases — see
[FORK-STRATEGY.md](docs/FORK-STRATEGY.md) — and deliberately stays structurally identical
to it, so improvements can flow in both directions.

## License

Follows upstream: [Apache-2.0](LICENSE.MD), except `/proprietary` directories, which are
under the [DSAL](LICENSE_PROPRIETARY.md).

## Contributing

See the [Contributing Guide](CONTRIBUTING.md).
