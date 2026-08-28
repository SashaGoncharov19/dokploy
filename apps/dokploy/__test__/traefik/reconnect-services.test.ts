import {
	afterAll,
	beforeEach,
	describe,
	expect,
	it,
	jest,
	mock,
} from "bun:test";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import { createDbMock } from "../db-mock";

// Snapshot before mocking: `mock.module` is process-global and has no
// `importActual`, so the restores at the bottom put the originals back.
const actualExecProcess = { ...execProcess };

const findManyMock = jest.fn();
const execAsyncMock = jest.fn();
const execAsyncRemoteMock = jest.fn();

mock.module("@dokploy/server/db", () => ({
	db: {
		query: {
			compose: {
				findMany: findManyMock,
			},
		},
	},
}));

mock.module("@dokploy/server/utils/process/execAsync", () => ({
	...actualExecProcess,
	execAsync: execAsyncMock,
	execAsyncRemote: execAsyncRemoteMock,
}));

const { reconnectServicesToTraefik } = await import(
	"@dokploy/server/services/settings"
);

describe("reconnectServicesToTraefik", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		findManyMock.mockResolvedValue([]);
	});

	it("does not execute an empty local command when no isolated deployments exist", async () => {
		await reconnectServicesToTraefik();

		expect(execAsyncMock).not.toHaveBeenCalled();
	});

	it("does not execute an empty remote command when no isolated deployments exist", async () => {
		await reconnectServicesToTraefik("server-id");

		expect(execAsyncRemoteMock).not.toHaveBeenCalled();
	});

	it("reconnects isolated deployments to the local Traefik network", async () => {
		findManyMock.mockResolvedValue([
			{ appName: "first-compose" },
			{ appName: "second-compose" },
		]);

		await reconnectServicesToTraefik();

		expect(execAsyncMock).toHaveBeenCalledTimes(1);
		expect(execAsyncMock).toHaveBeenCalledWith(
			'docker network connect first-compose $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1\n' +
				'docker network connect second-compose $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1\n',
		);
		expect(execAsyncRemoteMock).not.toHaveBeenCalled();
	});

	it("reconnects isolated deployments on a remote server", async () => {
		findManyMock.mockResolvedValue([{ appName: "remote-compose" }]);

		await reconnectServicesToTraefik("server-id");

		expect(execAsyncRemoteMock).toHaveBeenCalledTimes(1);
		expect(execAsyncRemoteMock).toHaveBeenCalledWith(
			"server-id",
			'docker network connect remote-compose $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1\n',
		);
		expect(execAsyncMock).not.toHaveBeenCalled();
	});
});

afterAll(() => {
	mock.module("@dokploy/server/db", () => createDbMock(jest.fn));
	mock.module(
		"@dokploy/server/utils/process/execAsync",
		() => actualExecProcess,
	);
});
