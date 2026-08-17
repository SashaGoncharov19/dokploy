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
| tests | `bun run test` (vitest) — see Tests below |

**`bun build` does not typecheck.** A green build says nothing about types. Run
`typecheck` separately, always, before claiming a change compiles.

### Native dependencies

`node-pty`, `ssh2`, `bcrypt`, `better-sqlite3`, `sharp` and friends need postinstall
scripts. Bun only runs those for packages listed in root `package.json`
**`trustedDependencies`**. Adding a native dep without adding it there produces a
package that installs fine and fails at runtime. Add it in the same commit.

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
- `fetch` is native. No `undici`.

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

Vitest today, migrating to `bun test` **gradually**, directory by directory
(PLAN §13). Both runners are green in CI during the transition.

- New tests: write for `bun test`.
- Existing tests: leave on vitest unless you are deliberately porting that directory.

When porting, `vi.mock` → `mock.module` is **not** a rename. `vi.mock` is hoisted
above imports; `mock.module` is not, so a module already imported at the top of the
file will not be replaced — and the test then passes while asserting nothing.

**A port is not done until you have broken the source on purpose and watched the
test fail.**

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
