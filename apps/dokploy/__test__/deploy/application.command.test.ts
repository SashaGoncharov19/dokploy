import {
	afterAll,
	beforeEach,
	describe,
	expect,
	it,
	jest,
	mock,
} from "bun:test";
import * as adminService from "@dokploy/server/services/admin";
import * as applicationService from "@dokploy/server/services/application";
import { deployApplication } from "@dokploy/server/services/application";
import * as deploymentService from "@dokploy/server/services/deployment";
import * as rollbacksService from "@dokploy/server/services/rollbacks";
import * as builders from "@dokploy/server/utils/builders";
import * as buildError from "@dokploy/server/utils/notifications/build-error";
import * as notifications from "@dokploy/server/utils/notifications/build-success";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import * as gitProvider from "@dokploy/server/utils/providers/git";
import { createDbMock } from "../db-mock";

// Snapshot every module before mocking. `mock.module` has no `importActual`,
// and reading back through a namespace after mocking recurses into the mock.
// The restores at the bottom matter because `mock.module` is process-global.
const actual = {
	adminService: { ...adminService },
	applicationService: { ...applicationService },
	deploymentService: { ...deploymentService },
	rollbacksService: { ...rollbacksService },
	builders: { ...builders },
	buildError: { ...buildError },
	notifications: { ...notifications },
	execProcess: { ...execProcess },
	gitProvider: { ...gitProvider },
};

// Named handles instead of `vi.mocked(...)`, which bun:test has no equivalent
// for. Referencing these directly is also better typed than casting.
const findApplicationByIdMock = jest.fn();
const updateApplicationStatusMock = jest.fn();
const getDokployUrlMock = jest.fn();
const createDeploymentMock = jest.fn();
const updateDeploymentStatusMock = jest.fn();
const updateDeploymentMock = jest.fn();
const getGitCommitInfoMock = jest.fn();
const execAsyncMock = jest.fn();
const mechanizeDockerContainerMock = jest.fn();
const getBuildCommandMock = jest.fn();
const sendBuildSuccessNotificationsMock = jest.fn();
const sendBuildErrorNotificationsMock = jest.fn();
const createRollbackMock = jest.fn();
const applicationsFindFirstMock = jest.fn();

mock.module("@dokploy/server/db", () => {
	const createChainableMock = (): any => {
		const chain = {
			set: jest.fn(() => chain),
			where: jest.fn(() => chain),
			returning: jest.fn().mockResolvedValue([{}] as any),
			from: jest.fn(() => chain),
			innerJoin: jest.fn(() => chain),
			then: (resolve: (v: any) => void) => {
				resolve([]);
			},
		} as any;
		return chain;
	};

	return {
		db: {
			select: jest.fn(() => createChainableMock()),
			insert: jest.fn(),
			update: jest.fn(() => createChainableMock()),
			delete: jest.fn(),
			query: {
				applications: {
					findFirst: applicationsFindFirstMock,
				},
				patch: {
					findMany: jest.fn().mockResolvedValue([]),
				},
				member: {
					findMany: jest.fn().mockResolvedValue([]),
				},
			},
		},
	};
});

mock.module("@dokploy/server/services/application", () => ({
	...actual.applicationService,
	findApplicationById: findApplicationByIdMock,
	updateApplicationStatus: updateApplicationStatusMock,
}));

mock.module("@dokploy/server/services/admin", () => ({
	...actual.adminService,
	getDokployUrl: getDokployUrlMock,
}));

mock.module("@dokploy/server/services/deployment", () => ({
	...actual.deploymentService,
	createDeployment: createDeploymentMock,
	updateDeploymentStatus: updateDeploymentStatusMock,
	updateDeployment: updateDeploymentMock,
}));

mock.module("@dokploy/server/utils/providers/git", () => ({
	...actual.gitProvider,
	getGitCommitInfo: getGitCommitInfoMock,
}));

mock.module("@dokploy/server/utils/process/execAsync", () => ({
	...actual.execProcess,
	execAsync: execAsyncMock,
	ExecError: class ExecError extends Error {},
}));

mock.module("@dokploy/server/utils/builders", () => ({
	...actual.builders,
	mechanizeDockerContainer: mechanizeDockerContainerMock,
	getBuildCommand: getBuildCommandMock,
}));

mock.module("@dokploy/server/utils/notifications/build-success", () => ({
	...actual.notifications,
	sendBuildSuccessNotifications: sendBuildSuccessNotificationsMock,
}));

mock.module("@dokploy/server/utils/notifications/build-error", () => ({
	...actual.buildError,
	sendBuildErrorNotifications: sendBuildErrorNotificationsMock,
}));

mock.module("@dokploy/server/services/rollbacks", () => ({
	...actual.rollbacksService,
	createRollback: createRollbackMock,
}));

import { db } from "@dokploy/server/db";
import { cloneGitRepository } from "@dokploy/server/utils/providers/git";

const createMockApplication = (overrides = {}) => ({
	applicationId: "test-app-id",
	name: "Test App",
	appName: "test-app",
	sourceType: "git" as const,
	customGitUrl: "https://github.com/Dokploy/examples.git",
	customGitBranch: "main",
	customGitSSHKeyId: null,
	buildType: "nixpacks" as const,
	buildPath: "/astro",
	env: "NODE_ENV=production",
	serverId: null,
	rollbackActive: false,
	enableSubmodules: false,
	environmentId: "env-id",
	environment: {
		projectId: "project-id",
		env: "",
		name: "production",
		project: {
			name: "Test Project",
			organizationId: "org-id",
			env: "",
		},
	},
	domains: [],
	...overrides,
});

