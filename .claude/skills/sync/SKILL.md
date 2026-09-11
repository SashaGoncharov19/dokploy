---
name: sync
description: Sync this fork with upstream Dokploy and with origin - fetch, merge upstream/canary into canary, resolve the conflicts this fork always produces, verify, and open the PR. Use when the user says sync, синхронізація, "підтягни апстрім", "змержи апстрім", or asks to catch up with Dokploy's changes.
---

# Syncing the fork

One command's worth of work: get `canary` current with both `origin` and
`upstream/canary`, land it as a reviewed PR, and leave `main` alone unless asked.

**Never push to `upstream`.** Its push URL is set to `DISABLED` on purpose.

## 0. Check the account first

`gh` silently switches accounts, and the failure surfaces much later as
`must be a collaborator (createPullRequest)` after all the work is done.

```bash
gh auth status | grep -B1 "Active account: true"
gh auth switch --user SashaGoncharov19   # if it is not already
```

## 1. Survey before touching anything

```bash
git fetch origin && git fetch upstream
git rev-list --left-right --count origin/canary...canary   # local vs origin
git rev-list --count origin/canary..upstream/canary        # how far behind upstream
git rev-list --count origin/main..origin/canary            # canary ahead of main
gh pr list --repo SashaGoncharov19/dokploy-bun --state open
```

**Land open green PRs first.** Merging upstream on top of an open branch forces
a rebase later. Check CI, merge, then pull.

## 2. Merge on a branch, never on canary directly

```bash
git checkout -B upstream/merge-$(date +%F) origin/canary
git merge upstream/canary --no-edit
```

The branch name has a reserved prefix - see `docs/BRANCHING.md`.

## 3. The two conflicts this fork always produces

**`apps/dokploy/package.json` - version.** The scheme is
`<upstream-version>-bun.<n>`. Upstream `v0.30.2` against our `v0.30.0-bun.1`
becomes **`v0.30.2-bun.1`**. Do not pick a side; combine them.

**Ported test files.** Anything under `__test__/` that has moved to `bun:test`
will conflict with upstream's `vi.*`. Resolve as **our runner plus their
change** - keep `jest.fn`/`mock.module`, take their new mocks and assertions.

## 4. The trap that has no conflict marker

Upstream's *non-conflicting* additions to a ported test file merge cleanly and
still reference `vi.*`, which does not exist under `bun:test`. Git says nothing.
The tests fail with `ReferenceError: vi is not defined`.

**After every merge that touches `__test__/`:**

```bash
grep -rn --exclude=remote-stream.test.ts "\bvi\.\|from \"vitest\"" apps/dokploy/__test__/{logs,registry,requests,api,cluster,templates,backups,services,utils,queues,drop,traefik,server,permissions,wss,dns,compose,git-provider,deploy} 2>/dev/null
```

Anything it prints in a ported directory is a silent breakage. Convert it:
`vi.fn` → `jest.fn`, `vi.mock` → `mock.module`, `vi.clearAllMocks` →
`jest.clearAllMocks`. `env` is the one directory still on vitest - `vi.*` there
is correct - and `utils/remote-stream.test.ts` is the one file: when a piped-child
test's promise never settles, `bun test` spins instead of timing out (see
CLAUDE.md, Tests), so `utils` is listed per file in both runner lists. Do not port it.

## 5. Verify, then open the PR

```bash
bun install                      # if any package.json changed
bun run --filter '*' typecheck
cd apps/dokploy && bun run test:bun && bun run test:vitest
```

Four failures in `deploy/application.real.test.ts` are expected locally - they
need Docker swarm and nixpacks, which CI installs and a dev machine usually does
not. Anything else is real. Compare counts against the previous run: upstream
often adds tests, so a rising total is normal and a falling one is not.

Open the PR describing **what conflicted and how it was resolved**, not just
that a merge happened. Wait for green CI, then merge.

## 6. Only if asked

`main` is the stable channel. Fast-forwarding it publishes `latest` and a
version tag, which changes what users' update button offers. That is a release
decision, not part of a sync - confirm before doing it.
