# Dokploy — project rules

Self-hosted PaaS. TypeScript monorepo, migrating from Node/pnpm to **Bun**.
This is a **fork** of `Dokploy/dokploy` that still absorbs upstream updates.

> **Migration in progress.** See [docs/bun-migration/PLAN.md](docs/bun-migration/PLAN.md).
> Until a phase has landed, parts of the repo still use the old toolchain. Check
> what the file in front of you actually does before assuming either state — do
> not "fix" a file to Bun conventions as a drive-by if its phase has not landed.

**Branch names:** [docs/BRANCHING.md](docs/BRANCHING.md) — `<type>/<slug>`, e.g.
`feat/wildcard-domains`. **Fork rules:** [docs/FORK-STRATEGY.md](docs/FORK-STRATEGY.md).

## Fork discipline — read before any wide edit

Upstream still ships, and we still merge it. That makes broad edits expensive in a way
that is invisible at the time you make them.

- **Never mass-rename or reformat.** 590 files mention "dokploy". A repo-wide rename
  makes every future upstream merge conflict in every file touched, permanently.
- **Never reformat an upstream file you are not otherwise changing** — a whitespace-only
  diff is invisible to you and fatal to `git merge`.
- **Diverge in files we own**, not by editing upstream logic in place. Prefer changing
  one constant or one export over rewriting a function.
- **Never push to the `upstream` remote.** Its push URL is set to `DISABLED` deliberately.

---

## Layout

| Path | What | Runtime |
|---|---|---|
| `apps/dokploy` | Next 16 web app (**pages router**) + custom server + 6 WebSocket servers | Bun |
| `apps/api` | Hono HTTP API | Bun |
| `apps/schedules` | Hono + BullMQ scheduler | Bun |
| `packages/server` | Shared domain logic, drizzle schema, docker/ssh/traefik utils | source-only, no build |
| `apps/monitoring` | **Go service — not part of the Bun migration, do not touch** | Go |

`packages/server` is consumed **as TypeScript source**. It has no build step and no `dist/`.
Never reintroduce one, and never write a script that mutates its `package.json`
`exports` (that hack was deliberately deleted — see PLAN §6.2).

---

## Toolchain

**Use Bun for everything.** Never `npm`, `pnpm`, `yarn`, `node`, `tsx`, or `npx`.

| Task | Command |
|---|---|
| install | `bun install` |
| add a dep | `bun add <pkg>` (`-d` for dev) |
| run a script | `bun run <script>` |
| one package | `bun run --filter <pkg> <script>` |
| all packages | `bun run --filter '*' <script>` |
| run a TS file | `bun file.ts` — never `tsx`, never a build step first |
| bundle | `bun build` — never esbuild |
| typecheck | `bun run --filter '*' typecheck` (`tsc --noEmit`) |
| format / lint | `bun run format-and-lint` (biome) |
| tests | `bun run test` — runs `bun test` **and** vitest, see Tests below |

**`bun build` does not typecheck.** A green build says nothing about types. Run
`typecheck` separately, always, before claiming a change compiles.

**And a green typecheck says nothing about the build.** `typecheck` resolves through
tsconfig `paths`; the build does not. Both have to run.

### Before opening a PR

Two failures in this migration reached CI because the local environment was richer than
a clean checkout. Both are cheap to prevent:

1. **Edited any `package.json`?** Run `bun install` and commit `bun.lock` in the same
   commit. CI runs `--frozen-lockfile` and a stale lockfile fails it instantly.
2. **Verify from clean.** `rm -rf node_modules && bun install --frozen-lockfile`, then
   `bun run --filter '*' typecheck && bun run build`. Passing against a warm
   `node_modules` proves less than it appears to.

### Native dependencies

`ssh2`, `better-sqlite3`, `sharp` and friends need postinstall scripts. Bun only runs
those for packages listed in root `package.json` **`trustedDependencies`**. Adding a
native dep without adding it there produces a package that installs fine and fails at
runtime. Add it in the same commit.

Two things this list will not tell you:

