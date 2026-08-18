import { afterAll, describe, expect, it, jest, mock } from "bun:test";
import { getBuildComposeCommand } from "@dokploy/server/utils/builders/compose";
import * as domainModule from "@dokploy/server/utils/docker/domain";

// Isolate the command builder from the compose-file I/O performed by
// writeDomainsToCompose; we only care about the docker invocation it emits.
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
	appName: "my-app",
	sourceType: "raw",
	command: "",
	composePath: "docker-compose.yml",
	composeType: "stack",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
	serverId: null,
	env: "",
	mounts: [],
	domains: [],
	environment: { project: { env: "" }, env: "" },
} as unknown as Parameters<typeof getBuildComposeCommand>[0];

// Regression coverage for #4401: the deploy command runs under `env -i`, which
// clears the environment except for the vars listed explicitly. HOME must be
// preserved so docker can resolve ~/.docker/config.json — otherwise
// `docker stack deploy --with-registry-auth` ships no credentials to the swarm
// and private-registry images fail to pull.
describe("getBuildComposeCommand registry auth (#4401)", () => {
	it("preserves HOME for swarm stack deploys", async () => {
		const command = await getBuildComposeCommand({
			...baseCompose,
			composeType: "stack",
		});

		expect(command).toContain("stack deploy");
		expect(command).toContain("--with-registry-auth");
		expect(command).toContain('env -i PATH="$PATH" HOME="$HOME"');
	});

	it("preserves HOME for docker compose deploys", async () => {
		const command = await getBuildComposeCommand({
			...baseCompose,
			composeType: "docker-compose",
		});

		expect(command).toContain("compose -p my-app");
		expect(command).toContain('env -i PATH="$PATH" HOME="$HOME"');
	});
});
