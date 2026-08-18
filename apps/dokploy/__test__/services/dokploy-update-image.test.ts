import { afterAll, describe, expect, it, jest, mock } from "bun:test";
import * as execAsyncModule from "@dokploy/server/utils/process/execAsync";

// Snapshot first: `mock.module` is process-global, so this has to be put back
// or it silences execAsync for every later file in the same run.
const actualExecAsync = { ...execAsyncModule };

const commands: string[] = [];
const execAsyncMock = jest.fn(async (command: string) => {
	commands.push(command);
	// `reloadDockerResource` probes the resource type through execAsync before
	// building the update command, and bails out if it is not "service".
	if (command.includes("docker service inspect")) {
		return { stdout: "service\n", stderr: "" };
	}
	return { stdout: "", stderr: "" };
});

mock.module("@dokploy/server/utils/process/execAsync", () => ({
	...actualExecAsync,
	execAsync: execAsyncMock,
}));

const { reloadDockerResource, getDokployImage } = await import(
	"@dokploy/server/services/settings"
);

afterAll(() => {
	mock.module("@dokploy/server/utils/process/execAsync", () => actualExecAsync);
});

describe("dokploy self-update image", () => {
	it("updates from this fork's registry, never upstream's", async () => {
		commands.length = 0;
		await reloadDockerResource("dokploy", undefined, "v9.9.9");

		const update = commands.find((c) => c.includes("docker service update"));
		expect(update).toBeDefined();
		expect(update).toContain(`--image ${getDokployImage()}:`);

		// The regression this guards: the update *check* was repointed at this
		// fork while the update *itself* still pulled dokploy/dokploy. That tag
		// exists upstream, so pressing Reload replaced this Bun build with
		// upstream's Node build instead of failing loudly.
		expect(update).not.toContain("dokploy/dokploy:");
	});
});
