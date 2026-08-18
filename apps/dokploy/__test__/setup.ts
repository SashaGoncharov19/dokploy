import { vi } from "vitest";

/**
 * Installed via vitest's `setupFiles`. See ./db-mock.ts for why the mock exists
 * and for the bun-side counterpart.
 *
 * The factory is imported dynamically because `vi.mock` is hoisted above the
 * import statements, so a top-level binding would not be initialised yet.
 */
vi.mock("@dokploy/server/db", async () => {
	const { createDbMock } = await import("./db-mock");
	return createDbMock(vi.fn);
});
