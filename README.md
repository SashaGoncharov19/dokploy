<div align="center">
  <a href="https://dokploy.com">
    <img src=".github/sponsors/logo.png" alt="Dokploy - Open Source Alternative to Vercel, Heroku and Netlify." width="100%"  />
  </a>
</div>
<br />

# dokploy-bun

A fork of [Dokploy](https://github.com/Dokploy/dokploy) that runs the whole stack on
[Bun](https://bun.sh) instead of Node.js + pnpm.

Dokploy is excellent software. This fork does not try to change what it does — it changes
what it runs on, measures the result, and writes down what breaks.

---

## Why this exists

Moving a self-hosted PaaS to a different runtime is a real risk to take on behalf of
everyone running it in production, and upstream is understandably cautious about it.
That caution deserves evidence rather than enthusiasm.

So this fork exists to answer one question honestly: **does Bun actually run this, and
what does it cost?** Including — especially — the parts where the answer is "no".

Everything below was measured or reproduced, with Node as a control where a comparison
was possible. Where something is untested, it says so.

---

## Status

The migration is [planned in nine phases](docs/bun-migration/PLAN.md). **Three are done.**

| Phase | What | Status |
|---|---|---|
| 0 | Native module spike (`node-pty`, `ssh2`, `dockerode`) | ✅ done |
| 1 | Package manager: pnpm → bun | ✅ done |
| 2 | TypeScript on Bun, no `packages/server` build | ✅ done |
| 3 | Bundler: esbuild → `bun build` (apps/dokploy) | ⬜ |
| 4 | **Runtime: Node → Bun** (custom server, 6 WebSocket servers) | ⬜ |
| 5 | Native APIs (`Bun.Terminal`, `Bun.password`, `Bun.sql`) | ⬜ |
| 6 | Dependency cleanup | ⬜ |
| 7 | Docker + CI | ⬜ |
| 9 | Tests: vitest → `bun test`, gradually | ⬜ |

> **The web app still executes on Node in production.** Phase 4 is where that changes.
> Nothing here is yet a claim about runtime performance.

---

## What has actually been proven

### Bun runs Dokploy's full test suite

**All 874 tests pass on Bun in CI** — deploys, traefik, SSH, docker, compose, backups,
permissions. This is the single most useful data point so far, and it is stronger than
any timing number.

### `next build` works on Bun

Next.js does not officially support Bun as a runtime, so this was the biggest expected
risk. It builds — 49.7s locally, green in CI.

### bcrypt hashes are compatible in both directions

Tested both ways: existing `$2b$` hashes from the database verify under `Bun.password`,
**and** Bun-written hashes verify under npm `bcrypt`. So moving to `Bun.password` needs
**no password migration and no forced reset**, and a rollback to Node does not strand
anyone.

One trap: Bun's default hash algorithm is argon2id, which npm `bcrypt` cannot read.
`{ algorithm: "bcrypt" }` is mandatory on every call — that one is a one-way door.

### `ssh2` and `dockerode` work unchanged

`ssh2` verified against a real sshd container — handshake, exec channel, stdout
streaming, interactive shell. `dockerode` verified against a live Docker socket — ping,
container listing, log streaming, stats. These carry every remote-server operation
Dokploy performs, and they needed no changes.

### `node-pty` does **not** work on Bun

The honest one. Under Bun the PTY child exits ~8ms after spawn and `resize()` throws
`EBADF`. Reproduced identically on macOS arm64 and inside `oven/bun:1.3.14-slim`, with
Node as a control passing the same test.

It is replaced by Bun's native `Bun.Terminal`, which passes the identical test on both
platforms — sustained multi-command session, a real tty inside the child, and `stty size`
correctly reflecting a mid-session resize. **Net effect: one fewer native dependency.**

Details and reproductions: [SPIKE-RESULTS.md](docs/bun-migration/SPIKE-RESULTS.md).

---

## Measurements

### Install and repository weight

| | pnpm | bun |
|---|---|---|
| `install --frozen-lockfile`, warm cache | 21.9s | **13.4s** first / **5.5s** after |
| Lockfile | 656 KB | **485 KB** |
| `node_modules` | 1.5G | **1.5G — no change** |

`bun install` migrated `pnpm-lock.yaml` to `bun.lock` by itself on first run.

### CI wall-times

Same runner, same code, toolchain swapped.

| Job | pnpm | bun (phase 2) |
|---|---|---|
| `build` | 3m51s | **2m39s** |
| `test` | 4m31s | 3m44s |
| `typecheck` | 1m25s | 1m6s |

⚠️ **These are single runs on shared CI runners.** Treat anything under ~15s as noise.
Only `build` moved far enough to be a real signal, and the cause is known rather than
guessed: phase 2 deleted the `packages/server` build step, so that is work *removed*, not
work sped up. `test` and `typecheck` improved, but not yet by enough to claim.

### Dependencies and code removed

Removed so far: `tsx` (×4), `rimraf` (×3), `esbuild` + `esbuild-plugin-alias`,
`tsc-alias`. Seven files and **18,678 lines** deleted, including `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, and two scripts described below.

More removals are queued for phase 6 — `dotenv`, `@hono/node-server`, `bcrypt`,
`postgres`, `undici`, and `node-pty`.

### The change that is not a number

`packages/server` shipped two scripts, `switchToSrc.js` and `switchToDist.js`, that
**rewrote the package's own `exports` field in place** — pointing at `src/*.ts` during
development and `dist/*.cjs.js` in production. They existed only because Node cannot
import TypeScript across a workspace boundary.

Bun resolves the source directly, so both scripts, the build step they served, and the
entire "works in dev, breaks in prod" failure mode are gone. That is worth more than the
seconds saved.

---

## What is not proven yet

Stated plainly, because a benchmark table that omits its gaps is not worth reading:

- **No runtime performance data.** The server still runs on Node until phase 4. Nothing
  here says anything about request latency, throughput, or memory.
- **No production evidence.** No instance has run under sustained real load.
- **No Docker image comparison.** Image size and cold-boot time come with phase 7.
- **`node_modules` did not shrink.** 1.5G before, 1.5G after.

## Known broken

- **Docker builds fail** on this branch. Phase 1 deleted `pnpm-lock.yaml` while the
  Dockerfiles still run `pnpm install --frozen-lockfile`. Fixed in phase 7. **No release
  can be cut from this line until then.**

---

## Trying it

Not yet packaged for installation. Until phase 7 lands, install upstream Dokploy
normally:

```bash
curl -sSL https://dokploy.com/install.sh | bash
```

To work on this fork:

```bash
git clone https://github.com/SashaGoncharov19/dokploy-bun.git
cd dokploy-bun
bun install
bun run --filter '*' typecheck
bun run test
```

Requires [Bun](https://bun.sh) 1.3.14+. Node.js and pnpm are no longer needed.

---

## Relationship to upstream

This fork tracks [Dokploy/dokploy](https://github.com/Dokploy/dokploy) and pulls its
updates in deliberately — see [FORK-STRATEGY.md](docs/FORK-STRATEGY.md).

It stays **structurally identical** to upstream on purpose. No repo-wide rename, no
reformatting, no restructuring: 590 files mention "dokploy", and renaming them would make
every future upstream merge conflict in every touched file, permanently. The migration is
built as small independent phases against upstream's own layout, so any of it can be
offered back.

Credit for Dokploy itself belongs to [its authors and
contributors](https://github.com/dokploy/dokploy/graphs/contributors). Licensing follows
upstream: [Apache-2.0](LICENSE.MD), except `/proprietary` directories under
[DSAL](LICENSE_PROPRIETARY.md).

---

## What Dokploy does

Unchanged by this fork — see [docs.dokploy.com](https://docs.dokploy.com).

Applications in any language · MySQL, PostgreSQL, MongoDB, MariaDB, libsql and Redis ·
automated backups · Docker Compose · multi-node Docker Swarm · one-click open-source
templates · Traefik routing · real-time CPU/memory/storage/network monitoring · CLI and
API · deployment notifications via Slack, Discord, Telegram and email · remote multi-server
deployment · fully self-hosted.

## Contributing

See the [Contributing Guide](CONTRIBUTING.md). Branch names follow
[docs/BRANCHING.md](docs/BRANCHING.md); working conventions are in [CLAUDE.md](CLAUDE.md).
