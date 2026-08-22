# Branch naming convention

One branch = one PR = one coherent change.

## Format

```
<type>/<slug>
<type>/<issue>-<slug>      # when an issue exists
```

Lowercase ASCII, kebab-case. The only `/` is the one after `<type>`. Keep the whole
name at or under 60 characters.

```
✅ feat/custom-domain-wildcards
✅ fix/2451-terminal-resize-desync
✅ chore/bun-migration
✅ upstream/sync-v0.31.0

❌ Feature/AddThing          uppercase, wrong type
❌ sasha/my-branch           personal names
❌ fix/bug                   says nothing
❌ feat/add-new-feature-for-the-dashboard-that-does-things   too long
❌ fix/terminal/resize       second slash
```

## Types

| Type | Use for |
|---|---|
| `feat/` | new user-visible functionality |
| `fix/` | bug fix |
| `refactor/` | restructuring with no behavior change |
| `perf/` | performance work |
| `chore/` | dependencies, tooling, config, migrations |
| `ci/` | pipelines and workflows |
| `docs/` | documentation only |
| `test/` | tests only |
| `hotfix/` | urgent production fix, branched from `main`, merged back into `canary` |
| `release/` | release preparation — bumping versions, changelog. Targets `canary`, because releases ship by fast-forwarding `main` to it |
| `upstream/` | **reserved** — importing or merging upstream Dokploy changes |

`upstream/` is never used for our own work. Seeing it in a PR title means the diff is
mostly someone else's code and should be reviewed as an integration, not as a change —
see [FORK-STRATEGY.md](FORK-STRATEGY.md).

## Base branches

Branch names are inherited from upstream; what they mean here is slightly different,
because this fork publishes its own releases.

- **`canary`** — default branch. All normal work targets this. It is also the
  **pre-release channel**: the `:canary` image and `-canary.N` tags are cut from it.
- **`main`** — the **stable channel**. `:latest` and the version tag are cut from it.
  It is not a branch you open pull requests against in the normal course of work — at
  release time it is **fast-forwarded** to the commit on `canary` that was released, so
  the two never diverge. Only `hotfix/` branches target it directly, and a hotfix must
  be merged back into `canary` immediately so the fast-forward stays possible.
- **`vendor/upstream`** — pristine local mirror of upstream. Never commit here, never
  branch feature work from it. See [FORK-STRATEGY.md](FORK-STRATEGY.md).

The fast-forward is what keeps `main` honest: if it ever refuses, `main` has commits
`canary` does not, and something was merged in the wrong place. Check before forcing it.

## Rules

- Branch from the branch you will target. `feat/*` from `canary`, `hotfix/*` from `main`.
- Delete the branch after merge.
- Rebase or merge `canary` into a long-lived branch rather than letting it drift.
- Never force-push a branch someone else may have pulled.
- Never push to `upstream` — the remote's push URL is set to `DISABLED` on purpose.
  If that ever fails, stop and re-read [FORK-STRATEGY.md](FORK-STRATEGY.md).

## Commits

Conventional Commits, matching the branch type:

```
feat: add wildcard domain support
fix(terminal): sync PTY size with frontend
chore(deps): migrate from pnpm to bun
```

For upstream integrations, say what was pulled in:

```
chore(upstream): merge Dokploy v0.31.0
```
