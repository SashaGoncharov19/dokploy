# Dokploy → Bun Migration Plan

**Target runtime:** Bun 1.3.14+ (currently installed: 1.3.14)
**Replaces:** Node.js 24.4.0 + pnpm 10.22.0 + tsx + esbuild
**Branching:** one phase, one branch, one PR — see [../BRANCHING.md](../BRANCHING.md)

---

## 1. Scope and decisions

Four decisions were made up front and drive everything below.

| # | Decision | Choice |
|---|----------|--------|
| 1 | License removal scope | **All enterprise features** — remove licensing entirely, not just white-label |
| 2 | Next.js runtime | **Everything on Bun**, including `next build` and the custom server |
| 3 | Native API depth | **Maximum native Bun** — `Bun.serve`, `Bun.sql`, `Bun.password`, `Bun.file` |
| 4 | Test runner | **Gradual** — vitest keeps running under Bun, port to `bun test` directory by directory |

### In scope

| Package | Language | Current toolchain | Target |
|---------|----------|-------------------|--------|
| `packages/server` | TypeScript | tsc + esbuild + tsc-alias | Bun (source-resolved, no build) |
| `apps/dokploy` | TypeScript, Next 16 pages router | esbuild + `next build --webpack` | `bun build` + `next build` on Bun |
| `apps/api` | TypeScript, Hono | tsx + tsc | `Bun.serve` via `hono/bun` |
| `apps/schedules` | TypeScript, Hono + BullMQ | tsx + tsc | `Bun.serve` via `hono/bun` |

### Out of scope

- **`apps/monitoring`** — a Go service (`go.mod`, `main.go`). Untouched. Its `Dockerfile.monitoring` and `.github/workflows/monitoring.yml` stay as they are.
- **Database schema** — no schema changes required by the Bun migration itself. The de-licensing track has one optional backfill (§8.3).

### Codebase size (from the code graph)

1183 files parsed · 5723 nodes · 70934 edges · 483 flows · 18 communities.
96 vitest test files, 58 of which use `vi.mock`. 5 Dockerfiles. 9 CI workflows.

---

## 2. Verified facts

These were tested against real Bun 1.3.14 on this machine, not assumed. They are the load-bearing assumptions of the plan.

### ✅ `drizzle-orm/bun-sql` ships in the pinned version

`drizzle-orm@0.45.2` was installed and inspected: the `bun-sql` (and `bun-sqlite`) driver entrypoints are present. **No drizzle upgrade is needed** to move onto `Bun.sql`.

### ✅ bcrypt hashes are bidirectionally compatible with `Bun.password`

This is the single riskiest item in the "max native" path — getting it wrong locks every user out of their account. It was tested both directions:

```
npm bcrypt hash prefix:       $2b$10$
Bun.password.verify(npm hash): true    ← existing DB hashes verify under Bun
bcrypt.compare(bun hash):      true    ← Bun-written hashes verify under npm bcrypt
wrong password vs npm hash:    false   ← negative case behaves
```

**Consequences:**
- **No password migration or forced reset is needed.** Every existing `$2b$` hash in the `user` table keeps working.
- **The change is reversible.** Because npm `bcrypt` reads Bun-written hashes, a rollback to Node does not strand users who changed their password post-migration.
- `Bun.password.hash(pw, { algorithm: "bcrypt", cost: 10 })` must be used explicitly. Bun's **default algorithm is argon2id** (`$argon2id$`), which npm `bcrypt` cannot read — defaulting here would be a one-way door.

### ⚠️ `redis` and `ioredis` look like dead dependencies

`apps/dokploy/server/queues/in-memory-queue.ts` states it "replaces BullMQ/Redis for deployments". A grep for `ioredis` / `redis` client imports across `apps/*/src` and `apps/dokploy/server` found **no live import** — the only hit is a code comment in `apps/api/src/index.ts:104`.

`redis@4.7.0` (apps/api) and `ioredis@5.4.1` (apps/schedules) are therefore **candidates for deletion, not migration to `Bun.redis`**. Confirm `bullmq` does not pull `ioredis` in at runtime in `apps/schedules` before removing (§7).

---

## 3. Risk register

Ordered by expected pain. Each has an owner phase and a stated abort condition.

