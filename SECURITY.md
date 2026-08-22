# Security Policy

This repository is a runtime fork of [Dokploy](https://github.com/Dokploy/dokploy).
Where you report a vulnerability depends on which side of that line it falls on, and
getting it right matters: a report sent only to us cannot be fixed for the thousands of
people running upstream's build, and a report sent only upstream cannot be fixed if the
flaw exists only in our Bun-specific code.

## Where to report

**If the vulnerability is in Dokploy itself** — the application, its authentication,
Traefik configuration, deployment logic, API — it almost certainly affects upstream too.
Report it to upstream at [contact@dokploy.com](mailto:contact@dokploy.com). Please tell
us as well, so we can carry the fix into this fork rather than discovering it on the
next sync.

**If the vulnerability is specific to this fork** — the Bun runtime swap, our images
(`ghcr.io/sashagoncharov19/dokploy-bun`), our `install.sh`, our CI, or the removal of
license gating — report it here, privately, through
[GitHub Security Advisories](https://github.com/SashaGoncharov19/dokploy-bun/security/advisories/new).

If you cannot tell which it is, report it to both. Duplicated effort is cheap; a
vulnerability sitting unfixed in the wrong tracker is not.

**Do not open a public issue for a security report**, and do not include a working
exploit in one.

## What to include

- What the vulnerability is, and what an attacker can do with it.
- Steps to reproduce it, as concretely as you can manage.
- The version or image tag you tested, and whether you reproduced it on upstream's
  build as well — this is the single most useful thing you can tell us, because it
  decides who has to fix it.
- Sample code, screenshots or a recording, if they help.

## What we ask of you

- Give us a reasonable chance to fix it before disclosing publicly.
- Do not access data or systems beyond what is needed to demonstrate the issue.
- No denial-of-service testing, spamming, or social engineering.
- Do not modify or destroy data that is not yours.

## What you can expect

We will acknowledge your report and keep you informed as we work through it. How long a
fix takes depends on severity and on whether it needs to come from upstream — if it
does, we will say so rather than leave you waiting.

This fork is maintained by one person as an evidence-gathering project, not a company
with a security team. We would rather tell you that plainly than imply a response time
we cannot commit to.
