# Phase 0 — Native module spike results

**Date:** 2026-08-17
**Bun:** 1.3.14 · **Node control:** 24.x (Linux) / 22.20.0 (macOS)
**Platforms:** macOS arm64 (dev) and `oven/bun:1.3.14-slim` Debian (production target)

## Verdict: ✅ GATE PASSED — "everything on Bun" is achievable

`node-pty` does not work under Bun, but it does not need to: **Bun ships a native PTY,
`Bun.Terminal`**, which passes every test node-pty failed. The migration replaces the
dependency rather than working around it.

| Module | Bun | Node | Result |
|---|---|---|---|
| `ssh2` | ✅ | ✅ | **PASS** — handshake, exec channel, stdout stream, interactive shell channel |
| `dockerode` | ✅ | ✅ | **PASS** — ping, listContainers, log stream, stats |
| `Bun.Terminal` | ✅ | n/a | **PASS** — replaces node-pty; verified on macOS **and** Linux |
| `node-pty` | ❌ | ✅ | fails under Bun — **to be removed**, not fixed |

Every test ran the same file against the same `node_modules` and the same compiled
`.node` binaries, switching only the interpreter. Node is the control where applicable.

---

## `Bun.Terminal` — the replacement for node-pty

Identical test to the one node-pty failed, on both platforms:

```
                    macOS arm64      Linux (oven/bun:1.3.14-slim)
exited early    :   false            false
marker echoed   :   true             true
resize          :   ok               ok
resize applied  :   true             true
child sees tty  :   true             true
sustained usable:   true             true
total bytes     :   346              175
clean exit      :   true             true
```

`child sees tty` is `test -t 0` inside the spawned shell, and `resize applied` is
`stty size` reporting `40 120` after a mid-session `resize(120, 40)` — the exact
behavior `docker-container-terminal.ts:199` depends on.

### API shape (verified by introspection, 1.3.14)

```ts
const proc = Bun.spawn({
  cmd: ["/bin/sh"],
  terminal: {
    cols: 80,
    rows: 24,
    name: "xterm-color",
    data(terminal, chunk: Uint8Array) { /* output */ },
    exit(terminal, code, signal) { /* exited */ },
  },
});
proc.terminal.write("echo hi\r");
proc.terminal.resize(120, 40);
```

**The callbacks take the `Terminal` instance as their first argument** — `data(terminal,
chunk)`, not `data(chunk)`. This is easy to get wrong and fails in a confusing way
(the chunk silently becomes the Terminal object), so it is worth stating in the port.

`proc.terminal` exposes: `write`, `resize`, `setRawMode`, `close`, `closed`, `ref`,
`unref`, `controlFlags`, `inputFlags`, `localFlags`, `outputFlags`.

Uses `openpty()` on Linux/macOS, ConPTY on Windows (irrelevant here — deploy target is
Linux).

### Migration work this creates

Two files import `node-pty`, both in `apps/dokploy`:

- `apps/dokploy/server/wss/docker-container-terminal.ts` — including
  `ptyProcess.resize(...)` at line 199
- `apps/dokploy/server/wss/docker-container-logs.ts`

Port both from `spawn` (node-pty) to `Bun.spawn` + `terminal`. Mapping:

| node-pty | Bun.Terminal |
|---|---|
| `spawn(file, args, { cols, rows, name, cwd, env })` | `Bun.spawn({ cmd: [file, ...args], cwd, env, terminal: { cols, rows, name } })` |
| `p.onData(cb)` | `terminal.data(terminal, chunk)` callback |
| `p.onExit(cb)` | `terminal.exit(terminal, code, signal)` callback |
| `p.write(s)` | `proc.terminal.write(s)` |
| `p.resize(c, r)` | `proc.terminal.resize(c, r)` |
| `p.pid` | `proc.pid` |

Then drop `node-pty` from `apps/dokploy` dependencies and from `trustedDependencies`.
This removes a native module from the tree entirely — a net simplification, and it may
let the `python3 make g++` layer shrink in the Dockerfiles once `bcrypt` also goes
(PLAN §9.1). `ssh2` still has optional native pieces, so verify before removing that
layer outright.

