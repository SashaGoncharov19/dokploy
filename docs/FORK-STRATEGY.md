# Fork strategy — owning this codebase while still absorbing upstream

## Why this fork exists

Not a hostile fork. Upstream's author is reluctant to move Dokploy to Bun — a reasonable
position for someone responsible for other people's production deployments. This fork
exists to **find out whether that fear is justified, and to produce evidence either way**.

That purpose changes what "good" looks like here in three ways:

**Evidence is the deliverable.** Benchmarks, spike results, and a record of what broke
matter more than the diff itself. See [bun-migration/SPIKE-RESULTS.md](bun-migration/SPIKE-RESULTS.md).

**Honesty about failures is the argument, not a weakness in it.** "Everything works out
of the box" is not persuasive to a careful maintainer — he will find the one thing that
does not and stop listening. "`node-pty` dies 8ms after spawn under Bun, reproduced on
macOS and Linux with Node as a control, and here is the native `Bun.Terminal` replacement
that passes the identical test" is persuasive, because it shows the work was done by
someone looking for problems rather than around them. Keep the failure register current
and prominent.

**The ideal outcome is upstream taking this work, not permanent divergence.** So the
migration is structured as small, independently reviewable phases against upstream's
existing structure — one phase, one PR — and the de-licensing track is kept in
**separate branches from the Bun work**. Upstream will never merge a change that removes
their licensing; entangling the two commits makes the Bun migration unofferable.

## The maintenance tension

Two goals that pull against each other:

1. **This is ours.** Our identity, our decisions, our release cadence.
2. **Upstream updates still land cleanly.** Dokploy keeps shipping; we want their fixes.

The instinct is to rebrand everything and be done. That is exactly the move that
destroys goal 2. **590 files in this repo mention "dokploy".** Renaming them turns every
future merge into a conflict in every file we touched, forever, and the cost compounds
with each upstream release.

The resolution is not *how much* you diverge but **where**. Diverge in a small number of
files you fully own; leave everything else byte-identical to upstream so git can merge it
without asking.

---

## The four rules

### 1. Never mass-edit an upstream file

No repo-wide renames. No reformatting. No import reordering. No "while I'm here"
cleanups. Every line you change in a file upstream also changes is a future conflict you
volunteered for.

This includes formatting: do not point a differently-configured Biome at upstream files.
A whitespace-only reformat is invisible to you and catastrophic to `git merge`.

### 2. Diverge in files you own outright

New behavior goes in new files, in directories upstream does not use. Then the merge is
"upstream added files, we added files" — which git resolves silently.

When you must change upstream behavior, prefer the smallest possible hook: change one
constant, one export, one config value, rather than editing the logic in place.

### 3. Centralize identity behind constants

Do **not** find-and-replace "Dokploy" across 590 files. Instead put the strings in one
module and reference it. Then rebranding is a one-file change, and upstream's 590 files
stay mergeable.

Values that carry identity and are worth centralizing:

- product name, description, support/docs URLs, meta titles
- the `/etc/dokploy` base path (`packages/server/src/constants/index.ts:99`)
- the `dokploy-network` overlay network name
- the `dokploy/dokploy` Docker image name
- the license-server URL (removed entirely by the de-licensing track)

⚠️ **The infra names are not cosmetic.** `/etc/dokploy` and `dokploy-network` exist on
every deployed host and inside running containers. Renaming them is a **data and
downtime migration**, not a rebrand — existing installs have state at those paths and
containers attached to that network. Change them only with a migration path, or leave
them alone and rebrand only what users see.

### 4. Generated files get merge drivers, not merge conflicts

`bun.lock`, `openapi.json`, and drizzle snapshots conflict constantly and are never
worth hand-merging. Regenerate them instead — see `.gitattributes` below.

---

## The `/proprietary` problem

`LICENSE.MD` splits this repo in two:

- Everything **outside** `/proprietary` directories: **Apache-2.0**. Fork it, rebrand it,
  redistribute it, sell it. No constraints that matter here.
- Everything **inside** a `/proprietary` directory: **DSAL 1.0** (`LICENSE_PROPRIETARY.md`).

Three such directories exist:

```
apps/dokploy/components/proprietary
apps/dokploy/server/api/routers/proprietary
packages/server/src/services/proprietary
```

The DSAL grants copying and modification **for development and testing**, and withholds
the rest. Its plain text: production use requires *"a valid commercial agreement from
Dokploy"*, and it is *"forbidden to copy, merge, publish, distribute, sublicense, and/or
sell the Software."*

**Status: terms for this fork are settled separately with upstream.** On that basis the
fork keeps the proprietary code and proceeds with the de-licensing track
([PLAN.md §12](bun-migration/PLAN.md)).

Anyone reading this repository sees only the DSAL text, which says something narrower.
If that gap ever needs to be visible — for a contributor, a deployment review, or a
downstream user — the place to record it is a `LICENSE_EXCEPTION.md` written with
upstream's agreement, not this document.

### What it would take to remove it instead

Recorded because the option was considered and the cost turned out to be much higher
than a first look suggests. **Not the current plan.**

It is 30 files and **7,770 lines**, not the ~2,000 a top-level file listing implies —
the UI subdirectories carry 5,725 of them:

| Area | Lines |
|---|---|
| SSO (OIDC, SAML, SCIM, forward-auth) | ~2,900 |
| Custom roles / RBAC | ~1,500 |
| Audit log | ~900 |
| White-labeling | ~750 |
| License key | ~540 |
| Social sign-in + signup showcase | ~320 |

And the coupling is deep rather than peripheral — **25 non-proprietary files** import
from these directories, including `packages/server/src/index.ts` (the barrel export),
`lib/auth.ts`, `services/permission.ts`, `services/server.ts`, `services/git-provider.ts`,
`apps/dokploy/server/api/root.ts`, and the app shell (`pages/_app.tsx`, `index.tsx`,
`register.tsx`).

Deleting the directories does not remove a feature module; it breaks authentication,
permission resolution, and access control. Any removal would be a refactor of the core,
not a deletion.

Note also that the `/proprietary` boundary is a **directory convention, not a functional
one**. `auth/sign-in-with-github.tsx` is a plain better-auth OAuth call with nothing
enterprise about it, and `services/proprietary/sso.ts` mixes real SSO logic with generic
helpers (`requestToHeaders`, `normalizeTrustedOrigin`, `getOrganizationOwnerId` — the
last of which `hasValidLicense` depends on). Anyone reasoning about "the proprietary
part" as a clean unit will be wrong.

*This is a plain reading of the license text, not legal advice.*

---

## Git topology

```
upstream  https://github.com/Dokploy/dokploy.git   (fetch only, push = DISABLED)
origin    https://github.com/SashaGoncharov19/dokploy-bun.git
```

Branches:

| Branch | Role |
|---|---|
| `vendor/upstream` | Pristine mirror of `upstream/canary`. **Never commit here.** |
| `canary` | Our default. All normal work merges here. |
| `main` | Our stable line. |
| `upstream/sync-<version>` | Short-lived integration branch for one upstream merge. |

`vendor/upstream` exists so upstream's history enters our repo through exactly one door.
It makes "what did upstream actually change?" a single readable diff instead of an
archaeology exercise.

The push URL for `upstream` is deliberately set to `DISABLED`. Nothing we do should ever
write to Dokploy's repository, and a broken push is a much better outcome than a
successful one.

### One-time setup

```bash
git remote add upstream https://github.com/Dokploy/dokploy.git
git remote set-url --push upstream DISABLED
git fetch upstream --tags
git branch vendor/upstream upstream/canary
```

---

## Absorbing an upstream release

```bash
# 1. refresh the mirror — fast-forward only, it must never diverge
git fetch upstream --tags
git checkout vendor/upstream
git merge --ff-only upstream/canary

# 2. see what actually changed before merging anything
git log --oneline canary..vendor/upstream
git diff --stat canary..vendor/upstream

# 3. integrate on a throwaway branch, never directly on canary
git checkout canary
git checkout -b upstream/sync-v0.31.0
git merge vendor/upstream

# 4. resolve, regenerate, verify
bun install                      # regenerate bun.lock rather than merging it
bun run --filter '*' typecheck
bun run test

# 5. PR into canary
```

**Never merge upstream straight into `canary`.** The sync branch is what makes a bad
merge abandonable.

### When conflicts cluster

Conflicts concentrating in the same files every release is a signal, not bad luck — it
means we diverged in a file upstream actively develops. Fix the *shape*: move our change
into a file we own and reduce the upstream file to a hook. Ten minutes of that saves the
same conflict every release thereafter.

---

## `.gitattributes`

Generated artifacts should be regenerated on conflict, never hand-merged:

```gitattributes
bun.lock            merge=ours linguist-generated=true
openapi.json        merge=ours linguist-generated=true
apps/dokploy/drizzle/meta/**  merge=ours linguist-generated=true
```

`merge=ours` needs the driver registered once per clone:

```bash
git config merge.ours.driver true
```

Then regenerate deliberately after every sync: `bun install`,
`bun run generate:openapi`.

⚠️ **Drizzle migrations are the exception that will bite.** `merge=ours` on
`drizzle/meta/**` keeps *our* snapshot and discards upstream's — which is right for the
snapshot but **not** for the migration SQL. If upstream added migrations, those `.sql`
files must be taken and renumbered, or the schema silently diverges from the journal.
Always review `apps/dokploy/drizzle/*.sql` by hand during a sync.

---

## What "ours" should mean

Ranked by value-per-unit-of-merge-pain:

| Change | Merge cost | Verdict |
|---|---|---|
| Own Docker images, registry, release cadence | none | **do it** |
| Own CI/CD workflows | low — upstream rarely touches ours | **do it** |
| Own docs, README, issue templates | none | **do it** |
| Product name/branding behind constants | low | **do it** |
| Unlock `/proprietary` features (permission granted) | low — gates only | **doing it** |
| Rewriting `/proprietary` from scratch | very high — 7,770 lines, 25 coupled files | **not needed** |
| Bun toolchain migration | moderate, one-time | **doing it** |
| Renaming `/etc/dokploy`, `dokploy-network` | high + data migration | **only with a migration** |
| Renaming npm packages (`@dokploy/server`) | high — touches every import | **not worth it** |
| Repo-wide "dokploy" → new name | catastrophic — 590 files | **never** |

The last row is the one worth internalizing. A fork stays healthy by being *boringly
similar* to upstream everywhere it does not care, so it can be aggressively different
in the few places it does.