| Risk | Impact | Phase | Abort condition |
|------|--------|-------|-----------------|
| **Next.js 16 on Bun** — Next does not officially support Bun as a runtime | Web app fails to build or serve | 5 | `next build` fails or SSR errors that do not reproduce under Node |
| ~~**`node-pty` under Bun**~~ — **RESOLVED**, see SPIKE-RESULTS | — | 5 | Replaced by native `Bun.Terminal`; node-pty is removed, not fixed |
| ~~**`ssh2` under Bun**~~ — **CLEARED**, passes fully | — | — | Verified against a real sshd: handshake, exec, stream, shell channel |
| **License removal changes permission semantics** | Members silently lose or gain access to servers | 8 | See §8.3 — this is a behavioral change, not a no-op |
| **`vi.mock` → `mock.module` semantics differ** | Tests pass while asserting nothing | 9 | Deliberately break source, confirm the test fails |
| **`bun install` resolves a different tree than pnpm** | Subtle version drift across 1000+ transitive deps | 1 | Diff the resolved trees before trusting the lockfile |

### Native module gate — ✅ RESOLVED, see [SPIKE-RESULTS.md](SPIKE-RESULTS.md)

`node-pty`, `ssh2`, and `bcrypt` were the load-bearing native dependencies. All are now cleared: **`ssh2`** and **`dockerode`** pass fully under Bun (verified against a real sshd container and the Docker socket); **`bcrypt`** is replaced by `Bun.password`, hash-compatible in both directions (§2); **`node-pty`** does *not* work under Bun (PTY dies ~8ms after spawn, `resize()` throws `EBADF`, on macOS *and* Linux) and is **replaced by the native `Bun.Terminal` API**, which passes the identical test on both platforms — see §9.0. Decision #2 ("everything on Bun, including Next.js") therefore stands, and the migration *removes* a native dependency rather than working around it.

Usage sites:
- `node-pty` — `apps/dokploy/server/wss/docker-container-terminal.ts`, `docker-container-logs.ts`
- `ssh2` — `apps/dokploy/server/wss/{terminal,listen-deployment,docker-container-terminal,docker-container-logs}.ts`, `packages/server/src/setup/{server-validate,server-setup,server-audit}.ts`, `packages/server/src/utils/{builders/drop,filesystem/ssh,process/execAsync}.ts`

---

## 4. Phase 0 — Spike the native modules (blocking gate) — ✅ DONE

Completed 2026-08-17. Full results and evidence: [SPIKE-RESULTS.md](SPIKE-RESULTS.md).

| Module | Result |
|---|---|
| `ssh2` | ✅ pass — handshake, exec, stdout stream, interactive shell channel |
| `dockerode` | ✅ pass — ping, listContainers, log stream, stats |
| `Bun.Terminal` | ✅ pass on macOS **and** Linux — replaces node-pty |
| `node-pty` | ❌ fails under Bun — **removed**, see §9.0 |

**Gate outcome: PASSED.** Proceed to Phase 1. The one new work item this creates is the
`node-pty` → `Bun.Terminal` port (§9.0).

Also capture a **baseline** to measure against, since "faster, better, more compact" is the goal and it needs numbers:

```bash
# record before any change
pnpm install --frozen-lockfile   # wall time, node_modules size (du -sh)
pnpm server:build                # wall time
pnpm --filter=dokploy run build  # wall time
pnpm test                        # wall time
docker build -f Dockerfile .     # wall time, final image size
```

Write these into `SPIKE-RESULTS.md`. Every later phase reports its delta against this baseline.

---

## 5. Phase 1 — Package manager: pnpm → bun

### 1.1 Workspace definition

`pnpm-workspace.yaml` is currently authoritative. Root `package.json` already has a matching `workspaces` array, so:

- **Delete** `pnpm-workspace.yaml`.
- Keep `workspaces: ["apps/*", "packages/*"]` in root `package.json`. Note this is broader than the pnpm list — it will now also pick up `apps/monitoring`, which has no `package.json` and is therefore harmlessly ignored by Bun.

### 1.2 Translate pnpm-specific config

Root `package.json` currently carries four pnpm-only blocks. Map them:

