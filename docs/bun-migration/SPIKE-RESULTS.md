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
