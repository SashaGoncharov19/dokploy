import {
	afterAll,
	beforeEach,
	describe,
	expect,
	it,
	jest,
	mock,
} from "bun:test";
import * as serverBarrel from "@dokploy/server";
import * as octokitWebhooks from "@octokit/webhooks";
import * as drizzleOrm from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";
import * as dbSchema from "@/server/db/schema";
import * as queueSetup from "@/server/queues/queueSetup";
import * as deployUtil from "@/server/utils/deploy";
import { createDbMock } from "../db-mock";

// Snapshot every module before replacing it. `mock.module` is process-global
// and `mock.restore()` does not undo it, so a narrow stub of `drizzle-orm` or
// the `@dokploy/server` barrel would change every later file in the run.
const actual = {
	drizzleOrm: { ...drizzleOrm },
	dbSchema: { ...dbSchema },
	serverBarrel: { ...serverBarrel },
	octokitWebhooks: { ...octokitWebhooks },
	queueSetup: { ...queueSetup },
	deployUtil: { ...deployUtil },
};

const mocks = {
	eq: jest.fn((field: string, value: unknown) => ({ field, value })),
	and: jest.fn((...conditions: Array<{ field: string; value: unknown }>) => ({
		conditions,
	})),
	githubFindFirst: jest.fn(),
	applicationsFindMany: jest.fn(),
	composeFindMany: jest.fn(),
	queueAdd: jest.fn(),
	verify: jest.fn(),
	shouldDeploy: jest.fn(),
	createPreviewDeployment: jest.fn(),
	findPreviewDeploymentByApplicationId: jest.fn(),
};

mock.module("drizzle-orm", () => ({
	...actual.drizzleOrm,
	eq: mocks.eq,
	and: mocks.and,
}));

mock.module("@/server/db/schema", () => ({
	...actual.dbSchema,
	applications: {
		sourceType: "application.sourceType",
		autoDeploy: "application.autoDeploy",
		triggerType: "application.triggerType",
		branch: "application.branch",
		repository: "application.repository",
		owner: "application.owner",
		githubId: "application.githubId",
		isPreviewDeploymentsActive: "application.isPreviewDeploymentsActive",
	},
	compose: {
		sourceType: "compose.sourceType",
		autoDeploy: "compose.autoDeploy",
		triggerType: "compose.triggerType",
		branch: "compose.branch",
		repository: "compose.repository",
		owner: "compose.owner",
		githubId: "compose.githubId",
	},
	github: {
		githubInstallationId: "github.githubInstallationId",
	},
}));

mock.module("@dokploy/server/db", () => ({
	db: {
		query: {
			github: {
				findFirst: mocks.githubFindFirst,
			},
			applications: {
				findMany: mocks.applicationsFindMany,
			},
			compose: {
				findMany: mocks.composeFindMany,
			},
		},
	},
}));

mock.module("@dokploy/server", () => ({
	...actual.serverBarrel,
	IS_CLOUD: false,
	shouldDeploy: mocks.shouldDeploy,
	checkUserRepositoryPermissions: jest.fn(),
	createPreviewDeployment: mocks.createPreviewDeployment,
	createSecurityBlockedComment: jest.fn(),
	findGithubById: jest.fn(),
	findPreviewDeploymentByApplicationId:
		mocks.findPreviewDeploymentByApplicationId,
	findPreviewDeploymentsByPullRequestId: jest.fn(),
	getBitbucketHeaders: jest.fn(() => ({})),
	removePreviewDeployment: jest.fn(),
}));

mock.module("@octokit/webhooks", () => ({
	...actual.octokitWebhooks,
	Webhooks: jest.fn().mockImplementation(function Webhooks() {
		return {
			verify: mocks.verify,
		};
	}),
}));

mock.module("@/server/queues/queueSetup", () => ({
	...actual.queueSetup,
	myQueue: {
		add: mocks.queueAdd,
	},
}));

mock.module("@/server/utils/deploy", () => ({
	...actual.deployUtil,
	deploy: jest.fn(),
}));

const { default: handler } = await import("@/pages/api/deploy/github");

afterAll(() => {
	mock.module("drizzle-orm", () => actual.drizzleOrm);
	mock.module("@/server/db/schema", () => actual.dbSchema);
	mock.module("@dokploy/server", () => actual.serverBarrel);
	mock.module("@octokit/webhooks", () => actual.octokitWebhooks);
	mock.module("@/server/queues/queueSetup", () => actual.queueSetup);
	mock.module("@/server/utils/deploy", () => actual.deployUtil);
	mock.module("@dokploy/server/db", () => createDbMock(jest.fn));
});

