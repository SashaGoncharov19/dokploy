-- Data migration, hand-written on purpose: drizzle-kit generates schema diffs and
-- cannot produce a backfill. No schema change here.
--
-- Enterprise licensing is being removed, which turns per-member server scoping ON
-- for everyone. getAccessibleServerIds previously branched on the licence:
--
--   unlicensed -> every server in the organization   (the permissive branch)
--   licensed   -> only member."accessedServers"      (the restrictive branch)
--
-- An instance that ran unlicensed never populated accessedServers, so unlocking the
-- feature without this backfill would drop every non-admin member to zero visible
-- servers. Seeding the column with the servers they can already see preserves
-- today's effective access exactly, and lets admins restrict from there.
--
-- Only rows that are still empty are touched, so a deliberate restriction that an
-- admin has already configured is never overwritten.
UPDATE "member" m
SET "accessedServers" = COALESCE(
        (
            SELECT array_agg(s."serverId")
            FROM "server" s
            WHERE s."organizationId" = m."organization_id"
        ),
        ARRAY[]::text[]
    )
WHERE cardinality(m."accessedServers") = 0;