| pnpm field | Bun equivalent | Notes |
|---|---|---|
| `pnpm.overrides` (`esbuild`, `better-call`, `@better-fetch/fetch`) | `overrides` | Bun reads top-level `overrides`. The `esbuild@0.20.2` pin becomes removable once Phase 3 lands. |
| `resolutions` (`@types/react`, `@types/react-dom`) | `overrides` | Bun treats `resolutions` as a Yarn alias; consolidate on `overrides` to avoid two sources of truth. |
| `pnpm.onlyBuiltDependencies` (14 packages) | `trustedDependencies` | **Required** — Bun does not run postinstall scripts unless the package is listed. Missing an entry here is how `bcrypt`/`node-pty`/`better-sqlite3` end up unbuilt and failing at runtime. |
| `pnpm.peerDependencyRules.ignoreMissing` | *(no equivalent)* | Bun does not fail on missing peers; drop it. |

`trustedDependencies` must carry over all 14: `@scarf/scarf`, `@tree-sitter-grammars/tree-sitter-yaml`, `bcrypt`, `better-sqlite3`, `core-js-pure`, `cpu-features`, `esbuild`, `msgpackr-extract`, `node-pty`, `protobufjs`, `sharp`, `ssh2`, `tree-sitter`, `tree-sitter-json`.

### 1.3 Engines

```json
"engines": { "bun": ">=1.3.14" }
```

Drop `node` and `pnpm`. Delete `.nvmrc`, add `.bun-version` containing `1.3.14`.

### ⚠️ 1.3b `@codemirror/view` must be pinned — found the hard way

`bun install` and `pnpm install` **do not resolve this monorepo identically**, and the
difference breaks the typecheck.

`apps/dokploy` declares `@codemirror/view: ^6.39.15`. `@codemirror/autocomplete@6.20.3`
declares an exact `@codemirror/view: 6.43.6`. pnpm deduped the app down to **6.43.6**;
bun resolves the app to the newest match, **6.43.8**, and leaves autocomplete on 6.43.6.
Two copies of `EditorView` then have "separate declarations of a private property", and
`components/shared/env-autocomplete.ts` fails to compile with ~20 errors.

Verified by running `tsc --noEmit` under both layouts: **pnpm exit 0, bun exit 1**.

Fix — add to `overrides`, matching what pnpm resolved so behavior is preserved:

```json
"@codemirror/view": "6.43.6"
```

After that, a full tree comparison across the 929 packages present in both lockfiles
found **0 version differences** and **0 packages that were single-version under pnpm but
multi-version under bun**. Re-run that comparison if the lockfile is ever regenerated
from scratch.

### 1.4 Install and diff the tree

```bash
bun install
```

**Do not trust the new lockfile on sight.** Diff the resolved dependency tree against pnpm's before deleting `pnpm-lock.yaml`:

```bash
# capture both, compare resolved versions for every package
bun pm ls --all > /tmp/bun-tree.txt
```

Pay attention to anything with a native postinstall and to the `esbuild`/`better-call`/`@better-fetch/fetch` pins. Once the tree is confirmed equivalent, delete `pnpm-lock.yaml` and commit `bun.lock`.

### 1.5 Root scripts

Rewrite all `pnpm --filter=X run Y` as `bun run --filter X Y`. `pnpm -r run Y` becomes `bun run --filter '*' Y`.

**Exit criteria:** `bun install` from clean produces a working `node_modules`; `bun run --filter '*' typecheck` passes; `node_modules` size recorded vs baseline.

---

## 6. Phase 2 — Script runner: tsx → bun, and delete the export-swap hack

### 2.1 Replace tsx (14 script references)

Bun executes TypeScript natively. Every `tsx foo.ts` becomes `bun foo.ts`, and every `tsx -r dotenv/config foo.ts` becomes just `bun foo.ts` — **Bun auto-loads `.env`**, so the `dotenv/config` preload is redundant.

Affected scripts in `apps/dokploy/package.json`: `setup`, `dev`, `migration:run`, `manual-migration:run`, `db:truncate`, `db:seed`, `db:clean`, `wait-for-postgres-dev`, `generate:openapi`, `build-server`. Plus `dev` in `apps/api` and `apps/schedules` (`tsx watch` → `bun --watch`).

Remove `tsx` from every `devDependencies`. Also remove the global `pnpm install -g tsx` from `Dockerfile:58`.

### 2.2 Delete the switchToSrc/switchToDist hack — a real simplification