const getConditionValue = (
	where: { conditions?: Array<{ field: string; value: unknown }> } | undefined,
	field: string,
) => where?.conditions?.find((condition) => condition.field === field)?.value;

const createResponse = () => {
	const res = {
		status: jest.fn(),
		json: jest.fn(),
	} as unknown as NextApiResponse & {
		status: ReturnType<typeof jest.fn>;
		json: ReturnType<typeof jest.fn>;
	};

	res.status.mockImplementation(() => res);
	res.json.mockImplementation(() => res);

	return res;
};

const createPushRequest = (
	branch: string,
	owner: { login?: string; name?: string } = { login: "agentHits" },
) =>
	({
		headers: {
			"x-hub-signature-256": "sha256=test-signature",
			"x-github-event": "push",
		},
		body: {
			installation: {
				id: 12345,
			},
			ref: `refs/heads/${branch}`,
			after: "abc123",
			head_commit: {
				message: "fix: trigger deployment",
			},
			commits: [
				{
					modified: ["src/index.ts"],
				},
			],
			repository: {
				name: "dokploy",
				full_name: "agentHits/dokploy",
				clone_url: "https://github.com/agentHits/dokploy.git",
				html_url: "https://github.com/agentHits/dokploy",
				owner,
			},
		},
	}) as unknown as NextApiRequest;

const createTagRequest = (tagName: string) => {
	const req = createPushRequest("main") as unknown as {
		body: { ref: string; head_commit: { message: string } };
	};

	req.body.ref = `refs/tags/${tagName}`;
	req.body.head_commit.message = `release: ${tagName}`;

	return req as unknown as NextApiRequest;
};

describe("GitHub app webhook auto-deploy", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mocks.githubFindFirst.mockResolvedValue({
			githubId: "github-provider-id",
			githubInstallationId: 12345,
			githubWebhookSecret: "webhook-secret",
		});
		mocks.verify.mockResolvedValue(true);
		mocks.shouldDeploy.mockReturnValue(true);
		mocks.composeFindMany.mockResolvedValue([]);
		mocks.queueAdd.mockResolvedValue({ id: "job-id" });

		mocks.applicationsFindMany.mockImplementation(({ where }) => {
			const matches =
				getConditionValue(where, "application.sourceType") === "github" &&
				getConditionValue(where, "application.autoDeploy") === true &&
				getConditionValue(where, "application.triggerType") === "push" &&
				getConditionValue(where, "application.branch") === "main" &&
				getConditionValue(where, "application.repository") === "dokploy" &&
				getConditionValue(where, "application.owner") === "agentHits" &&
				getConditionValue(where, "application.githubId") ===
					"github-provider-id";

			return Promise.resolve(
				matches
					? [
							{
								applicationId: "application-id",
								serverId: null,
								watchPaths: null,
							},
						]
					: [],
			);
		});
	});

	it("matches push events using repository owner name when available", async () => {
		const res = createResponse();

		await handler(
			createPushRequest("main", {
				login: "agentHits-login",
				name: "agentHits",
			}),
			res,
		);

		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationId: "application-id",
				applicationType: "application",
				type: "deploy",
			}),
			expect.objectContaining({
				removeOnComplete: true,
				removeOnFail: true,
			}),
		);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ message: "Deployed 1 apps" });
	});

	it("matches compose push events using repository owner login fallback", async () => {
		mocks.applicationsFindMany.mockResolvedValue([]);
		mocks.composeFindMany.mockImplementation(({ where }) => {
			const matches =
				getConditionValue(where, "compose.sourceType") === "github" &&
				getConditionValue(where, "compose.autoDeploy") === true &&
				getConditionValue(where, "compose.triggerType") === "push" &&
				getConditionValue(where, "compose.branch") === "main" &&
				getConditionValue(where, "compose.repository") === "dokploy" &&
				getConditionValue(where, "compose.owner") === "agentHits" &&
				getConditionValue(where, "compose.githubId") === "github-provider-id";

			return Promise.resolve(
				matches
					? [
							{
								composeId: "compose-id",
								serverId: null,
								watchPaths: null,
							},
						]
					: [],
			);
		});
		const res = createResponse();

		await handler(createPushRequest("main"), res);

		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationType: "compose",
				composeId: "compose-id",
				type: "deploy",
			}),
			expect.objectContaining({
				removeOnComplete: true,
				removeOnFail: true,
			}),
		);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ message: "Deployed 1 apps" });
	});

	it("matches tag events using repository owner login fallback", async () => {
		mocks.applicationsFindMany.mockImplementation(({ where }) => {
			const matches =
				getConditionValue(where, "application.sourceType") === "github" &&
				getConditionValue(where, "application.autoDeploy") === true &&
				getConditionValue(where, "application.triggerType") === "tag" &&
				getConditionValue(where, "application.repository") === "dokploy" &&
				getConditionValue(where, "application.owner") === "agentHits" &&
				getConditionValue(where, "application.githubId") ===
					"github-provider-id";

			return Promise.resolve(
				matches
					? [
							{
								applicationId: "application-id",
								serverId: null,
							},
						]
					: [],
			);
		});
		const res = createResponse();

		await handler(createTagRequest("v1.0.0"), res);

		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationId: "application-id",
				applicationType: "application",
				titleLog: "Tag created: v1.0.0",
				type: "deploy",
			}),
			expect.objectContaining({
				removeOnComplete: true,
				removeOnFail: true,
			}),
		);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({
			message: "Deployed 1 apps based on tag v1.0.0",
		});
	});

	it("does not deploy when the pushed branch does not match", async () => {
		const res = createResponse();

		await handler(createPushRequest("feature"), res);

		expect(mocks.queueAdd).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ message: "No apps to deploy" });
	});
});

