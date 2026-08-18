import {
	afterAll,
	beforeEach,
	describe,
	expect,
	it,
	jest,
	mock,
} from "bun:test";
import * as githubService from "@dokploy/server/services/github";
import * as authApp from "@octokit/auth-app";
import * as octokitModule from "octokit";

// cloneGithubRepository builds a shell command; the only thing under test here
// is which host ends up in the clone URL, so the app auth is stubbed out.
const mockFindGithubById = jest.fn();

// Snapshot each module before replacing it. `mock.module` is process-global and
// `mock.restore()` does not undo it, so every stub here has to be put back or it
// changes the behaviour of every later file in the same `bun test` run.
const actualGithubService = { ...githubService };
const actualAuthApp = { ...authApp };
const actualOctokit = { ...octokitModule };

mock.module("@dokploy/server/services/github", () => ({
	...actualGithubService,
	findGithubById: mockFindGithubById,
}));

mock.module("@octokit/auth-app", () => ({
	...actualAuthApp,
	createAppAuth: jest.fn(),
}));

mock.module("octokit", () => ({
	...actualOctokit,
	Octokit: class {
		auth = async () => ({ token: "gh-token" });
	},
}));

afterAll(() => {
	mock.module("@dokploy/server/services/github", () => actualGithubService);
	mock.module("@octokit/auth-app", () => actualAuthApp);
	mock.module("octokit", () => actualOctokit);
});

const { cloneGithubRepository } = await import(
	"@dokploy/server/utils/providers/github"
);

const provider = (githubUrl: string) => ({
	githubId: "gh-1",
	githubUrl,
	githubAppId: 1,
	githubPrivateKey: "key",
	githubInstallationId: "42",
});

const clone = async () => {
	const command = await cloneGithubRepository({
		appName: "my-app",
		owner: "acme",
		repository: "web",
		branch: "main",
		githubId: "gh-1",
		enableSubmodules: false,
		serverId: null,
	});
	return command.replace(/\\/g, "");
};

describe("cloneGithubRepository host", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it("clones from github.com for a default provider", async () => {
		mockFindGithubById.mockResolvedValue(provider("https://github.com"));

		const command = await clone();

		expect(command).toContain(
			"https://oauth2:gh-token@github.com/acme/web.git",
		);
		expect(command).not.toContain("ghe.com");
	});

	it("clones from the Enterprise host, not github.com", async () => {
		mockFindGithubById.mockResolvedValue(provider("https://acme.ghe.com"));

		const command = await clone();

		expect(command).toContain(
			"https://oauth2:gh-token@acme.ghe.com/acme/web.git",
		);
		expect(command).not.toContain("github.com");
	});

	it("clones from a self-hosted Enterprise Server host", async () => {
		mockFindGithubById.mockResolvedValue(
			provider("https://github.corp.acme.com"),
		);

		const command = await clone();

		expect(command).toContain(
			"https://oauth2:gh-token@github.corp.acme.com/acme/web.git",
		);
	});

	it("keeps an explicit port in the clone host", async () => {
		mockFindGithubById.mockResolvedValue(
			provider("https://github.acme.com:8443"),
		);

		const command = await clone();

		expect(command).toContain(
			"https://oauth2:gh-token@github.acme.com:8443/acme/web.git",
		);
	});

	it("falls back to github.com for a provider stored before this feature", async () => {
		mockFindGithubById.mockResolvedValue(provider(""));

		const command = await clone();

		expect(command).toContain(
			"https://oauth2:gh-token@github.com/acme/web.git",
		);
	});
});