---

## Why node-pty fails under Bun (recorded for completeness)

Not a blocker anymore, but the evidence, since it is why we are replacing it:

```
### BUN ###                     ### NODE ###
onExit fired at: 8ms            onExit fired at: not yet
step A/B/C echoed: false        step A/B/C echoed: true
total bytes received: 2         total bytes received: 71
sustained session usable: false sustained session usable: true
```

The PTY child exits ~8ms after spawn; the two bytes are terminal echo, not command
output. `resize()` then throws `ioctl(2) failed, EBADF` because the fd is already gone.
Reproduced identically on macOS arm64 and Debian, so not a platform quirk. This matches
the known upstream issues ([oven-sh/bun#7362](https://github.com/oven-sh/bun/issues/7362),
[microsoft/node-pty#632](https://github.com/microsoft/node-pty/issues/632)).

### Secondary finding: `bun install` drops the executable bit

On macOS, `bun add node-pty@1.1.0` extracted the prebuilt helper non-executable
(`-rw-r--r-- prebuilds/darwin-arm64/spawn-helper`), so `pty.fork()` failed with
`posix_spawnp failed` before anything else could be tested. `chmod +x` got past it.

This is a **separate Bun packaging bug** from the runtime failure, and it is worth
remembering beyond node-pty: it would hit **any** dependency shipping a prebuilt
executable. If a package mysteriously fails to exec its own helper binary after
`bun install`, check the mode bits first.

Also note node-pty 1.1.0 ships prebuilds only for darwin/win32 — **no Linux prebuild** —
so Linux compiled it from source via node-gyp. That is why the Dockerfiles install
`python3 make g++`. Removing node-pty removes that particular reason for the layer.

---

## Baseline and Phase 1 measurements

Captured on this machine (macOS arm64), pnpm 10.22.0 provisioned via corepack.

| Metric | pnpm (before) | bun (after) | Δ |
|---|---|---|---|
| `install --frozen-lockfile`, warm cache | **21.9s** | **13.4s** (first, incl. lockfile migration) / **5.5s** (subsequent) | ~1.6×–4× faster |
| `node_modules` size | **1.5G** | **1.5G** | unchanged |
| Packages installed | — | 3295 | — |
| Typecheck, all 4 packages | 0 errors | **0 errors** | parity |
| Test suite | — | **95/96 files, 869/874 tests pass** | see below |
| Lockfile size | 671 KB (`pnpm-lock.yaml`) | 503 KB (`bun.lock`) | 25% smaller |

`bun install` migrated `pnpm-lock.yaml` to `bun.lock` automatically on first run.

**Not yet measured:** Docker image sizes, server cold-boot time and RSS. Those become
meaningful after Phases 4 and 7, when the runtime actually changes; measuring them now
would only re-measure Node.

### CI wall-times — same runner, same code, toolchain swapped

GitHub-hosted `ubuntu-latest`, one run per configuration.

| Job | pnpm (baseline) | Phase 1 — bun | Phase 2 — bun, no server build |
|---|---|---|---|
| `build` | 3m51s | 3m41s | **2m39s** |
| `test` | 4m31s | 3m29s | 3m44s |
| `typecheck` | 1m25s | 56s | 1m6s |
| `format` | 10s | 12s | 8s |

⚠️ **n=1 per configuration.** These are single runs on shared runners, so treat
differences under roughly 15s as noise — `format`, and the `test`/`typecheck` movement
between Phase 1 and Phase 2, are all inside that band. Only `build` moved far enough to
be a real signal, and its cause is known rather than inferred: Phase 2 deleted the
`server:build` step entirely, so the drop is work removed, not work sped up.

The honest summary is **"build got meaningfully shorter, the rest is not yet
distinguishable from noise."** Repeated runs would be needed to claim more.

### Phase 4 — the application actually running on Bun

Verified against a real PostgreSQL 16 container, production build, `bun dist/server.mjs`:

| Check | Result |
|---|---|
| Full drizzle migration chain from empty DB | ✅ "Migration complete" |
| `/register` SSR | ✅ **200**, 42 KB of rendered HTML with `__NEXT_DATA__` |
| `/api/trpc/settings.health` | ✅ **200** `{"status":"ok"}` |
| `/reset-password`, `/invitation` | ✅ 307 (expected auth redirects) |
| WebSocket upgrade (`/docker-container-terminal`) | ✅ **101 Switching Protocols** |
| Errors in the server log | ✅ **zero** |

**Correction to an earlier claim in this document's history:** a first run appeared to show
SSR failing in production. That was an artifact of the test sequence — the dev server had
been started first and overwrote `.next/` with Turbopack dev chunks, which the production
server then loaded. On a clean `rm -rf .next && bun run build`, production works with no
errors. The lesson generalises: never test a production build in a tree a dev server has
touched.

### Next.js dev mode under Bun — broken by default, fixed with one option

Reproducible on a clean `.next`, both with and without the custom server's `turbopack`
flag, and unaffected by `NEXT_DISABLE_TURBOPACK=1`:

```
⨯ Error: Failed to load external module next-themes-6b0513a0c1105732:
  Cannot find package 'next-themes-6b0513a0c1105732' from
  '.next/dev/server/chunks/ssr/[root-of-the-server]__0ovu9hl._.js'
```

Next 16's dev server refers to externalised packages by a **hash-suffixed synthetic
name**, and Bun's resolver cannot resolve it. Node can. `transpilePackages` did not help,
and neither did `NEXT_DISABLE_TURBOPACK=1`.

**The fix is to stop using Turbopack in dev**, which requires knowing that `turbopack:
false` is *not* an opt-out. From `next/dist/server/next.js`:

```js
if (selectTurbopack)      process.env.TURBOPACK ??= "1";
else if (!selectWebpack)  process.env.TURBOPACK ??= "auto";   // ← default
```

With neither flag truthy Next falls through to Turbopack anyway. Webpack has to be asked
for explicitly, so the custom server now passes `webpack: !useTurbopack`. This also aligns
dev with `next build --webpack`, which the repo already used — dev and build now run the
same bundler instead of two different ones.

Verified after the change: `/register` **200** with 31 KB of SSR HTML,
`/api/trpc/settings.health` **200**, WebSocket **101**, zero resolve errors.

The breakage predated phase 4 — the `dev` script moved to `bun` in phase 2, which was
verified with typecheck, build and tests but never by actually starting the dev server.
Process miss worth keeping: *a script that starts a long-running process is not verified
until it has been started.*

Worth noting for anyone comparing against a "Next.js on Bun" starter template: running
`bun run dev` where the script is `next dev` does **not** run Next on Bun. The `next` CLI
carries a `#!/usr/bin/env node` shebang, so Bun acts only as package manager and script
runner while Next itself executes on Node (`bun --bun` forces otherwise). A custom server
that imports `next()` in-process, as Dokploy does, genuinely runs Next inside Bun — which
is why this hit us and does not hit those templates.

### Production verification on arm64

Everything above is a spike or a CI run. This is the instance: installed with
`install.sh` on Debian 13 (arm64, Proxmox LXC, 8GB), pulling the published multi-arch
image from GHCR anonymously, deploying and serving real containers.

All six WebSocket servers exercised by hand:

| Endpoint | Mechanism | Result |
|---|---|---|
| `docker-container-terminal` | **Bun.Terminal** | interactive session, commands execute |
| `docker-container-logs` | **Bun.Terminal** | live `docker logs --follow` stream |
| `terminal` | ssh2 | interactive shell |
| `listen-deployment` | ssh2 | live build output |
| `docker-stats` | dockerode | live stats |
| `drawer-logs` | — | works |

`Bun.Terminal` is the one that mattered. Resize was confirmed by `stty size` inside the
container while resizing the browser: `18 127` → `18 71` → `18 38`. The column count
tracks the window, which proves the resize messages reach the PTY. The row count does
not, because `docker-terminal.tsx:122` pins the panel at `h-[420px]` — a UI layout
choice, unrelated to the runtime.

Also verified: registration (exercising `Bun.password` and `Bun.sql` on the write path),
the migration chain applying on first boot, and a three-image Compose stack deployed end
to end.

### Two installer traps found by installing for real

Neither is caused by the Bun migration; both are upstream behaviour that only appears on
a second install, and both are now handled in `install.sh`.

**No `:latest` tag.** Version detection falls back to `latest`, which upstream publishes
from `main`. This fork publishes from `canary` and has no releases, so the tag 404s and
the service sits in `Starting` with `No such image`. The fallback is now
`DOKPLOY_FALLBACK_VERSION`, defaulting to `canary`.

**Stale database volume.** A full install runs `docker swarm leave`, which destroys every
Docker Secret, then generates a new Postgres password — but the `dokploy-postgres` volume
survives, and Postgres only applies `POSTGRES_PASSWORD` when initialising an empty data
directory. The result is `FATAL: password authentication failed (28P01)`, invisible from
`docker service logs` and reported by swarm only as `Starting`. The installer now refuses
up front and offers `sh -s update` or `DOKPLOY_RESET_DB=true`.

The second one also needed a second fix: removing the services is not enough, because
their *stopped* containers keep the volume referenced and `docker volume rm` reports
"volume is in use" for a container that is not running.

### Not a bug: triplicated deploy log lines

Worth recording because it looked like one. Deploy output repeated every Docker progress
line three times. The compose file had three services sharing one image, and
`docker compose pull` reports progress per service — `mariadb` and `redis` appeared once
each, the shared image three times. Docker's own output, not a stream being subscribed
to more than once.

### Docker image sizes

Same machine, pre-migration commit vs now.

| Image | Node + pnpm | Bun | |
|---|---|---|---|
| api | 1.25GB | **234MB** | 5.3× smaller |
| schedules | — | **232MB** | — |
| main (web app) | 3.25GB | 3.22GB | **unchanged** |

The service images collapse because `bun build` emits a self-contained bundle and
extracts the native addons next to it, so the runtime image ships `dist/` and nothing
else — no `node_modules`.

The main image does **not** shrink, and that is worth stating rather than omitting: its
bulk is the docker CLI, nixpacks, railpack, buildpacks, rclone and git-lfs. A runtime
swap cannot touch any of that, and Next.js still needs `node_modules` at runtime, so the
self-contained trick does not apply. Anyone expecting "Bun makes images smaller" as a
general claim should look at these two rows and take the specific one.

### `apps/schedules` had been broken since phase 2, and nothing caught it

`bun build --packages=external` leaves every `node_modules` import external. For these
two services the workspace package `@dokploy/server` gets inlined from source, but *its*
transitive imports stay external — and Bun's isolated `node_modules` layout only links a
package's own declared dependencies, so they are not resolvable from the consuming app:

```
error: Cannot find package 'nanoid' from apps/schedules/dist/index.js
```

Confirmed against `canary` before assigning blame: **the same failure reproduces there**,
so it arrived with phase 2 and survived phases 3, 4 and 5. Typecheck, build and the test
suite were all green throughout, because none of them start the service.

Second instance of the same process gap as the dev server. The rule earned twice now:
**a build artifact is not verified until something has executed it.** Both services are
now booted and health-checked as part of verification, not just built.

The fix is to drop `--packages=external` and ship a self-contained bundle. Bun extracts
native addons alongside the output automatically:

```
index.js                   11.31 MB
cpufeatures-bkg5m6qf.node  61.66 KB
sshcrypto-9g7gcmhy.node   115.23 KB
```

Larger than the 8 KB externalised stub, but it actually runs — and it removes the need to
ship `node_modules` in the images at all, which phase 7 can take advantage of.

`apps/api` had the identical latent fragility; it happened to boot only because its own
externals were satisfiable. Both are self-contained now.

### Dependency cleanup: what could and could not go

| Dependency | Verdict |
|---|---|
| `@hono/node-server` | **removed** — `export default { fetch, port }` is Bun's own contract |
| `dotenv` as an env *loader* | **removed** — Bun reads `.env` itself |
| `dotenv` as a *parser* | **kept** — `utils/docker/utils.ts` uses `parse()` on user-supplied env files, and Bun exposes no equivalent |
| `redis` (apps/api) | **removed** — no live import; the only mention was a comment |
| `ioredis` (apps/schedules) | **removed as a direct dep** — `bullmq` declares it and creates its own client from the `connection` config |
| `undici` | **kept deliberately** — see below |

`undici` exists in `utils/schema.ts` to polyfill `globalThis.File` and `globalThis.FileList`
server-side. Bun provides `File` natively but **not `FileList`**. `FileList` appears only in
client components, where the browser supplies it, and `zod-form-data` never references it —
so the polyfill looks removable. It was left in place anyway: the failure mode is a
`ReferenceError` on a file-upload path that the test suite does not cover, and removing
something whose absence cannot be verified is not worth one dependency.

### `next build` spawns Node workers — `--bun` is required

The most transferable finding of the whole migration.

Moving the database driver to `drizzle-orm/bun-sql` broke `next build`:

```
Error: Cannot find package 'bun' imported from
  node_modules/.../drizzle-orm/bun-sql/driver.js
> Build error occurred
Error: Failed to collect page data for /dashboard/monitoring
```

`next build` collects page data in **child processes**, and those are Node even when the
outer command runs under Bun. Any module reachable from page code must therefore be
resolvable by Node — and `drizzle-orm/bun-sql` does `import "bun"`, which Node cannot
resolve.

The fix is `bun --bun`, whose documented job is exactly this: *"Force a script or package
to use Bun's runtime instead of Node.js (via symlinking node)."* With `build-next` set to
`bun --bun next build --webpack`, the spawned workers are Bun and the import resolves.

**The general rule: `bun run x` does not make everything `x` spawns run on Bun.** It is
worth knowing before adopting any Bun-only API in code a bundler or framework might
evaluate out-of-process.

Related: this is also why "Next.js on Bun" starter templates work without hitting any of
this. `bun run dev` where the script is `next dev` runs the `next` CLI, which carries a
`#!/usr/bin/env node` shebang — Bun is the package manager and script runner, Node is the
runtime. Dokploy's custom server imports `next()` in-process, so Next genuinely runs
inside Bun.

### `Bun.sql` cannot batch statements; drizzle's `execute` can

```
await sql`CREATE SCHEMA a; CREATE SCHEMA b;`
  -> cannot insert multiple commands into a prepared statement
await sql.unsafe("CREATE SCHEMA a; CREATE SCHEMA b;")   -> OK
```

The tagged template goes through the extended protocol, which forbids multiple commands.
`server/db/reset.ts` issues `DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP schema
drizzle CASCADE;` as one statement — but it goes through drizzle's `db.execute()`, which
does not prepare, so it **works unchanged**. Verified against a real database rather than
assumed, because the failure would only have appeared when someone reset their database.

### Migration chain on `Bun.sql`

186 migrations applied to an empty PostgreSQL 16, producing 67 tables.

| Driver | Full chain |
|---|---|
| `postgres.js` | 699ms |
| `Bun.sql` | 593ms |

Close enough to be noise for a one-off operation; not claimed as a win. Runtime queries
were verified separately by booting the app and hitting `whitelabeling.getPublic`, which
reads real tables — 200, and zero database errors in the log.

One incidental difference: `postgres.js` prints PostgreSQL `NOTICE` messages to stdout
during migration, `Bun.sql` does not.

**`postgres` does not leave the dependency tree.** It is an `optionalDependency` of
`drizzle-orm` itself, so dropping our direct dependency is a code-clarity change, not a
size one.

### `Bun.password` throws where npm `bcrypt` returns false

Compatibility of the hashes themselves was already settled (both directions, §2). The
difference that actually needed handling is in the failure path:

| Stored hash | npm `bcrypt` | `Bun.password.verify*` |
|---|---|---|
| valid, wrong password | `false` | `false` |
| empty string | `false` | `false` |
| garbage / truncated | `false` | **throws** |
| argon2 (wrong algorithm) | `false` | **throws** |

`apps/dokploy/server/api/routers/user.ts` compares against
`currentAuth?.password || ""`, and `account.password` is user data that can be malformed
for reasons outside this codebase. Left unhandled, one bad row turns a clean
"Current password is incorrect" 400 into a 500.

`packages/server/src/lib/password.ts` normalises this — verification catches and returns
`false`, matching bcrypt exactly — and pins `algorithm: "bcrypt"` on every hash so the
argon2id default can never reach the database or the Traefik htpasswd file.

### `Bun.Terminal`: `proc.kill()` silently does nothing

Found while porting off node-pty, and worth knowing for anyone using `Bun.spawn` with a
`terminal`:

| Method | exit callback | process actually dies |
|---|---|---|
| `proc.kill()` | ❌ | ❌ **stays alive** |
| `proc.kill("SIGKILL")` | ✅ | ✅ |
| `proc.terminal.close()` | ✅ | ✅ |
| `process.kill(pid, "SIGHUP")` | ✅ | ✅ |

Only the no-argument form fails, and it fails silently — `proc.exited` never resolves and
`killed` stays `false`. Both WebSocket handlers call `kill()` when the socket closes, so
using it would have leaked a `docker exec` or `docker logs --follow` process per session.
The adapter uses `terminal.close()` followed by an explicit `SIGKILL`.

### The result that actually matters

**All 874 tests pass on Bun in CI**, including the 4 that fail locally for want of
`docker swarm init`. The full Dokploy test suite — deploys, traefik, SSH, docker,
compose, backups, permissions — runs green on Bun.

That is a stronger statement than any timing number, and it is the one to lead with.

### Two failures CI caught that local runs did not

Both had the same root cause: **the local environment was richer than a clean checkout.**

1. **`apps/api` / `apps/schedules` builds.** Removing the `packages/server` build broke
   their `tsc` builds, because both compiled against the generated `dist` declarations.
   Typecheck stayed green — it resolves via tsconfig `paths` — so only running the real
   build surfaced it.
2. **Lockfile drift.** Dependencies were removed from manifests without re-running
   `bun install`, so `bun.lock` went stale and `--frozen-lockfile` failed in CI. Local
   builds passed because `node_modules` already had everything.

**Process rule taken from this:** after any `package.json` edit, run `bun install` and
commit the lockfile, and do the final pre-PR verification from `rm -rf node_modules`.
A green typecheck is not evidence that the build works.

### Test failures are environmental, not migration-caused

4 tests in `__test__/deploy/application.real.test.ts` fail locally, all with the same
root cause:

```
(HTTP code 503) This node is not a swarm manager.
Use "docker swarm init" or "docker swarm join" ...
```

CI initializes swarm explicitly before the test job
(`.github/workflows/pull-request.yml:43`), so these pass there. They were **not** run
locally under a swarm, so they are unverified rather than known-good — `docker swarm
init` changes the host Docker daemon globally, which is not something to do
unilaterally on a dev machine. To close the gap: `docker swarm init && docker network
create --driver overlay dokploy-network`, re-run, then `docker swarm leave --force`.

---

## Runtime — the Bun image against the Node baseline

Everything above measures the toolchain: install, CI wall-time, image build. None of
it says anything about the server once it is running, which is the question that
decides whether the migration was worth doing. This section measures that.

Harness: [`scripts/runtime-benchmark.ts`](../../scripts/runtime-benchmark.ts). It
builds its own PostgreSQL and containers, runs every phase, and tears the whole thing
down again, so these numbers can be re-run rather than taken on trust.

**Setup.** One host (macOS arm64, Docker 29.4.0), one PostgreSQL 16 container, one
database per image. `oha` generates load from the host, so the generator is identical
for both. The Docker socket is deliberately *not* mounted: both images therefore fail
`initializeNetwork()` in exactly the same way, and both still serve HTTP, because
`server.listen()` runs before that call in `server.ts`.

**What is comparable here, and what is not.** `/register` renders byte-identical
output from both images — 32175 bytes, `__NEXT_DATA__` present — so the request path
being measured is the same code doing the same work. What is *not* identical is the
rest of the tree: the Node image is built from the **pre-migration commit**, because
a Node build of today's tree no longer exists. Licence removal, the branding defaults
and migration 0186 are in the Bun image and not the Node one. None of them touch
these code paths, but this is a fork-against-ancestor comparison, not a pure runtime
swap, and should not be quoted as one.

### Results

Medians, with the first run of each series discarded — the first start after an image
has been idle pays host page-cache costs the later ones do not.

| Metric | Node baseline | Bun | |
|---|---|---|---|
| Cold boot — empty DB, 186 migrations applied (n=4) | 4720ms | **3411ms** | 1.4× faster |
| Warm start — already-migrated DB (n=10) | 4244ms (σ 718) | **3345ms** (σ 332) | 1.3× faster |
| Shutdown — `docker stop` to exited (n=10) | 3019ms (σ 740) | **318ms** (σ 182) | **9.5× faster** |
| Idle RSS, 60s settle | 753.0 MiB | **625.5 MiB** | 17% lower |
| RSS after the load runs below | 1314.8 MiB | **759.7 MiB** | 42% lower |
| `/api/health` — 30s, 50 concurrent | 8855 rps, p50 4.56ms | 8681 rps, p50 4.22ms | no difference |
| `/register` SSR — 30s, 20 concurrent | 780 rps, p50 23.28ms | 745 rps, p50 24.64ms | no difference |

Both load runs completed at 100% success.

### Throughput did not move, and that is the honest headline

Neither endpoint changed outside noise — 2% on `/api/health`, 4% on SSR, each from a
single 30-second run, and in both cases the *baseline* is nominally ahead. The request
path is bounded by Next.js and React rendering, not by the JavaScript engine
underneath, so swapping the engine does not move it. Anyone repeating "Bun is faster"
as a general claim about this migration should be shown these two rows first.

### Shutdown is the row that pays for itself

3019ms → 318ms is the largest effect measured anywhere in this migration, and it is
not academic. `install.sh` creates the service with `--update-order stop-first`, so
every single Dokploy update waits for this shutdown before the new task starts. The
Node baseline also swings between 1834ms and 4156ms; the Bun build sits at 250–894ms.

Faster *and* an order of magnitude more predictable, on the one path that runs during
every upgrade.

### Startup: real, but smaller than one run made it look

An earlier five-repetition pass had the Node baseline *winning* warm start at 2826ms
against 3340ms. It was wrong. Node's warm start is bimodal — it lands near 2800ms or
near 4300ms with nothing in between — and five samples happened to catch two of the
fast ones. Extending to eleven and dropping the warm-up reversed the result: 4244ms
against 3345ms.

Recorded because the failure mode is the point. The measurement was not noisy in a way
that looked noisy; it was stable enough to read as a finding and still wrong. The
standard deviations are the tell — 718ms against 332ms.

### Memory is genuinely lower, but read RSS carefully

Idle is 17% lower. The post-load figure is the striking one: under identical load the
Node baseline grew ~562 MiB and did not give it back, where the Bun build grew ~134 MiB.

That is memory **held**, not memory **needed**. V8 and JavaScriptCore have different
heap-growth and collection strategies, and neither runtime was asked to collect before
the sample was taken. It is what an operator sees in `docker stats`, which is why it
is worth recording — but it is not evidence of a leak in either build.

### Image sizes, re-measured alongside

| Image | Node + pnpm | Bun | |
|---|---|---|---|
| main (web app) | 3.25GB, 22 layers | 3.22GB, 25 layers | unchanged |
| api | 1.25GB, 11 layers | 234MB, 8 layers | 5.3× smaller |
| schedules | — | 232MB, 8 layers | — |

Same figures as the earlier table, in the decimal units `docker images` prints; the
layer counts are new.

Same conclusion as before: the service images collapse because `bun build` emits a
self-contained bundle, and the main image does not, because its bulk is the docker
CLI, nixpacks, railpack, buildpacks, rclone and git-lfs — none of which a runtime swap
can touch.

### Summary

Three real wins, one large one, and one non-result:

- **Shutdown 9.5× faster**, on the critical path of every update.
- **Memory 17% lower idle, 42% lower after load.**
- **Boot 1.3–1.4× faster**, cold and warm.
- **Throughput unchanged.** Not a regression, not a win.

---

## Where the 626 MiB of idle memory actually goes

Measured inside the running container rather than inferred, because the obvious
levers turn out to do nothing.

| Stage | RSS |
|---|---|
| bare `bun` process | 38 MB |
| `+ import("next")` | 66 MB |
| `+ import("@dokploy/server")` | **450 MB** |
| full server at rest | 637 MB |
| after loading 11 dashboard pages | 661 MB |

**`bun --smol` changes nothing** - 627.0 MB against 626.6 MB. That is the useful
negative result: `--smol` shrinks the JS heap, so if it does not help, the memory
is not heap pressure the GC could relieve. Confirmed by the process map: 640 MB
of the RSS is anonymous, only 47 MB file-backed.

The cost is concentrated in one import. Breaking it down:

| Module | RSS added |
|---|---|
| `@dokploy/server/db` | **169 MB** |
| `better-auth` | 37 MB |
| `dockerode` | 27 MB |
| `drizzle-zod` | 22 MB |
| `drizzle-orm` | 9 MB |
| `ssh2` | 2 MB |

`db/index.ts` hands the entire schema to `drizzle(dbUrl, { schema })` so the
relational query API (`db.query.*`) works, and the schema is 7527 lines across
67 tables with 72 `createSelectSchema`/`createInsertSchema` calls evaluated at
module load. That is the 169 MB, and it is one copy - not the duplication the
comment in that file warns about.

Checked that specifically: loading eleven dashboard pages grew RSS by 26 MB,
about 2.4 MB per page. If each Next page chunk carried its own copy of the
schema the growth would be far larger, so `transpilePackages` is not multiplying
it.

**Nothing here is a leak, and nothing is obviously wasteful.** Reducing it means
either not giving drizzle the full schema - which removes `db.query.*` - or
making 72 zod schema generations lazy across upstream schema files. Both are
wide changes to files this fork otherwise leaves alone, so neither was made.
Recorded so the next person does not spend the afternoon rediscovering that
`--smol` is not the answer.

---

## Two build optimisations that were measured and rejected

Both look obviously correct and neither survives measurement.

### `experimental.optimizePackageImports` — no effect

`lucide-react` is imported in 279 files, `date-fns` in 20, `recharts` in 16.
Barrel packages like these are the textbook case for Next's
`optimizePackageImports`, which rewrites `import { X } from "pkg"` to a direct
path so the whole index is not pulled in.

Adding `lucide-react`, `date-fns`, `recharts` and `lodash` to it changed the
bundle by **zero bytes** on every page measured. Next 16 already applies this to
these packages by default, so the config would have been decoration in an
upstream file. Reverted.

### Turbopack build — 4.7× faster, and rejected anyway

| | webpack | turbopack |
|---|---|---|
| `next build` | 54.7s | **11.7s** |
| application page | 2478K | 2659K (**+181K**) |
| `/_app` | 755K | 776K |
| `.next/server` | 62MB | 105MB |

Turbopack builds in a fifth of the time and produces a meaningfully larger
bundle. That is the wrong side of the trade for a self-hosted product: the build
runs once in CI, where 43 seconds is a rounding error against the Docker layers
around it, while the extra 181KB is downloaded by every user on every page,
forever.

For context on the scale: the lazy-loading work in this same session fought for
119KB, 136KB and 419KB individually. Giving 181KB back to save CI time would
have undone a third of it.

Runtime compatibility was not even reached - `server.ts` already documents
Turbopack's dev output being unresolvable under Bun. The bundle regression
decided it first.
