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
| `hotfix/` | urgent production fix, branched from `main` |
| `release/` | release preparation, e.g. `release/v0.31.0` |
| `upstream/` | **reserved** — importing or merging upstream Dokploy changes |

`upstream/` is never used for our own work. Seeing it in a PR title means the diff is
mostly someone else's code and should be reviewed as an integration, not as a change —
see [FORK-STRATEGY.md](FORK-STRATEGY.md).

## Base branches

Inherited from the upstream project, unchanged:

- **`canary`** — default branch. All normal work targets this.
- **`main`** — stable. Only `hotfix/` and `release/` branches target it.
- **`vendor/upstream`** — protected mirror of upstream. Never commit here, never
  branch feature work from it.

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
