---
name: remove-enterprise-license
description: Remove enterprise license gating from Dokploy so all features (white-label, SSO, SCIM, custom roles, audit log, forward-auth) work without a license key. Use when unlocking enterprise/proprietary features, removing hasValidLicense or enterpriseProcedure checks, deleting the license-key service, router, cron or UI, or dropping the license columns. Covers the permission-semantics trap in getAccessibleServerIds.
---

# Removing enterprise licensing

Goal: every enterprise feature works with no license key, and nothing calls
`licenses-api.dokploy.com`.

**Read this first: this is not a no-op.** Three of the 14 gate call sites use the
license flag to pick between *different access-control behaviors*, and in one of them
the unlicensed branch is the **more permissive** one. Flipping the flag without the
mitigation in step 2 takes server visibility away from every non-admin member on a
running instance.

## The surface

**Predicate** — `hasValidLicense(organizationId)`,
`packages/server/src/services/proprietary/license-key.ts:10`. Reads two `user` columns:
`enableEnterpriseFeatures` and `isValidEnterpriseLicense`.

**14 call sites:**

| File | Line | Kind |
|---|---|---|
| `packages/server/src/services/server.ts` | 183 | ⚠️ access control |
| `packages/server/src/services/permission.ts` | 47 | ⚠️ access control |
| `packages/server/src/services/git-provider.ts` | 105 | ⚠️ access control |
| `packages/server/src/services/proprietary/whitelabeling.ts` | 27 | feature gate |
| `packages/server/src/services/proprietary/audit-log.ts` | 27 | feature gate |
| `packages/server/src/services/proprietary/license-key.ts` | 55 | feature gate |
| `apps/dokploy/server/api/trpc.ts` | 225 | `enterpriseProcedure` |
| `apps/dokploy/server/api/routers/server.ts` | 142 | feature gate |
| `apps/dokploy/server/api/routers/git-provider.ts` | 116 | feature gate |
| `apps/dokploy/server/api/routers/organization.ts` | 201 | feature gate |
| `apps/dokploy/server/api/routers/user.ts` | 478 | feature gate |
| `apps/dokploy/server/api/routers/proprietary/audit-log.ts` | 10 | feature gate |
| `apps/dokploy/server/api/routers/proprietary/license-key.ts` | 196 | feature gate |
| `apps/dokploy/server/api/routers/proprietary/whitelabeling.ts` | 22 | feature gate |

**`enterpriseProcedure`** (`apps/dokploy/server/api/trpc.ts:216`) gates the `sso`,
`scim`, `custom-role`, `forward-auth`, `settings`, and `whitelabeling` routers.

**Remote calls** — `apps/dokploy/server/utils/enterprise.ts` (validate/activate/
deactivate) and `packages/server/src/utils/crons/enterprise.ts` (`LICENSE_KEY_URL`,
plus a cron every 3 days that sets `isValidEnterpriseLicense = false` when validation
fails). **Delete the cron early** — leaving it running while removing gates means it
keeps flipping the flag off underneath you.

**UI** — `apps/dokploy/components/proprietary/enterprise-feature-gate.tsx`,
`components/proprietary/license-keys/license-key.tsx`,
`pages/dashboard/settings/license.tsx`, plus the license query in
`components/dashboard/settings/users/show-users.tsx:40`.

## Procedure

### Step 1 — Collapse the predicate (one small, revertible commit)

Make `hasValidLicense` return `true` unconditionally. Do **not** delete call sites yet.

This makes the whole change one line to revert while you verify behavior. Deleting
dead branches is a separate commit precisely because it is the irreversible half.

### Step 2 — ⚠️ Handle the access-control call sites

**`getAccessibleServerIds` — `packages/server/src/services/server.ts:183`**

```ts
const licensed = await hasValidLicense(activeOrganizationId);
if (!licensed) {
  return new Set(allOrgServers.map((s) => s.serverId));  // unlicensed: EVERY server
}
return new Set(memberRecord?.accessedServers ?? []);      // licensed: only assigned
```

Forcing `licensed = true` restricts non-admin members to `accessedServers`. On an
instance that ran unlicensed, that column is almost certainly empty for everyone — so
**every member-role user abruptly sees zero servers.**

**Required mitigation:** backfill `accessedServers` with all current org servers for
every existing member *before* the flag flips. That preserves today's effective access
exactly while turning the feature on. Ship the backfill as a drizzle migration in the
same release, not as a manual step someone is supposed to remember.

**`resolveRole` — `packages/server/src/services/permission.ts:47`**

Unlicensed returns `null` for non-static roles, making custom roles inert. Forcing
`true` activates every row in `organizationRole` at once. Audit that table first: a
half-configured role that was never live becomes live.

**`getAccessibleGitProviderIds` — `packages/server/src/services/git-provider.ts:105`**

Licensed is the wider branch here (adds assigned providers on top of owned + shared).
Only widens access — low risk, but note it in the PR.

### Step 3 — Verify before deleting anything

- Log in as a **member-role** user. Confirm the visible server list is identical to
  before. This is the check that catches the step-2 trap.
- Open white-label settings, SSO, SCIM, custom roles, audit log, forward-auth — all
  reachable, no "Valid enterprise license required".
- Confirm no outbound request to `licenses-api.dokploy.com`.

### Step 4 — Delete the dead code

Only once step 3 is green:

- `enterpriseProcedure` → make it a plain authenticated+role check (keep the
  `owner`/`admin` requirement — that is authorization, not licensing), or replace its
  usages with `protectedProcedure` where the role check is redundant.
- Remove the `if (!licensed)` branches at all 14 sites.
- Delete `apps/dokploy/server/utils/enterprise.ts`,
  `packages/server/src/utils/crons/enterprise.ts`, and the
  `initEnterpriseBackupCronJobs()` call in `apps/dokploy/server/server.ts:70`.
- Delete `apps/dokploy/server/api/routers/proprietary/license-key.ts` and unregister it
  from `apps/dokploy/server/api/root.ts`.
- Delete the license UI (above), and the `IS_CLOUD` whitelabeling blocks if cloud
  should support it too.
- Drop `hasValidLicense` and `hasAnyValidLicense`.

Search for stragglers:

```bash
grep -rn "hasValidLicense\|enterpriseProcedure\|isValidEnterpriseLicense\|enableEnterpriseFeatures\|LICENSE_KEY_URL" \
  --include="*.ts" --include="*.tsx" apps packages
```

Also check `packages/server/src/lib/auth.ts` (429–454, 590–591, 640–643) where the two
flags are threaded through the better-auth session, and
`apps/dokploy/server/api/routers/proprietary/sso.ts:32-45` which reads them directly
rather than through `hasValidLicense`.

### Step 5 — Database columns, later

Leave `enableEnterpriseFeatures` and `isValidEnterpriseLicense` in place for **at least
one release** after the gates come out. Dropping them destroys the license state and
makes rollback impossible. Schedule the drop as its own migration afterwards.

## Tests

`apps/dokploy/__test__/permissions/` covers `resolveRole` and permission resolution and
will need updating — several tests assert the *unlicensed* fallback. Do not delete a
failing assertion to make the suite pass; change it to assert the new intended behavior,
and make sure it still fails when the source is broken on purpose.

## Report

State explicitly whether the step-2 backfill shipped, and what a member-role user sees
before vs after. That is the finding that matters most to whoever deploys this.