- **Bun aborts the whole install when any trusted package's script fails**, where pnpm
  tolerates it. `tree-sitter` is not in the list because it cannot compile against Node
  24's V8 headers at all — it was never building, pnpm just hid that.
- **node-gyp needs Node**, which the `oven/bun` image does not ship. The Dockerfiles
  install Node in the build stage for this reason alone; it never reaches runtime.

---

## Bun APIs

Prefer native Bun over the library it replaces:

- `Bun.serve` / `export default { fetch }` — not `@hono/node-server`
- `Bun.sql` + `drizzle-orm/bun-sql` — not `postgres.js`
- `Bun.spawn({ terminal: {...} })` — **not `node-pty`**, which is broken under Bun
  (PTY dies ~8ms after spawn, `resize()` throws `EBADF`). Note the callbacks take the
  `Terminal` as their first argument: `data(terminal, chunk)`, not `data(chunk)`.
- `Bun.file(p).text()` / `Bun.write()` — over `fs.readFile` / `writeFile` on hot paths
- Bun auto-loads `.env`. Never `import "dotenv/config"`, never `-r dotenv/config`.
  `dotenv` itself stays a dependency — `utils/docker/utils.ts` uses its `parse()` for
  user-supplied env files, which is a different job and has no Bun equivalent.
- `fetch` is native. `undici` stays only for the `FileList` polyfill in
  `utils/schema.ts`: Bun has `File`, not `FileList`.
- **`pino` transports do not survive bundling.** `transport: { target: "pino-pretty" }`
  spawns a worker thread loading `thread-stream/lib/worker.js` by absolute path, which
  is not in the runtime image. Pass `pino-pretty` as a stream instead.
- **`bun run x` does not put everything `x` spawns on Bun.** `next build` collects page
  data in Node child processes, so `build-next` needs `bun --bun`.

### Two hard rules

**1. Password hashing must pass `algorithm: "bcrypt"`.**

```ts
Bun.password.hash(pw, { algorithm: "bcrypt", cost: 10 })   // ✅
Bun.password.hash(pw)                                       // ❌ defaults to argon2id
```

Bun's default is argon2id. The `user` table holds `$2b$` bcrypt hashes and
`packages/server/src/utils/traefik/security.ts` writes an htpasswd file that Traefik
parses as bcrypt. Defaulting here breaks logins and basic auth. Verified compatible
in both directions with the npm `bcrypt` package — see PLAN §2.

**2. Do not replace `execAsync` with `Bun.$`.**

`packages/server/src/utils/process/execAsync.ts` runs **pre-assembled command
strings** and also dispatches to `ssh2` for remote execution. `Bun.$` is a tagged
template that escapes interpolations; feeding it raw strings needs `.raw` or
`sh -c`, which reopens the shell-injection surface for no measurable gain. Bun already
implements `node:child_process` natively. Leave it alone.

---

## Tests

Two runners during the transition, both green in CI (PLAN §13):

- **`bun test`** — the directories listed in `apps/dokploy` `test:bun`
- **vitest** — everything else; `__test__/vitest.config.ts` excludes the ported ones

`bun run test` runs both. **Porting a directory means moving it from the vitest
`exclude` list into the `test:bun` list** — the two must stay complementary, or
tests silently stop running in both.

- New tests: write for `bun test`, importing from `bun:test`.
- Existing tests: leave on vitest unless you are deliberately porting that directory.

Note that `bun test` will happily execute a file that imports from `"vitest"` — so a
directory can appear ported when it is not. Rewrite the imports to `bun:test` as part
of the port, so the runner is visible in the file.

When porting, `vi.mock` → `mock.module` is **not** a rename. Three differences bite,
all measured rather than inferred.

**1. `mock.module` is not hoisted, but it *is* retroactive.** It updates the registry
and ESM live bindings, so a consumer that *calls* through an imported binding does get
the mock even when the module was imported first. What breaks is code that **reads a
value at module-body time**. `drop.test.ts` had `const { APPLICATIONS_PATH } = paths()`
above its `vi.mock`; hoisting meant it got the mocked path, and without hoisting it got
the real one — which the fixtures then `rm -rf`. Put the `mock.module` call above
anything that reads what it mocks.