`packages/server` currently ships a pair of scripts (`scripts/switchToSrc.js`, `scripts/switchToDist.js`) that **rewrite `package.json` `main`/`exports` in place** to point at `./src/*.ts` for development and `./dist/*.cjs.js` for production. This exists only because Node cannot import TypeScript from a workspace dependency.

Bun resolves TypeScript source directly across workspace boundaries. Therefore:

- **Delete** `packages/server/scripts/switchToSrc.js` and `switchToDist.js`.
- **Delete** the `switch:dev` / `switch:prod` scripts, and the root `server:script` script that calls them.
- **Pin** `packages/server/package.json` permanently to source:
  ```json
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./db": "./src/db/index.ts",
    "./setup/*": "./src/setup/*.ts",
    "./constants": "./src/constants/index.ts"
  }
  ```
  The `require` → `dist/*.cjs.js` conditions go away entirely.
- **Delete** `packages/server`'s `build`, `dev`, and `esbuild` scripts and its `esbuild.config.ts`. `packages/server` becomes a source-only package with no build step at all.

This removes a build step, a mutable-`package.json` footgun, and a class of "works in dev, breaks in prod" bugs. It also removes `tsc-alias` and `esbuild-plugin-alias` from the dependency tree.

**Exit criteria:** `bun run --filter '*' typecheck` passes with `packages/server` resolved from source; no script mutates `package.json`.

---

## 7. Phase 3 — Bundler: esbuild/tsc → bun build

### 3.1 `apps/dokploy` server bundle

`apps/dokploy/esbuild.config.ts` bundles 6 entrypoints (`server`, `migration`, `wait-for-postgres`, `reset-password`, `reset-2fa`, `migrate-auth-secret`) to `dist/*.mjs`, ESM, minified, `packages: "external"`, with `.env.production` values inlined via `define`.

Replace with `bun build`:

```bash
bun build ./server/server.ts ./migration.ts ./wait-for-postgres.ts \
  ./reset-password.ts ./reset-2fa.ts ./scripts/migrate-auth-secret.ts \
  --target=bun --outdir=dist --minify --sourcemap --packages=external
```

Two behavioral notes:
- Output extension becomes `.js`, not `.mjs`. Update `apps/dokploy/package.json` `start` and the Dockerfile `CMD` together, or the container will fail to boot.
- The `define` block inlining `.env.production` (minus `DATABASE_URL`) can be **dropped entirely** — Bun reads `.env` at runtime, which is what the `DATABASE_URL` exception was already working around. Verify no build-time-only env var is relied upon before removing.

### 3.2 `apps/api` and `apps/schedules`

Both use `rimraf dist && tsc --project tsconfig.json`. Replace with:

```bash
rm -rf dist && bun build ./src/index.ts --target=bun --outdir=dist --minify --sourcemap --packages=external
```

Drop `rimraf` from both. Keep a `typecheck` script on `tsc --noEmit` — **`bun build` does not typecheck**, so the type safety net must stay explicit in CI.

### 3.3 Keep tsc for one thing

`packages/server` no longer builds, but `tsc --noEmit` remains the only typechecker. Note the repo pins `typescript@^7.0.2` — the Go-based compiler — which is itself a large typecheck speedup independent of Bun.

**Exit criteria:** all three bundles build; `bun dist/server.js` boots; build wall-times recorded vs baseline.

---

## 8. Phase 4 — Runtime: node → bun

### 4.1 Hono servers → `Bun.serve`

`apps/api/src/index.ts:1` and `apps/schedules/src/index.ts:1` both `import { serve } from "@hono/node-server"`. Hono has first-class Bun support:

```ts
// before
import { serve } from "@hono/node-server";
serve({ fetch: app.fetch, port });

// after — Bun.serve is the default export contract
export default { port, fetch: app.fetch };
```

Remove `@hono/node-server` from both packages. This is a straight win: fewer deps, native HTTP.

### 4.2 Next.js custom server

`apps/dokploy/server/server.ts` builds a `node:http` server, hands requests to Next's `getRequestHandler()`, and attaches **six** WebSocket servers to it (drawer-logs, deployment-logs, container-logs, container-terminal, terminal, docker-stats).

