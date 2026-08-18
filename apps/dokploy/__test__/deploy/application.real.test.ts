import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
	mock,
} from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ApplicationNested } from "@dokploy/server";
import { paths } from "@dokploy/server/constants";
import * as adminServiceSrc from "@dokploy/server/services/admin";
import * as applicationServiceSrc from "@dokploy/server/services/application";
import * as deploymentServiceSrc from "@dokploy/server/services/deployment";
import * as rollbacksServiceSrc from "@dokploy/server/services/rollbacks";
import * as buildErrorSrc from "@dokploy/server/utils/notifications/build-error";
import * as buildSuccessSrc from "@dokploy/server/utils/notifications/build-success";
import { execAsync } from "@dokploy/server/utils/process/execAsync";
import { format } from "date-fns";
import { createDbMock } from "../db-mock";

// Snapshot before mocking - `mock.module` has no `importActual`, and it is
// process-global, so each stub is put back in `afterAll`.
const actual = {
	adminService: { ...adminServiceSrc },
	applicationService: { ...applicationServiceSrc },
	deploymentService: { ...deploymentServiceSrc },
	rollbacksService: { ...rollbacksServiceSrc },
	buildError: { ...buildErrorSrc },
	buildSuccess: { ...buildSuccessSrc },
};

// Named handles: bun:test has no `vi.mocked`, and referencing these directly is
// better typed than casting the namespace member at each call site.
const findApplicationByIdMock = jest.fn();
const updateApplicationStatusMock = jest.fn();
const getDokployUrlMock = jest.fn().mockResolvedValue("http://localhost:3000");
const createDeploymentMock = jest.fn();
const updateDeploymentStatusMock = jest.fn();
const updateDeploymentMock = jest.fn();
const applicationsFindFirstMock = jest.fn();

const REAL_TEST_TIMEOUT = 180000; // 3 minutes