**2. `mock.module` is process-global.** vitest runs `pool: "forks"`, so each file gets
its own registry and a mock cannot escape it. `bun test` runs files in one process, so
mocking `node:fs` or `@dokploy/server/db` in one file changes every file that runs
after it. Symptom: a suite that passes alone and fails as part of its directory.
**`mock.restore()` does not undo `mock.module`** — only installing the original module
again does:

```ts
const actual = { ...nodeFs };                       // snapshot BEFORE mocking
mock.module("node:fs", () => ({ ...actual, existsSync: () => true }));
afterAll(() => mock.module("node:fs", () => ({ ...actual, default: actual })));
```

Restore anything global you mock, and do not depend on a mock another file installed —
`__test__/setup.bun.ts` preloads a db mock, but a narrower one from any other file
replaces it wholesale.

**3. Native builtins are the exception to rule 1.** Ordinary modules update through
live bindings, but `node:fs` and friends do not: a consumer that imported
`existsSync` before your `mock.module` ran keeps the real one forever. Static imports
are hoisted, so that is the default. Import the module under test **dynamically,
after** the mock:

```ts
mock.module("node:fs", () => ({ ...actualFs, existsSync: () => true }));
const { writeDomainsToCompose } = await import("@dokploy/server/utils/docker/domain");
```

This one is easy to miss precisely because rule 1 holds everywhere else.

**4. There is no `importOriginal` and no `vi.hoisted`.** For the first, snapshot the
namespace into a plain object *before* mocking — reading it back afterwards recurses
into the mock. For the second, just declare plain consts above the `mock.module` call;
the wrapper only existed to feed a hoisted factory.

**A port is not done until you have broken the source on purpose and watched the
test fail.** And check what you broke actually matters: sabotaging an uncovered
function, or a branch whose outcome is unchanged, leaves the suite green and proves
nothing either way.

**Run the ported files individually too, not just the directory.** Because mocks are
process-global, a directory can be green while a file in it is broken on its own -
one compose test only passed because a *different* file in the same directory writes
real files to disk, making its unmocked `existsSync` true by accident:

```bash
for f in $(find __test__/<dir> -name "*.test.ts"); do bun test "$f"; done
```

---

## Enterprise licensing — being removed

All enterprise features are being unlocked (PLAN §12,
`.claude/skills/remove-enterprise-license/SKILL.md`). Do not add new license gates.

`hasValidLicense` is **not** purely a feature flag. Three call sites use it to select
between different access-control behaviors, and in one of them *unlicensed is the more
permissive branch*:

- `services/server.ts:183` `getAccessibleServerIds` — unlicensed returns **every** org
  server; licensed returns only `accessedServers`. Forcing licensed **restricts**
  members and needs a backfill first.
- `services/permission.ts:47` `resolveRole` — unlicensed makes custom roles inert.
- `services/git-provider.ts:105` — licensed is the wider branch here.

Read PLAN §12.3 before changing any of these three.

---

## Conventions

- Biome, tabs, double quotes. Run `bun run check` before finishing.
- `apps/dokploy` is the **pages router**. Not app router. Do not add `app/` routes.
- tRPC v11 + drizzle + better-auth. Routers live in `apps/dokploy/server/api/routers/`;
  `proprietary/` holds the formerly-licensed ones.
- Drizzle migrations are generated, never hand-written:
  `bun run --filter dokploy migration:generate`.
- Never edit `openapi.json` by hand — it is generated by `generate:openapi`.

## Don't

- Don't touch `apps/monitoring` (Go).
- Don't add a build step to `packages/server`.
- Don't commit `pnpm-lock.yaml`, `pnpm-workspace.yaml`, or `.nvmrc` — they are being deleted.
- Don't drop the `enableEnterpriseFeatures` / `isValidEnterpriseLicense` columns yet;
  keep them one release past the gate removal (PLAN §16).
