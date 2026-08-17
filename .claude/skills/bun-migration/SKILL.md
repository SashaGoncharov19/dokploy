---
name: bun-migration
description: Migrate one workspace package in this monorepo from the Node/pnpm/tsx/esbuild toolchain to Bun. Use when converting apps/api, apps/schedules, apps/dokploy, or packages/server to Bun, when replacing tsx/esbuild/pnpm scripts with Bun equivalents, when rewriting a Dockerfile or CI workflow off Node, or when adopting native Bun APIs (Bun.serve, Bun.sql, Bun.password). Follows docs/bun-migration/PLAN.md.
---

# Migrating a package to Bun

Execute **one package, one phase, one PR**. The phase order in
[PLAN.md](../../../docs/bun-migration/PLAN.md) §14 is not advisory — Phase 4 will
fail in confusing ways if Phases 1–3 have not landed.

## Before you start

**Phase 0 must have passed.** `node-pty`, `ssh2`, and `dockerode` have to be verified
working under Bun before any package is converted. If
`docs/bun-migration/SPIKE-RESULTS.md` does not exist, run the Phase 0 spike first and
stop. Converting a package before that gate means potentially unwinding all of it.

Record the package's current numbers before changing anything — install time, build
time, `node_modules` size, boot time. "Faster and more compact" is the point of this
work, and an unmeasured migration cannot be shown to have achieved it.

## Per-package procedure

### 1. `package.json`

- `tsx foo.ts` → `bun foo.ts`. `tsx -r dotenv/config foo.ts` → `bun foo.ts` — Bun loads
  `.env` itself, drop the preload.
- `tsx watch` → `bun --watch`
- `rimraf dist && tsc -p tsconfig.json` → `rm -rf dist && bun build ./src/index.ts --target=bun --outdir=dist --minify --sourcemap --packages=external`
- **Keep `typecheck: tsc --noEmit`.** `bun build` does not typecheck. Deleting this
  removes the only type safety net.
- `node dist/index.js` → `bun dist/index.js`
- `engines` → `{ "bun": ">=1.3.14" }`

Note the output extension: esbuild was configured to emit `.mjs`, `bun build` emits
`.js`. Update `start` and the Dockerfile `CMD` **in the same commit** or the container
will not boot.

### 2. Drop dependencies the toolchain no longer needs

`tsx`, `esbuild`, `rimraf`, `dotenv`, `@hono/node-server`, `undici`. Grep for a live
import before each removal — `redis` and `ioredis` in particular look dead here but
must be confirmed against `bullmq`'s runtime needs.

### 3. Native deps → `trustedDependencies`

Any dependency with a postinstall (`node-pty`, `ssh2`, `bcrypt`, `better-sqlite3`,
`sharp`, `cpu-features`, `protobufjs`, `tree-sitter*`, `msgpackr-extract`,
`core-js-pure`, `@scarf/scarf`) must be listed in root `package.json`
`trustedDependencies`. Bun skips postinstall otherwise, and the failure surfaces at
runtime rather than at install — long after you have stopped looking.

### 4. Hono servers

```ts
// before
import { serve } from "@hono/node-server";
serve({ fetch: app.fetch, port });

// after
export default { port, fetch: app.fetch };
```

### 5. Native APIs, in this order

**`Bun.password`** — safest, verified compatible with existing `$2b$` hashes in both
directions (PLAN §2). Every hash call **must** pass `{ algorithm: "bcrypt", cost: 10 }`;
Bun's default is argon2id, which npm `bcrypt` cannot read and Traefik cannot parse.

**`Bun.sql`** — `drizzle-orm/postgres-js` → `drizzle-orm/bun-sql`, and the migrator
import alongside it. The `PostgresJsDatabase` type becomes `BunSQLDatabase`. Watch the
`max: 1` option in `migration.ts` and `reset.ts`. **Run the full migration chain against
a scratch database from empty before accepting this**, and snapshot any real database
first — a migration that runs under the new driver is not undone by reverting the driver.

**`Bun.file` / `Bun.write`** — last, and only on paths that are actually hot. Churning
100 call sites for an unmeasurable win is not worth the review burden.

**Not `Bun.$`.** See CLAUDE.md — `execAsync` handles pre-built command strings and SSH
dispatch, and `Bun.$` is a correctness regression there with no upside.

### 6. Verify

```bash
bun install
bun run --filter <pkg> typecheck
bun run --filter <pkg> build
bun dist/index.js          # boots?
```

Then the package's own smoke test — for `apps/dokploy` that means all six WebSocket
features by hand (terminal, container terminal, container logs, deployment logs,
drawer logs, docker stats), plus a login with a **pre-existing** account.

## Special cases

**`packages/server`** — becomes source-only. Delete `esbuild.config.ts`, the `build` /
`dev` / `esbuild` / `switch:dev` / `switch:prod` scripts, `scripts/switchToSrc.js`, and
`scripts/switchToDist.js`. Pin `exports` to `./src/*.ts` permanently and drop the
`require` → `dist/*.cjs.js` conditions. Remove `tsc-alias` and `esbuild-plugin-alias`.
Also remove `server:build` from CI and the root `server:script` script.

**`apps/dokploy`** — highest risk. Change the interpreter **only** first: run the
existing `node:http` server under `bun` and see what breaks. Do not rewrite to
`Bun.serve` in the same step. The WebSocket upgrade path is the most fragile part of
this migration and must be isolated from every other change. Rewriting the six WS
servers onto `Bun.serve`'s native handler is a fallback if `node:http` + `ws` proves
unreliable — not the plan.

**`apps/monitoring`** — Go. Not in scope. Leave it and its Dockerfile and workflow alone.

## Dockerfiles

`Dockerfile`, `Dockerfile.cloud`, `Dockerfile.server`, `Dockerfile.schedule` (not
`.monitoring`):

- `FROM node:24.4.0-slim` → `FROM oven/bun:1.3.14-slim`
- Delete `corepack enable` / `corepack prepare pnpm` / `PNPM_HOME` / the `PATH` export
- Cache mount: id `pnpm` → `bun`, target `/pnpm/store` → `/root/.bun/install/cache`
- Drop `pnpm install -g tsx`
- Keep the build-tools apt layer — `node-pty` and `ssh2` still compile from source
- Keep `tini`; it reaps HEALTHCHECK children and that need is unchanged

**`pnpm deploy --legacy` has no Bun equivalent.** It currently prunes to a production
`node_modules`. Either `bun install --production` into a fresh stage, or spike
`bun build --compile` to a single executable — the latter is the bigger win for image
size and is worth trying on `apps/api` / `apps/schedules` first, where the surface is small.

## CI

```yaml
- uses: oven-sh/setup-bun@v2
  with:
    bun-version: 1.3.14
- run: bun install --frozen-lockfile
- run: bun run --filter '*' ${{ matrix.job }}
```

Delete `pnpm/action-setup`, `actions/setup-node`, and the `pnpm server:build` step —
`packages/server` no longer builds.

## Report

State what you measured against the baseline (install time, build time, bundle and
`node_modules` size, boot time), what you verified by hand, and what you did **not**
verify. If a smoke test was skipped, say so plainly rather than implying full coverage.