Bun implements `node:http`, so the first move is **change nothing but the interpreter** — run the existing file under `bun` and see what breaks. Do not rewrite to `Bun.serve` in the same step; the WebSocket upgrade path is the most fragile part of this migration and it must be isolated from other changes.

Only if `node:http` + `ws` proves unreliable under Bun, migrate the six WS servers to `Bun.serve`'s native `websocket` handler — that is a substantially larger change with its own risk, and it is a fallback, not the plan.

### 4.3 Process entrypoints

Everywhere `node -r dotenv/config dist/X.mjs` appears (package.json `start`, all Dockerfile `CMD`s), it becomes `bun dist/X.js`. The `-r dotenv/config` preload disappears.

**Exit criteria:** `bun run dev` serves the app; all six WebSocket features verified by hand (terminal, container terminal, container logs, deployment logs, drawer logs, docker stats); `bun dist/server.js` boots in production mode.

---

## 9. Phase 5 — Native Bun APIs

Ordered from safest to most invasive. Each is independently revertible.

### 5.0 `Bun.Terminal` replaces `node-pty` — required, not optional

Unlike the rest of this phase, this one is mandatory: `node-pty` does not function under
Bun (SPIKE-RESULTS). Two files in `apps/dokploy` import it —
`server/wss/docker-container-terminal.ts` (including `ptyProcess.resize()` at line 199)
and `server/wss/docker-container-logs.ts`.

```ts
const proc = Bun.spawn({
  cmd: [file, ...args],
  cwd, env,
  terminal: {
    cols, rows, name: "xterm-color",
    data(terminal, chunk) { /* was p.onData */ },
    exit(terminal, code, signal) { /* was p.onExit */ },
  },
});
proc.terminal.write(input);       // was p.write
proc.terminal.resize(cols, rows); // was p.resize
```

**The callbacks take the `Terminal` instance as their first argument** — `data(terminal,
chunk)`, not `data(chunk)`. Getting this wrong fails confusingly: the chunk silently
becomes the Terminal object rather than throwing at the call site.

Verify with the same checks the spike used: a sustained multi-command session, `test -t 0`
inside the child returning true, and `stty size` reflecting a mid-session resize. Then drop
`node-pty` from `apps/dokploy` dependencies and from root `trustedDependencies`.

### 5.1 `Bun.password` replaces `bcrypt` — verified safe (§2)

Six call sites:

| File | Line | Current | Replacement |
|---|---|---|---|
| `packages/server/src/lib/auth.ts` | 151 | `bcrypt.hashSync(password, 10)` | `Bun.password.hashSync(password, { algorithm: "bcrypt", cost: 10 })` |
| `packages/server/src/lib/auth.ts` | 154 | `bcrypt.compareSync(password, hash)` | `Bun.password.verifySync(password, hash)` |
| `packages/server/src/services/user.ts` | 468 | `bcrypt.hashSync(password, 10)` | same as above |
| `packages/server/src/auth/random-password.ts` | 18 | `bcrypt.hash(randomPassword, saltRounds)` | `Bun.password.hash(pw, { algorithm: "bcrypt", cost: saltRounds })` |
| `packages/server/src/utils/traefik/security.ts` | 37 | `bcrypt.hash(data.password, 10)` | same — **must stay bcrypt**, this writes an htpasswd file Traefik parses |
| `apps/dokploy/server/api/routers/user.ts` | 237, 258 | `compareSync` / `hashSync` | as above |

**The `algorithm: "bcrypt"` option is mandatory on every hash call.** Bun defaults to argon2id; a hash written as argon2id into the Traefik htpasswd file silently breaks basic auth, and one written to the `user` table cannot be read by a rolled-back Node deployment.

Then remove `bcrypt` and `@types/bcrypt` from both packages, and drop `bcrypt` from `trustedDependencies`.

### 5.2 `Bun.sql` replaces `postgres.js`

Five connection sites: `packages/server/src/db/index.ts:20`, `apps/dokploy/server/db/index.ts:22,28`, `apps/dokploy/migration.ts:6`, `apps/dokploy/server/db/reset.ts:7`.

```ts
// before
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
drizzle(postgres(dbUrl), { schema });

// after
import { drizzle } from "drizzle-orm/bun-sql";
drizzle(dbUrl, { schema });
```