// Mock ONLY database and notifications
mock.module("@dokploy/server/db", () => {
	const createChainableMock = (): any => {
		const chain: any = {
			set: jest.fn(() => chain),
			where: jest.fn(() => chain),
			returning: jest.fn().mockResolvedValue([{}]),
			from: jest.fn(() => chain),
			innerJoin: jest.fn(() => chain),
			then: (resolve: (v: any) => void) => {
				resolve([]);
			},
		};
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

mock.module("@dokploy/server/utils/notifications/build-success", () => ({
	...actual.buildSuccess,
	sendBuildSuccessNotifications: jest.fn(),
}));

mock.module("@dokploy/server/utils/notifications/build-error", () => ({
	...actual.buildError,
	sendBuildErrorNotifications: jest.fn(),
}));

mock.module("@dokploy/server/services/rollbacks", () => ({
	...actual.rollbacksService,
	createRollback: jest.fn(),
}));

// NOT mocked (executed for real):
// - execAsync
// - cloneGitRepository
// - getBuildCommand
// - mechanizeDockerContainer (requires Docker Swarm)

import { db } from "@dokploy/server/db";
import * as adminService from "@dokploy/server/services/admin";
import * as applicationService from "@dokploy/server/services/application";
import { deployApplication } from "@dokploy/server/services/application";
import * as deploymentService from "@dokploy/server/services/deployment";

const createMockApplication = (
	overrides: Partial<ApplicationNested> = {},
): ApplicationNested =>
	({
		applicationId: "test-app-id",
		name: "Real Test App",
		appName: `real-test-${Date.now()}`,
		sourceType: "git" as const,
		customGitUrl: "https://github.com/Dokploy/examples.git",
		customGitBranch: "main",
		customGitSSHKeyId: null,
		customGitBuildPath: "/astro",
		buildType: "nixpacks" as const,
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
		mounts: [],
		security: [],
		redirects: [],
		ports: [],
		registry: null,
		...overrides,
	}) as ApplicationNested;

const createMockDeployment = async (appName: string) => {
	const { LOGS_PATH } = paths(false); // false = local, no remote server
	const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
	const fileName = `${appName}-${formattedDateTime}.log`;
	const logFilePath = path.join(LOGS_PATH, appName, fileName);

	// Actually create the log directory
	await execAsync(`mkdir -p ${path.dirname(logFilePath)}`);
	await execAsync(`echo "Initializing deployment" > ${logFilePath}`);

	return {
		deploymentId: "deployment-id",
		logPath: logFilePath,
	};
};

async function cleanupDocker(appName: string) {
	try {
		await execAsync(`docker stop ${appName} 2>/dev/null || true`);
		await execAsync(`docker rm ${appName} 2>/dev/null || true`);
		await execAsync(`docker rmi ${appName} 2>/dev/null || true`);
	} catch (error) {
		console.log("Docker cleanup completed");
	}
}

async function cleanupFiles(appName: string) {
	try {
		const { LOGS_PATH, APPLICATIONS_PATH } = paths(false);

		// Clean cloned code directories
		const appPath = path.join(APPLICATIONS_PATH, appName);
		await execAsync(`rm -rf ${appPath} 2>/dev/null || true`);

		// Clean logs for appName - removes entire folder
		const logPath = path.join(LOGS_PATH, appName);
		await execAsync(`rm -rf ${logPath} 2>/dev/null || true`);

		console.log(`✅ Cleaned up files and logs for ${appName}`);
	} catch (error) {
		console.error(`⚠️ Error during cleanup for ${appName}:`, error);
	}
}

describe("deployApplication - REAL Execution Tests", () => {
	let currentAppName: string;
	let currentDeployment: any;
	const allTestAppNames: string[] = [];

	beforeEach(async () => {
		jest.clearAllMocks();
		currentAppName = `real-test-${Date.now()}`;
		currentDeployment = await createMockDeployment(currentAppName);
		allTestAppNames.push(currentAppName);

		const mockApp = createMockApplication({ appName: currentAppName });

		applicationsFindFirstMock.mockResolvedValue(mockApp as any);
		findApplicationByIdMock.mockResolvedValue(mockApp as any);
		getDokployUrlMock.mockResolvedValue("http://localhost:3000");
		createDeploymentMock.mockResolvedValue(currentDeployment as any);
		updateDeploymentStatusMock.mockResolvedValue(undefined as any);
		updateApplicationStatusMock.mockResolvedValue({} as any);
		updateDeploymentMock.mockResolvedValue({} as any);
	});

	afterEach(async () => {
		// ALWAYS cleanup, even if test failed or passed
		console.log(`\n🧹 Cleaning up test: ${currentAppName}`);

		// Clean current appName
		try {
			await cleanupDocker(currentAppName);
			await cleanupFiles(currentAppName);
		} catch (error) {
			console.error("⚠️ Error cleaning current app:", error);
		}

		// Clean ALL test folders just in case
		try {
			const { LOGS_PATH, APPLICATIONS_PATH } = paths(false);
			await execAsync(`rm -rf ${LOGS_PATH}/real-* 2>/dev/null || true`);
			await execAsync(`rm -rf ${APPLICATIONS_PATH}/real-* 2>/dev/null || true`);
			console.log("✅ Cleaned up all test artifacts");
		} catch (error) {
			console.error("⚠️ Error cleaning all artifacts:", error);
		}

		console.log("✅ Cleanup completed\n");
	});

	it(
		"should REALLY clone git repo and build with nixpacks",
		async () => {
			console.log(`\n🚀 Testing real deployment with app: ${currentAppName}`);

			const result = await deployApplication({
				applicationId: "test-app-id",
				titleLog: "Real Nixpacks Test",
				descriptionLog: "Testing real execution",
			});

			expect(result).toBe(true);

			// Verify that Docker image was actually created
			const { stdout: dockerImages } = await execAsync(
				`docker images ${currentAppName} --format "{{.Repository}}"`,
			);
			console.log("dockerImages", dockerImages);
			expect(dockerImages.trim()).toBe(currentAppName);
			console.log(`✅ Docker image created: ${currentAppName}`);

			// Verify log exists and has content
			expect(existsSync(currentDeployment.logPath)).toBe(true);
			const { stdout: logContent } = await execAsync(
				`cat ${currentDeployment.logPath}`,
			);
			expect(logContent).toContain("Cloning");
			expect(logContent).toContain("nixpacks");
			console.log(`✅ Build log created with ${logContent.length} chars`);

			// Verify update functions were called
			expect(deploymentService.updateDeploymentStatus).toHaveBeenCalledWith(
				"deployment-id",
				"done",
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it.skip(
		"should REALLY build with railpack (SKIPPED: requires special permissions)",
		async () => {
			const railpackAppName = `real-railpack-${Date.now()}`;
			const railpackApp = createMockApplication({
				appName: railpackAppName,
				buildType: "railpack",
				railpackVersion: "3",
			});
			currentAppName = railpackAppName;
			allTestAppNames.push(railpackAppName);

			applicationsFindFirstMock.mockResolvedValue(railpackApp as any);
			findApplicationByIdMock.mockResolvedValue(railpackApp as any);

			console.log(`\n🚀 Testing real railpack deployment: ${currentAppName}`);

			const result = await deployApplication({
				applicationId: "test-app-id",
				titleLog: "Real Railpack Test",
				descriptionLog: "",
			});

			expect(result).toBe(true);

			const { stdout: dockerImages } = await execAsync(
				`docker images ${currentAppName} --format "{{.Repository}}"`,
			);
			expect(dockerImages.trim()).toBe(currentAppName);
			console.log(`✅ Railpack image created: ${currentAppName}`);

			const { stdout: logContent } = await execAsync(
				`cat ${currentDeployment.logPath}`,
			);
			expect(logContent).toContain("railpack");
			console.log("✅ Railpack build completed");
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"should handle REAL git clone errors",
		async () => {
			const errorAppName = `real-error-${Date.now()}`;
			const errorApp = createMockApplication({
				appName: errorAppName,
				customGitUrl: "https://github.com/invalid/nonexistent-repo-123456.git",
			});
			currentAppName = errorAppName;
			allTestAppNames.push(errorAppName);

			applicationsFindFirstMock.mockResolvedValue(errorApp as any);
			findApplicationByIdMock.mockResolvedValue(errorApp as any);

			console.log(`\n🚀 Testing real error handling: ${currentAppName}`);

			await expect(
				deployApplication({
					applicationId: "test-app-id",
					titleLog: "Real Error Test",
					descriptionLog: "",
				}),
			).rejects.toThrow();

			// Verify error status was called
			expect(deploymentService.updateDeploymentStatus).toHaveBeenCalledWith(
				"deployment-id",
				"error",
			);

			// Verify log contains error
			const { stdout: logContent } = await execAsync(
				`cat ${currentDeployment.logPath}`,
			);
			expect(logContent.toLowerCase()).toContain("error");
			console.log("✅ Error handling verified");
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"should REALLY clone with submodules when enabled",
		async () => {
			const submodulesAppName = `real-submodules-${Date.now()}`;
			const submodulesApp = createMockApplication({
				appName: submodulesAppName,
				enableSubmodules: true,
			});
			currentAppName = submodulesAppName;
			allTestAppNames.push(submodulesAppName);

			applicationsFindFirstMock.mockResolvedValue(submodulesApp as any);
			findApplicationByIdMock.mockResolvedValue(submodulesApp as any);

			console.log(`\n🚀 Testing real submodules support: ${currentAppName}`);

			const result = await deployApplication({
				applicationId: "test-app-id",
				titleLog: "Real Submodules Test",
				descriptionLog: "",
			});

			expect(result).toBe(true);

			// Verify deployment completed successfully
			const { stdout: logContent } = await execAsync(
				`cat ${currentDeployment.logPath}`,
			);
			expect(logContent).toContain("Cloning");
			expect(logContent.length).toBeGreaterThan(100);
			console.log("✅ Submodules deployment completed");

			// Verify image
			const { stdout: dockerImages } = await execAsync(
				`docker images ${currentAppName} --format "{{.Repository}}"`,
			);
			expect(dockerImages.trim()).toBe(currentAppName);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"should verify REAL commit info extraction",
		async () => {
			console.log(`\n🚀 Testing real commit info: ${currentAppName}`);

			await deployApplication({
				applicationId: "test-app-id",
				titleLog: "Real Commit Test",
				descriptionLog: "",
			});

			// Verify updateDeployment was called with commit info
			expect(deploymentService.updateDeployment).toHaveBeenCalled();
			const updateCall = updateDeploymentMock.mock.calls[0];

			// Real commit info should have title and hash
			expect(updateCall?.[1]).toHaveProperty("title");
			expect(updateCall?.[1]).toHaveProperty("description");
			expect(updateCall?.[1]?.description).toContain("Commit:");

			console.log(
				`✅ Real commit extracted: ${updateCall?.[1]?.title?.substring(0, 50)}...`,
			);
		},
		REAL_TEST_TIMEOUT,
	);

	it(
		"should REALLY build with Dockerfile",
		async () => {
			const dockerfileAppName = `real-dockerfile-${Date.now()}`;
			const dockerfileApp = createMockApplication({
				appName: dockerfileAppName,
				buildType: "dockerfile",
				customGitBuildPath: "/deno",
				dockerfile: "Dockerfile",
			});
			currentAppName = dockerfileAppName;
			allTestAppNames.push(dockerfileAppName);

			applicationsFindFirstMock.mockResolvedValue(dockerfileApp as any);
			findApplicationByIdMock.mockResolvedValue(dockerfileApp as any);

			console.log(`\n🚀 Testing real Dockerfile build: ${currentAppName}`);

			const result = await deployApplication({
				applicationId: "test-app-id",
				titleLog: "Real Dockerfile Test",
				descriptionLog: "",
			});

			expect(result).toBe(true);

			// Verify log
			const { stdout: logContent } = await execAsync(
				`cat ${currentDeployment.logPath}`,
			);
			expect(logContent).toContain("Building");
			expect(logContent).toContain(dockerfileAppName);
			console.log("✅ Dockerfile build log verified");

			// Verify image
			const { stdout: dockerImages } = await execAsync(
				`docker images ${currentAppName} --format "{{.Repository}}"`,
			);
			console.log("dockerImages", dockerImages);
			expect(dockerImages.trim()).toBe(currentAppName);
			console.log(`✅ Docker image created: ${currentAppName}`);
		},
		REAL_TEST_TIMEOUT,
	);
});
// bun:test's `describe` takes no timeout argument; every `it` below already
// carries REAL_TEST_TIMEOUT of its own, so nothing is lost.

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
	mock.module(
		"@dokploy/server/utils/notifications/build-error",
		() => actual.buildError,
	);
	mock.module(
		"@dokploy/server/utils/notifications/build-success",
		() => actual.buildSuccess,
	);
});
