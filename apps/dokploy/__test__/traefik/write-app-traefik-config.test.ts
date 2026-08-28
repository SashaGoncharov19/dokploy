import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
	mock,
	spyOn,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as execProcess from "@dokploy/server/utils/process/execAsync";

// Snapshot before mocking: `mock.module` is process-global and has no
// `importActual`, so the restore at the bottom puts the original back.
const actualExecProcess = { ...execProcess };

const execAsyncRemoteMock = jest.fn();

mock.module("@dokploy/server/utils/process/execAsync", () => ({
	...actualExecProcess,
	execAsyncRemote: execAsyncRemoteMock,
}));

const { writeAppTraefikConfig } = await import(
	"@dokploy/server/utils/traefik/application"
);

describe("writeAppTraefikConfig", () => {
	let cwd: string;
	let dynamicPath: string;
	let cwdSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		jest.clearAllMocks();
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-traefik-"));
		dynamicPath = path.join(cwd, ".docker", "traefik", "dynamic");
		fs.mkdirSync(dynamicPath, { recursive: true });
		cwdSpy = spyOn(process, "cwd").mockReturnValue(cwd);
	});

	afterEach(() => {
		cwdSpy.mockRestore();
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	// Regression test for #5189: Traefik's file provider rejects a standalone
	// `routers: {}` / `services: {}` map and aborts its watcher for every
	// dynamic config once it hits one, so an app with no domains must never
	// get an on-disk config file at all.
	it("removes the file instead of writing empty routers/services", async () => {
		const appName = "no-domain-app";
		const configPath = path.join(dynamicPath, `${appName}.yml`);
		fs.writeFileSync(configPath, "stale content", "utf8");

		await writeAppTraefikConfig(
			{ http: { routers: {}, services: {} } },
			appName,
		);

		expect(fs.existsSync(configPath)).toBe(false);
	});

	it("writes the file when routers/services are present", async () => {
		const appName = "with-domain-app";
		const configPath = path.join(dynamicPath, `${appName}.yml`);

		await writeAppTraefikConfig(
			{
				http: {
					routers: {
						[`${appName}-router-1`]: {
							rule: "Host(`x`)",
							service: `${appName}-service-1`,
						},
					},
					services: {},
				},
			},
			appName,
		);

		expect(fs.existsSync(configPath)).toBe(true);
	});

	it("removes the remote file instead of writing empty routers/services", async () => {
		execAsyncRemoteMock.mockResolvedValue({ stdout: "", stderr: "" });

		await writeAppTraefikConfig(
			{ http: { routers: {}, services: {} } },
			"no-domain-app",
			"server-id",
		);

		expect(execAsyncRemoteMock).toHaveBeenCalledTimes(1);
		const [, command] = execAsyncRemoteMock.mock.calls[0] ?? [];
		expect(command).toMatch(/^rm -f /);
		expect(command).toContain("no-domain-app.yml");
	});

	it("writes the remote file when routers/services are present", async () => {
		execAsyncRemoteMock.mockResolvedValue({ stdout: "", stderr: "" });

		await writeAppTraefikConfig(
			{
				http: {
					routers: {
						"with-domain-app-router-1": {
							rule: "Host(`x`)",
							service: "with-domain-app-service-1",
						},
					},
					services: {},
				},
			},
			"with-domain-app",
			"server-id",
		);

		expect(execAsyncRemoteMock).toHaveBeenCalledTimes(1);
		const [, command] = execAsyncRemoteMock.mock.calls[0] ?? [];
		expect(command).toMatch(/^echo /);
	});
});

afterAll(() => {
	mock.module(
		"@dokploy/server/utils/process/execAsync",
		() => actualExecProcess,
	);
});