The migrator import changes too: `drizzle-orm/postgres-js/migrator` → `drizzle-orm/bun-sql/migrator`.

**Do this one behind its own verification.** Connection pooling, prepared statements, and error shapes differ between postgres.js and `Bun.sql`. Specific things to check: the `max: 1` option used in `migration.ts` and `reset.ts` (single-connection migration safety), transaction semantics in the migrator, and the `PostgresJsDatabase` type export which is referenced in two files and must become `BunSQLDatabase`.

Run the **full migration chain against a scratch database** — all 180+ drizzle migrations from empty — before accepting this change. Then drop `postgres` from both packages.

### 5.3 `Bun.file` for filesystem reads

`packages/server` does substantial filesystem work (traefik config, compose files, SSH keys). `Bun.file(path).text()` / `.json()` is faster than `fs.readFile`, and `Bun.write()` replaces `fs.writeFile`. This is a mechanical, low-risk sweep — but it is also the **lowest-value** item here. Do it last, or skip it, and only where a file is genuinely on a hot path. Churning 100 call sites for no measurable win is not a good trade.

### 5.4 `Bun.$` — recommended **against**

The "max native" option nominally includes replacing `execAsync` with `Bun.$`. **I recommend not doing this**, and the plan omits it from the exit criteria.

`packages/server/src/utils/process/execAsync.ts` promisifies `child_process.exec` over **command strings that are assembled elsewhere** — docker CLI invocations, traefik commands, remote shell lines. `Bun.$` is a tagged template that applies its own escaping to interpolated values; feeding it pre-built strings requires `$\`sh -c ${cmd}\`` or `.raw`, which reintroduces exactly the shell-injection surface the template syntax exists to prevent. The same file also dispatches to `ssh2` for remote execution, which `Bun.$` cannot cover at all.

The upside is nil — Bun implements `node:child_process` natively, so `exec` is already running on Bun's own process spawning. **Keep `execAsync` as it is.** If a specific hot path is ever measured to be spawn-bound, revisit it in isolation.

**Exit criteria:** login works with a pre-existing account (proves 5.1); a fresh DB migrates from empty and an existing DB starts clean (proves 5.2).

---

## 10. Phase 6 — Dependency cleanup

Removals enabled by earlier phases. Each needs a grep to confirm no live import before deletion.

| Package | Reason | Enabled by |
|---|---|---|
| `tsx` (3 packages) | Bun runs TS natively | Phase 2 |
| `esbuild` + `esbuild-plugin-alias` | replaced by `bun build` | Phase 3 |
| `tsc-alias` | no build step in `packages/server` | Phase 2 |
| `rimraf` (3 packages) | `rm -rf` | Phase 3 |
| `dotenv` (7 files) | Bun auto-loads `.env` | Phase 2 |
| `@hono/node-server` (2 packages) | `Bun.serve` | Phase 4 |
| `bcrypt`, `@types/bcrypt` | `Bun.password` | Phase 5.1 |
| `postgres` | `Bun.sql` | Phase 5.2 |
| `undici` | Bun has native `fetch` | — |
| `redis` (apps/api) | **appears dead** — verify first (§2) | — |
| `ioredis` (apps/schedules) | **appears dead** — check `bullmq` runtime need first | — |

Also drop the root `esbuild: "0.20.2"` override once nothing depends on esbuild.

**Exit criteria:** `node_modules` size and install time recorded vs baseline. This phase is where the "compact" goal is actually paid out.

---

## 11. Phase 7 — Docker and CI

### 7.1 Dockerfiles

Four of the five need rewriting (`Dockerfile.monitoring` is Go — leave it).

Common changes for `Dockerfile`, `Dockerfile.cloud`, `Dockerfile.server`, `Dockerfile.schedule`:

- `FROM node:24.4.0-slim` → `FROM oven/bun:1.3.14-slim`
- Delete the `corepack enable` / `corepack prepare pnpm` lines and `PNPM_HOME`/`PATH`
- `pnpm install --frozen-lockfile` → `bun install --frozen-lockfile`; cache mount id `pnpm` → `bun`, target `/pnpm/store` → `/root/.bun/install/cache`
- `pnpm --filter=X build` → `bun run --filter X build`
- **`pnpm deploy --legacy /prod/X` has no Bun equivalent.** This is the one genuinely non-mechanical step: it currently produces a pruned production `node_modules`. Options: (a) `bun install --production` into a fresh stage, or (b) `bun build --compile` to a single executable, which would make the runtime stage dramatically smaller. (b) is the more interesting option for the "compact" goal and is worth spiking for `apps/api` and `apps/schedules` first, where the surface is small.
- `CMD ["pnpm", "start"]` → `CMD ["bun", "dist/index.js"]`
- Main `Dockerfile` CMD: `node -r dotenv/config dist/*.mjs` → `bun dist/*.js`, and drop `pnpm install -g tsx` (line 58)
- The build-tools apt layer (`python3 make g++ pkg-config libsecret-1-dev`) is still needed while `node-pty`/`ssh2` compile from source

`tini` stays — it reaps the HEALTHCHECK children, and that need is unchanged by the runtime swap.

### 7.2 CI (9 workflows)

In `.github/workflows/pull-request.yml` and every other workflow touching Node:

```yaml
# replace pnpm/action-setup@v5 + actions/setup-node@v5
- uses: oven-sh/setup-bun@v2
  with:
    bun-version: 1.3.14
- run: bun install --frozen-lockfile
- run: bun run --filter '*' ${{ matrix.job }}
```

`pnpm server:build` disappears from CI entirely — `packages/server` has no build step after Phase 2.

`dokploy.yml` uses `node -p "require('./apps/dokploy/package.json').version"` to read the version; `bun -p` works identically, or use `jq`.

**Exit criteria:** green CI on all three matrix jobs; image sizes recorded vs baseline.

---

## 12. Phase 8 — Remove enterprise licensing

This runs **independently of the Bun track** and can be done in parallel or first. See `.claude/skills/remove-enterprise-license/SKILL.md` for the step-by-step procedure.

### 8.1 The surface

`hasValidLicense(organizationId)` — `packages/server/src/services/proprietary/license-key.ts:10` — has **14 call sites**. `enterpriseProcedure` — `apps/dokploy/server/api/trpc.ts:216` — gates the sso, scim, custom-role, forward-auth, settings, and whitelabeling routers.

Backing state is two `user` columns: `enableEnterpriseFeatures` and `isValidEnterpriseLicense`.

Remote calls to `https://licenses-api.dokploy.com` live in `apps/dokploy/server/utils/enterprise.ts` (validate/activate/deactivate) and `packages/server/src/utils/crons/enterprise.ts` (a cron every 3 days that flips `isValidEnterpriseLicense` to false on failure). Both get deleted — **note that the existing cron will actively disable enterprise features if the license server is unreachable**, so leaving it in place while removing the gates would be self-defeating.

### 8.2 Approach

Rather than editing 14 call sites plus every consumer, **collapse the predicate**: make `hasValidLicense` return `true` unconditionally, verify the whole app against that, and only then delete the now-dead branches, the license-key router, the license UI, the cron, and finally the two DB columns. Removing the gate and removing the code are two separate commits — the first is trivially revertible, the second is not.

### 8.3 ⚠️ This is not a no-op — it changes permission semantics

**Flagging this prominently because it can silently break a running instance.** Three of the 14 call sites use the license flag to choose between *different access-control behaviors*, not merely to show or hide a feature:

**`getAccessibleServerIds` (`packages/server/src/services/server.ts:183`) — unlicensed is the _permissive_ branch:**
```ts
const licensed = await hasValidLicense(activeOrganizationId);
if (!licensed) {
  return new Set(allOrgServers.map((s) => s.serverId));  // ← sees EVERY server
}
return new Set(memberRecord?.accessedServers ?? []);      // ← sees only assigned
```
Forcing `licensed = true` **restricts** non-admin members to their `accessedServers` list. On an instance that has been running unlicensed, that column is likely empty for everyone — so **every non-admin member would abruptly see zero servers.**

**Recommended mitigation:** ship a one-time backfill that sets `accessedServers` to all current org servers for every existing member, then enable the licensed branch. This preserves today's effective access exactly while turning the feature on. Without the backfill, this is a production outage for member-role users.

**`resolveRole` (`packages/server/src/services/permission.ts:47`)** — unlicensed returns `null` for any non-static role, so custom roles are inert. Forcing `true` makes every stored custom role take effect at once. Audit the `organizationRole` table before enabling: a stale or half-configured custom role that was never active becomes live.

