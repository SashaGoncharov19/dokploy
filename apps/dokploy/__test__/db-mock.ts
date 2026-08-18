/**
 * The stand-in for `@dokploy/server/db`, shared by both test runners.
 *
 * Tests that import from the `@dokploy/server` barrel pull in `lib/auth` and
 * `db`, which open a TCP connection to PostgreSQL on import. In CI there is no
 * database, so that surfaces as ECONNREFUSED before a single assertion runs.
 *
 * Both runners install this, and each has to do it its own way - vitest through
 * `setupFiles` and a hoisted `vi.mock`, bun through a `bunfig.toml` preload and
 * `mock.module`. The shape they install is this function, so it only exists in
 * one place.
 */
/** Both `vi.fn` and `jest.fn` satisfy this: they wrap an implementation and
 * hand back something callable. The precise mock type differs per runner and
 * nothing here depends on it. */
type AnyFn = (...args: never[]) => unknown;
type MockFn = (impl: AnyFn) => AnyFn;

export const createDbMock = (fn: MockFn) => {
	const chain = () => chain;
	chain.set = () => chain;
	chain.where = () => chain;
	chain.values = () => chain;
	chain.returning = () => Promise.resolve([{}]);
	chain.from = () => chain;
	chain.innerJoin = () => chain;
	chain.then = (resolve: (value: unknown) => void) => {
		resolve([]);
	};

	const tableMock = {
		findFirst: fn(() => Promise.resolve(undefined)),
		findMany: fn(() => Promise.resolve([])),
		insert: fn(() => Promise.resolve([{}])),
		update: fn(() => chain),
		delete: fn(() => chain),
	};

	return {
		db: {
			select: fn(() => chain),
			insert: fn(() => ({
				values: () => ({ returning: () => Promise.resolve([{}]) }),
			})),
			update: fn(() => chain),
			delete: fn(() => chain),
			query: new Proxy({} as Record<string, typeof tableMock>, {
				get: () => tableMock,
			}),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
};