describe("GitHub app webhook preview deployments", () => {
	const createApplication = (
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> => ({
		applicationId: "application-id",
		name: "my-app",
		serverId: null,
		previewLabels: [],
		previewLimit: 3,
		previewDeployments: [],
		previewRequireCollaboratorPermissions: false,
		...overrides,
	});

	const createPreviewDeployments = (total: number) =>
		Array.from({ length: total }, (_, index) => ({
			previewDeploymentId: `existing-preview-${index}`,
		}));

	const createPullRequestRequest = (action: string) =>
		({
			headers: {
				"x-hub-signature-256": "sha256=test-signature",
				"x-github-event": "pull_request",
			},
			body: {
				installation: {
					id: 12345,
				},
				action,
				pull_request: {
					id: 987,
					number: 42,
					title: "feat: add preview",
					html_url: "https://github.com/agentHits/dokploy/pull/42",
					labels: [],
					user: {
						login: "agentHits",
					},
					head: {
						ref: "feature",
						sha: "abc123",
					},
					base: {
						ref: "main",
					},
				},
				repository: {
					name: "dokploy",
					owner: {
						login: "agentHits",
					},
				},
			},
		}) as unknown as NextApiRequest;

	beforeEach(() => {
		jest.clearAllMocks();
		mocks.githubFindFirst.mockResolvedValue({
			githubId: "github-provider-id",
			githubInstallationId: 12345,
			githubWebhookSecret: "webhook-secret",
		});
		mocks.verify.mockResolvedValue(true);
		mocks.queueAdd.mockResolvedValue({ id: "job-id" });
		mocks.createPreviewDeployment.mockResolvedValue({
			previewDeploymentId: "new-preview-id",
		});
		mocks.findPreviewDeploymentByApplicationId.mockResolvedValue(undefined);
	});

	it("redeploys an existing preview even when the limit is reached", async () => {
		mocks.applicationsFindMany.mockResolvedValue([
			createApplication({
				previewLimit: 2,
				previewDeployments: createPreviewDeployments(3),
			}),
		]);
		mocks.findPreviewDeploymentByApplicationId.mockResolvedValue({
			previewDeploymentId: "existing-preview-0",
		});
		const res = createResponse();

		await handler(createPullRequestRequest("synchronize"), res);

		expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationId: "application-id",
				applicationType: "application-preview",
				previewDeploymentId: "existing-preview-0",
				type: "deploy",
			}),
			expect.objectContaining({
				removeOnComplete: true,
				removeOnFail: true,
			}),
		);
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it("does not create a new preview once the limit is reached", async () => {
		mocks.applicationsFindMany.mockResolvedValue([
			createApplication({
				previewLimit: 2,
				previewDeployments: createPreviewDeployments(2),
			}),
		]);
		const res = createResponse();

		await handler(createPullRequestRequest("opened"), res);

		expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
		expect(mocks.queueAdd).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it("falls back to the default limit when none is configured", async () => {
		mocks.applicationsFindMany.mockResolvedValue([
			createApplication({
				previewLimit: null,
				previewDeployments: createPreviewDeployments(2),
			}),
		]);
		const res = createResponse();

		await handler(createPullRequestRequest("opened"), res);

		expect(mocks.createPreviewDeployment).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "application-id",
				branch: "feature",
				pullRequestId: 987,
				pullRequestNumber: 42,
			}),
		);
		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationId: "application-id",
				applicationType: "application-preview",
				previewDeploymentId: "new-preview-id",
				type: "deploy",
			}),
			expect.objectContaining({
				removeOnComplete: true,
				removeOnFail: true,
			}),
		);
		expect(res.status).toHaveBeenCalledWith(200);
	});
});