const createMockDeployment = () => ({
	deploymentId: "deployment-id",
	logPath: "/tmp/test-deployment.log",
});

describe("deployApplication - Command Generation Tests", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		applicationsFindFirstMock.mockResolvedValue(createMockApplication() as any);
		findApplicationByIdMock.mockResolvedValue(createMockApplication() as any);
		getDokployUrlMock.mockResolvedValue("http://localhost:3000");
		createDeploymentMock.mockResolvedValue(createMockDeployment() as any);
		execAsyncMock.mockResolvedValue({
			stdout: "",
			stderr: "",
		} as any);
		mechanizeDockerContainerMock.mockResolvedValue(undefined as any);
		updateDeploymentStatusMock.mockResolvedValue(undefined as any);
		updateApplicationStatusMock.mockResolvedValue({} as any);
		sendBuildSuccessNotificationsMock.mockResolvedValue(undefined as any);
		getGitCommitInfoMock.mockResolvedValue({
			message: "test commit",
			hash: "abc123",
		});
		updateDeploymentMock.mockResolvedValue({} as any);
	});

	it("should generate correct git clone command for astro example", async () => {
		const app = createMockApplication();
		const command = await cloneGitRepository(app);
		console.log(command);

		expect(command).toContain("https://github.com/Dokploy/examples.git");
		expect(command).not.toContain("--recurse-submodules");
		expect(command).toContain("--branch main");
		expect(command).toContain("--depth 1");
		expect(command).toContain("git clone");
	});

	it("should generate git clone with submodules when enabled", async () => {
		const app = createMockApplication({ enableSubmodules: true });
		const command = await cloneGitRepository(app);

		expect(command).toContain("--recurse-submodules");
		expect(command).toContain("https://github.com/Dokploy/examples.git");
	});

	it("should verify nixpacks command is called with correct app", async () => {
		const mockNixpacksCommand = "nixpacks build /path/to/app --name test-app";
		getBuildCommandMock.mockResolvedValue(mockNixpacksCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Test deployment",
			descriptionLog: "",
		});

		expect(builders.getBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				buildType: "nixpacks",
				customGitUrl: "https://github.com/Dokploy/examples.git",
				buildPath: "/astro",
			}),
		);

		expect(execProcess.execAsync).toHaveBeenCalledWith(
			expect.stringContaining("nixpacks build"),
		);
	});

	it("should verify railpack command includes correct parameters", async () => {
		const mockApp = createMockApplication({ buildType: "railpack" });
		applicationsFindFirstMock.mockResolvedValue(mockApp as any);
		findApplicationByIdMock.mockResolvedValue(mockApp as any);

		const mockRailpackCommand = "railpack prepare /path/to/app";
		getBuildCommandMock.mockResolvedValue(mockRailpackCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Railpack test",
			descriptionLog: "",
		});

		expect(builders.getBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				buildType: "railpack",
			}),
		);

		expect(execProcess.execAsync).toHaveBeenCalledWith(
			expect.stringContaining("railpack prepare"),
		);
	});

	it("should execute commands in correct order", async () => {
		const mockNixpacksCommand = "nixpacks build";
		getBuildCommandMock.mockResolvedValue(mockNixpacksCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Test",
			descriptionLog: "",
		});

		const execCalls = execAsyncMock.mock.calls;
		expect(execCalls.length).toBeGreaterThan(0);

		const fullCommand = execCalls[0]?.[0];
		expect(fullCommand).toContain("set -e");
		expect(fullCommand).toContain("git clone");
		expect(fullCommand).toContain("nixpacks build");
	});

	it("should include log redirection in command", async () => {
		const mockCommand = "nixpacks build";
		getBuildCommandMock.mockResolvedValue(mockCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Test",
			descriptionLog: "",
		});

		const execCalls = execAsyncMock.mock.calls;
		const fullCommand = execCalls[0]?.[0];

		expect(fullCommand).toContain(">> /tmp/test-deployment.log 2>&1");
	});
});

afterAll(() => {
	mock.module("@dokploy/server/db", () => createDbMock(jest.fn));
	mock.module("@dokploy/server/services/admin", () => actual.adminService);
	mock.module(
		"@dokploy/server/services/application",
		() => actual.applicationService,
	);
	mock.module(
		"@dokploy/server/services/deployment",
		() => actual.deploymentService,
	);
	mock.module(
		"@dokploy/server/services/rollbacks",
		() => actual.rollbacksService,
	);
	mock.module("@dokploy/server/utils/builders", () => actual.builders);
	mock.module(
		"@dokploy/server/utils/notifications/build-error",
		() => actual.buildError,
	);
	mock.module(
		"@dokploy/server/utils/notifications/build-success",
		() => actual.notifications,
	);
	mock.module(
		"@dokploy/server/utils/process/execAsync",
		() => actual.execProcess,
	);
	mock.module("@dokploy/server/utils/providers/git", () => actual.gitProvider);
});
