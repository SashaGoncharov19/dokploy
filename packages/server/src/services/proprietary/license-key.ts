import { db } from "@dokploy/server/db";
import {
	organization,
	organizationRole,
	user,
} from "@dokploy/server/db/schema";
import { and, eq } from "drizzle-orm";
import { getOrganizationOwnerId } from "./sso";

/**
 * Enterprise licensing is removed in this fork: every feature is available.
 *
 * Kept as a function returning true, rather than deleted outright, so this change
 * is one line to revert while the behaviour is being verified. The call sites and
 * the dead branches behind them come out separately - see
 * .claude/skills/remove-enterprise-license/SKILL.md.
 *
 * Note this is not purely a feature flag. Three callers use it to choose between
 * different access-control behaviours, and in getAccessibleServerIds the
 * unlicensed branch was the *permissive* one - hence migration 0186, which seeds
 * member."accessedServers" so nobody loses server visibility.
 */
export const hasValidLicense = async (_organizationId: string) => true;

export const resolveOrganizationDefaultRole = async (
	organizationId: string,
) => {
	const org = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
		columns: { defaultRole: true },
	});
	const defaultRole = org?.defaultRole;

	if (!defaultRole || defaultRole === "owner") {
		return "member";
	}

	if (defaultRole === "admin" || defaultRole === "member") {
		return defaultRole;
	}

	const customRole = await db.query.organizationRole.findFirst({
		where: and(
			eq(organizationRole.organizationId, organizationId),
			eq(organizationRole.role, defaultRole),
		),
		columns: { id: true },
	});

	if (!customRole || !(await hasValidLicense(organizationId))) {
		return "member";
	}

	return defaultRole;
};
