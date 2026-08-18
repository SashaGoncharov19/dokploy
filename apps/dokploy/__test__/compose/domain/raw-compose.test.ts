import { describe, expect, it, jest, mock } from "bun:test";
import { addDomainToCompose } from "@dokploy/server/utils/docker/domain";
import * as execAsyncModule from "@dokploy/server/utils/process/execAsync";

// Snapshot before mocking, then keep a handle on the replacement rather than
// reaching for it through `vi.mocked` afterwards.
const actualExecAsync = { ...execAsyncModule };
const execAsyncRemoteMock = jest.fn();

mock.module("@dokploy/server/utils/process/execAsync", () => ({
	...actualExecAsync,
	execAsyncRemote: execAsyncRemoteMock,
}));

describe("raw remote compose conversion (#4794)", () => {
	it("uses the saved raw source and preserves supported mount syntax", async () => {
		execAsyncRemoteMock.mockResolvedValue({
			stdout: "services:\n  test:\n    image: alpine:latest\n",
			stderr: "",
		});

		const compose = {
			appName: "raw-stack",
			composeFile: `
services:
  test:
    image: alpine:latest
    volumes:
      - type: tmpfs
        target: /scratch
      - type: volume
        source: test-data
        target: /data
    tmpfs:
      - /cache
volumes:
  test-data:
`,
			composePath: "./docker-compose.yml",
			composeType: "stack",
			isolatedDeployment: false,
			isolatedDeploymentsVolume: false,
			randomize: false,
			serverId: "remote-server",
			sourceType: "raw",
			suffix: "",
		} as unknown as Parameters<typeof addDomainToCompose>[0];

		const converted = await addDomainToCompose(compose, []);

		expect(converted?.services?.test?.volumes).toEqual([
			{ type: "tmpfs", target: "/scratch" },
			{
				type: "volume",
				source: "test-data",
				target: "/data",
			},
		]);
		expect(converted?.services?.test?.tmpfs).toEqual(["/cache"]);
		expect(execAsyncRemoteMock).not.toHaveBeenCalled();
	});
});
