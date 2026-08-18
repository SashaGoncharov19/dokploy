import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

const getWebServerSettings = jest.fn();
const findFirstServer = jest.fn();

mock.module("@dokploy/server/db", () => ({
	db: {
		query: {
			server: {
				findFirst: (...args: unknown[]) => findFirstServer(...args),
			},
		},
	},
}));

mock.module("@dokploy/server/db/schema", () => ({
	server: {},
}));

mock.module("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: (...args: unknown[]) => getWebServerSettings(...args),
}));

mock.module("drizzle-orm", () => ({ eq: jest.fn() }));

import { resolveBuildsConcurrency } from "../../server/queues/concurrency";
import { LOCAL_PARTITION } from "../../server/queues/in-memory-queue";

describe("resolveBuildsConcurrency", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe("local web server partition", () => {
		it("returns the configured concurrency", async () => {
			getWebServerSettings.mockResolvedValue({ buildsConcurrency: 5 });

			await expect(resolveBuildsConcurrency(LOCAL_PARTITION)).resolves.toBe(5);
		});

		it("does not cap high values", async () => {
			getWebServerSettings.mockResolvedValue({ buildsConcurrency: 999 });

			await expect(resolveBuildsConcurrency(LOCAL_PARTITION)).resolves.toBe(
				999,
			);
		});

		it("floors values below 1 to 1", async () => {
			getWebServerSettings.mockResolvedValue({ buildsConcurrency: 0 });

			await expect(resolveBuildsConcurrency(LOCAL_PARTITION)).resolves.toBe(1);
		});

		it("defaults to 1 when settings are missing", async () => {
			getWebServerSettings.mockResolvedValue(undefined);

			await expect(resolveBuildsConcurrency(LOCAL_PARTITION)).resolves.toBe(1);
		});
	});

	describe("remote server partition", () => {
		it("returns the server concurrency", async () => {
			findFirstServer.mockResolvedValue({ buildsConcurrency: 4 });

			await expect(resolveBuildsConcurrency("server-1")).resolves.toBe(4);
		});

		it("defaults to 1 for an unknown server", async () => {
			findFirstServer.mockResolvedValue(undefined);

			await expect(resolveBuildsConcurrency("ghost")).resolves.toBe(1);
		});
	});

	it("falls back to 1 if resolution throws", async () => {
		getWebServerSettings.mockRejectedValue(new Error("db down"));

		await expect(resolveBuildsConcurrency(LOCAL_PARTITION)).resolves.toBe(1);
	});
});
