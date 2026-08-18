import { afterAll, describe, expect, it, jest, mock } from "bun:test";
import { getBuildComposeCommand } from "@dokploy/server/utils/builders/compose";
import * as domainModule from "@dokploy/server/utils/docker/domain";

// Compose now has a `createEnvFile` toggle (default true), mirroring the
// Application builder's flag: when disabled, Dokploy never writes `.env`,
// so a repo-tracked file survives untouched.
// Snapshot and restore: `mock.module` is process-global, so without the
// `afterAll` this stub replaces `writeDomainsToCompose` for every later file in
// the same `bun test` run - which is exactly how it broke
// domain-command-injection.test.ts, whose assertions depend on the real one.
const actualDomain = { ...domainModule };
mock.module("@dokploy/server/utils/docker/domain", () => ({
	...actualDomain,
	writeDomainsToCompose: jest.fn().mockResolvedValue(""),
}));

afterAll(() => {
	mock.module("@dokploy/server/utils/docker/domain", () => actualDomain);
});

const baseCompose = {
	appName: "env-file-toggle",
	sourceType: "raw",
	command: "",
	composePath: "docker-compose.yml",
	composeType: "docker-compose",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
	serverId: null,
	env: "FOO=bar",
	mounts: [],
	domains: [],
	environment: { project: { env: "" }, env: "" },
} as unknown as Parameters<typeof getBuildComposeCommand>[0];

describe("getBuildComposeCommand createEnvFile toggle", () => {
	it("createEnvFile: false never writes the .env file", async () => {
		const command = await getBuildComposeCommand({
			...baseCompose,
			createEnvFile: false,
		});

		expect(command).not.toContain("base64 -d >");
	});

	it("createEnvFile: true (default) writes Dokploy's vars", async () => {
		const command = await getBuildComposeCommand({
			...baseCompose,
			createEnvFile: true,
		});

		expect(command).toContain("base64 -d >");
	});
});