**`getAccessibleGitProviderIds` (`packages/server/src/services/git-provider.ts:105`)** — here licensed is the *more permissive* branch (it adds assigned providers on top of owned + shared), so this one only widens access. Lower risk, but still a change.

The remaining 11 call sites are ordinary feature gates and are safe to force true.

**Exit criteria:** a member-role user sees the same servers before and after; custom roles behave as intended; no outbound request to `licenses-api.dokploy.com` remains.

---

## 13. Phase 9 — Tests (gradual)

Per decision #4, vitest stays and runs under Bun. `bun run test` invokes the existing vitest config unchanged.

Port directory by directory (`__test__/permissions`, `__test__/traefik`, …), smallest first. The mapping:

| vitest | bun:test |
|---|---|
| `vi.fn` (129) | `jest.fn` / `mock` |
| `vi.mock` (58) | `mock.module` — **semantics differ, see below** |
| `vi.mocked` (36) | type-level, usually deletable |
| `vi.hoisted` (16) | no equivalent; restructure — `mock.module` is not hoisted |
| `vi.clearAllMocks` (14) | `jest.clearAllMocks` |
| `vi.stubEnv` / `unstubAllEnvs` | assign `process.env` directly |

**The `vi.mock` → `mock.module` gap is the whole cost of this phase.** `vi.mock` is hoisted above imports; `mock.module` is not, so a module already imported at the top of the file will not be replaced. Ported files need their import order restructured, and a mock that silently fails to apply produces a **passing test that asserts nothing**.

Guard against that: for each ported file, deliberately break the source it covers and confirm the test actually fails. A port is not done until it has failed on purpose once.

Keep both runners green in CI during the transition — `bun test` over the ported directories, vitest over the rest.

---

## 14. Execution order

```
Phase 0  Spike node-pty / ssh2 / dockerode + capture baseline   ← BLOCKING GATE
   │
   ├─ Phase 8  De-licensing (independent track, can start immediately)
   │
Phase 1  pnpm → bun
Phase 2  tsx → bun, delete switchToSrc/Dist hack
Phase 3  esbuild/tsc → bun build
Phase 4  node → bun runtime (incl. Next.js)                     ← HIGHEST RISK
Phase 5  Native APIs (password → sql → file)
Phase 6  Dependency cleanup
Phase 7  Docker + CI
Phase 9  Tests (continuous, runs alongside 1–7)
```

Each phase is one PR. Phases 1–4 must land in order; 5 and 6 can interleave; 8 is independent.

---

## 15. Definition of done

**Functional**
- [ ] `bun install` from clean produces a working tree
- [ ] `bun run dev` serves the app
- [ ] All six WebSocket features verified by hand under Bun
- [ ] Remote server ops (deploy, logs, terminal) verified against a real remote host
- [ ] A pre-existing user logs in with their existing password
- [ ] Full drizzle migration chain runs from an empty database
- [ ] All four Docker images build and boot
- [ ] CI green on build, test, typecheck
- [ ] All enterprise features usable with no license; no request to `licenses-api.dokploy.com`
- [ ] Member-role server visibility unchanged from pre-migration (§8.3 backfill applied)

**Measured** — recorded against the Phase 0 baseline
- [ ] Install time and `node_modules` size
- [ ] Build wall-time per package
- [ ] Test suite wall-time
- [ ] Docker image size
- [ ] Server cold-boot time and steady-state RSS

**Removed**
- [ ] `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.nvmrc`
- [ ] `switchToSrc.js`, `switchToDist.js`, both `esbuild.config.ts`
- [ ] Dependencies listed in §10
- [ ] License service, cron, router, and UI

---

## 16. Rollback

Every phase is a single PR against `canary` and reverts cleanly. The two changes that are **not** cleanly reversible once users have interacted with them:

- **Phase 5.2 (`Bun.sql`)** — if a migration runs under the new driver, reverting the driver does not revert the schema. Take a database snapshot first.
- **Phase 8 DB column drop** — dropping `enableEnterpriseFeatures` / `isValidEnterpriseLicense` destroys the license state. Keep the columns for at least one release after the gates come out; drop them in a later cleanup.

Phase 5.1 (`Bun.password`) is reversible — verified in §2.
