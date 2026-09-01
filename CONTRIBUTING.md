# Contributing

Thanks for taking the time. This document covers contributing to **this fork** —
Dokploy running on Bun. If you have never worked in the repository before, read
[Where to send what](#where-to-send-what) first; it will save you from opening a pull
request in the wrong place.

- [Where to send what](#where-to-send-what)
- [Setup](#setup)
- [Development](#development)
- [Tests](#tests)
- [Fork discipline](#fork-discipline)
- [Commits and branches](#commits-and-branches)
- [Pull requests](#pull-requests)

## Where to send what

This repository is a runtime fork. The product is
[Dokploy](https://github.com/Dokploy/dokploy), built by Mauricio Siu and its
contributors; we change what it runs on, not what it does.

| Your change | Where it belongs |
|---|---|
| Bun runtime, build, images, CI, benchmarks | **here** |
| A bug that only reproduces on Bun | **here** |
| A new product feature, or a bug that also happens on upstream's build | [upstream](https://github.com/Dokploy/dokploy) — we merge their releases |
| A one-click app template | [Dokploy/templates](https://github.com/Dokploy/templates) |
| Product documentation | [Dokploy/website](https://github.com/Dokploy/website) |

Sending a product fix upstream gets it to far more people than sending it here, and it
reaches us anyway on the next sync. If you are unsure which side a bug is on, open an
issue here with the reproduction and we will work it out.

For anything non-trivial, open an issue before writing code.

## Setup

You need [Bun](https://bun.sh) 1.3.14 or newer and [Docker](/GUIDES.md#docker).
**Node.js, npm, pnpm and nvm are not used** — if a command in this file starts with any
of them, it is a bug in the file.

```bash
git clone https://github.com/SashaGoncharov19/dokploy-bun.git
cd dokploy-bun
bun install
cp apps/dokploy/.env.example apps/dokploy/.env
```

Branch from `canary`. It is the default branch and where every pull request lands.
`main` is the stable channel and is fast-forwarded to `canary` at release time, so you
should never need to target it directly — only urgent `hotfix/` branches do. See
[docs/BRANCHING.md](docs/BRANCHING.md).

Then bring up Postgres, Traefik, the Docker network and the schema:

```bash
bun run dokploy:setup
```

This one talks to Docker for real — it initialises Swarm, creates the `dokploy-network`
overlay, pulls and starts Traefik, and runs the migrations. Docker has to be running.

In development it keeps its state in `apps/dokploy/.docker/`, not in `/etc/dokploy`;
that switch is on `NODE_ENV` (`packages/server/src/constants/index.ts`). Worth knowing
before you go looking for a config file in the wrong place, and worth remembering if you
write a test that deletes a directory — the same path resolution decides whether the
test wipes a fixture or your machine.

Now start the dev server:

```bash
bun run dokploy:dev
```

Open http://localhost:3000.

> [!NOTE]
> This project uses Biome. If your editor is set to Prettier, either point it at Biome
> or turn it off — otherwise your first save will reformat files you did not intend to
> touch, which matters more here than in most repositories. See
> [Fork discipline](#fork-discipline).

## Development

| Task | Command |
|---|---|
| dev server | `bun run dokploy:dev` |
| typecheck everything | `bun run --filter '*' typecheck` |
| build everything | `bun run build` |
| format and lint | `bun run check` |
| tests | `bun run test` |
| regenerate the OpenAPI spec | `bun run generate:openapi` |
| one workspace only | `bun run --filter <pkg> <script>` |

**A green build does not mean the types are fine, and a green typecheck does not mean it
builds.** `bun build` does not typecheck at all, and `tsc` resolves imports through
tsconfig `paths` that the bundler does not use. Run both before you open a pull request.

If you edited any `package.json`, run `bun install` and commit `bun.lock` in the same
commit. CI installs with `--frozen-lockfile` and a stale lockfile fails it immediately.

Adding a dependency with a native postinstall — anything in the `ssh2`, `sharp`,
`better-sqlite3` family — means adding it to `trustedDependencies` in the root
`package.json` in that same commit. Bun does not run install scripts for packages
missing from that list, so the package installs cleanly and then fails at runtime.

Never hand-write a Drizzle migration:

```bash
bun run --filter dokploy migration:generate
```

Never edit `openapi.json` by hand either; `bun run generate:openapi` produces it.

### Resetting a password

```bash
bun run --filter dokploy build
bun run --filter dokploy reset-password
```

That resets the owner's password. To reset a specific user instead, pass their
email; either way the new random password is printed to the console:

```bash
bun run --filter dokploy reset-password user@example.com
```

The build is required — the script runs from `dist/`.

### Testing webhooks locally

```bash
bunx localtunnel --port 3000
```

### Deploying an app from your dev instance

Nixpacks, Railpack and Buildpacks are separate binaries. Install whichever build method
you plan to exercise:

```bash
# Nixpacks
curl -sSL https://nixpacks.com/install.sh -o install.sh && chmod +x install.sh && ./install.sh

# Railpack
curl -sSL https://railpack.com/install.sh | sh

# Buildpacks
curl -sSL "https://github.com/buildpacks/pack/releases/download/v0.39.1/pack-v0.39.1-linux.tgz" \
  | tar -C /usr/local/bin/ --no-same-owner -xzv pack
```

If Docker gives you permission errors:

```bash
sudo chown -R $(whoami) ~/.docker
```

## Tests

```bash
bun run test
```

That runs **two** runners, and the split is deliberate rather than accidental: most
directories have been ported to `bun test`, and the rest are still on vitest while the
migration finishes.

- The ported directories are listed in `test:bun` in `apps/dokploy/package.json`.
- `__test__/vitest.config.ts` excludes exactly those directories.

The two lists must stay complementary. Porting a directory means moving it from one to
the other — moving it out of the vitest exclude list without adding it to `test:bun`
makes the tests silently stop running in both.

Write new tests for `bun test`, importing from `bun:test`. Leave existing vitest tests
alone unless you are deliberately porting that directory, and if you are, read the
porting rules in [CLAUDE.md](CLAUDE.md#tests) first — `vi.mock` → `mock.module` is not
a rename, and the four differences that bite are all written down there.

Some tests in `__test__/deploy` clone real repositories and drive a real Docker Swarm.
They fail on a machine with no network access or an uninitialised Swarm; that is the
environment, not your change.

**Test what you changed by breaking it.** A test that passes against deliberately broken
source proves nothing. This applies with particular force to ported tests, where a mock
that quietly stopped applying looks exactly like a test that passes.

## Fork discipline

This is the part that is specific to this repository, and the part most likely to get a
pull request sent back.

Upstream still ships releases and we still merge them. Every line changed in a file
upstream also maintains is a merge conflict in every future sync — permanently. So:

- **No repo-wide renames.** 590 files mention "dokploy". Renaming them makes every
  future upstream merge conflict in every file touched.
- **No reformatting a file you are not otherwise changing.** A whitespace-only diff is
  invisible in review and fatal to `git merge`.
- **Diverge in files we own** rather than editing upstream logic in place. Prefer
  changing one constant or one export over rewriting a function.
- **Never push to the `upstream` remote.** Its push URL is set to `DISABLED` on purpose.

The full reasoning, including which kinds of divergence are worth their merge cost, is
in [docs/FORK-STRATEGY.md](docs/FORK-STRATEGY.md). The conventions for day-to-day work
are in [CLAUDE.md](CLAUDE.md).

## Commits and branches

Branch names follow [docs/BRANCHING.md](docs/BRANCHING.md): `<type>/<slug>`, lowercase
kebab-case, e.g. `feat/wildcard-domains` or `fix/2451-terminal-resize`.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>[optional scope]: <description>

[optional body]
```

`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
`revert` — matching the branch type.

```
feat: add wildcard domain support
fix(terminal): sync PTY size with frontend
chore(deps): bump bun to 1.4.0
```

Pull requests are squash-merged, so the **pull request title and description** become
the commit message on `canary`. Write them as the real explanation of the change;
individual commit messages on your branch will not survive the merge.

## Pull requests

- Target `canary`.
- One coherent change per pull request. Splitting an unrelated cleanup into its own PR
  costs you a minute and saves the reviewer far more.
- **Test your own change before submitting.** Say in the description what you ran and
  what you observed. Untested pull requests are rejected — not to be unwelcoming, but
  because verifying someone else's unverified change is the most expensive thing a
  reviewer can be asked to do.
- Include a screenshot or a short recording for anything user-visible.
- Link the issue it closes (`Closes #123`).
- Say what you measured, if the change claims to be faster or smaller. This fork's whole
  argument is evidence; a performance claim without a number cannot be reviewed.
- Avoid pull requests that are only whitespace, IDE formatting, or unused-variable
  removal. In a fork those are not free — see [Fork discipline](#fork-discipline).

Thank you for contributing.
