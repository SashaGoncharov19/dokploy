## What is this PR about?

Describe in a short paragraph what this changes and why.

This repository squash-merges, so this title and description become the commit message
on `canary`. Write them as the real explanation of the change.

## How did you test it?

Say what you ran and what you observed. "Ran the test suite" is enough for a small
change; a deployment or runtime change needs more than that.

## Checklist

- [ ] Branched from `canary`, named per [BRANCHING.md](../docs/BRANCHING.md)
      (`<type>/<slug>`)
- [ ] Tested locally — see [CONTRIBUTING.md](../CONTRIBUTING.md#pull-requests)
- [ ] `bun run --filter '*' typecheck` and `bun run build` both pass
      (a green build says nothing about types, and vice versa)
- [ ] `bun run test` passes
- [ ] `bun.lock` committed, if any `package.json` changed
- [ ] No mass rename, reformat, or drive-by cleanup of upstream files —
      see [FORK-STRATEGY.md](../docs/FORK-STRATEGY.md)

## Issues related (if applicable)

Closes #

## Screenshots or measurements (if applicable)

For user-visible changes, a screenshot or recording. For anything claiming to be faster
or smaller, the numbers — a performance claim without a measurement cannot be reviewed.
