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
import * as permissionModule from "@dokploy/server/services/permission";
import * as octokitModule from "octokit";

// The gh_init branch runs on a GET the user can be linked into, so a rejected
// host must produce a 400 *before* any outbound request is made.
const mockValidateRequest = jest.fn();
const mockHasPermission = jest.fn();
const mockCreateGithub = jest.fn();
const mockOctokitRequest = jest.fn();

// Snapshot before mocking - there is no `importOriginal`, and reading back
// through the namespace afterwards would recurse into the mock. The restores
// matter more than usual here: this stubs the whole `@dokploy/server` barrel,
// and `mock.module` outlives the file that called it.
const actualBarrel = { ...serverBarrel };
const actualPermission = { ...permissionModule };
const actualOctokit = { ...octokitModule };

mock.module("@dokploy/server", () => ({
	...actualBarrel,
	validateRequest: mockValidateRequest,
	createGithub: mockCreateGithub,
}));

mock.module("@dokploy/server/services/permission", () => ({
	...actualPermission,
	hasPermission: mockHasPermission,
}));

afterAll(() => {
	mock.module("@dokploy/server", () => actualBarrel);
	mock.module("@dokploy/server/services/permission", () => actualPermission);
	mock.module("octokit", () => actualOctokit);
});

mock.module("octokit", () => ({
	...actualOctokit,
	Octokit: class {
		request = mockOctokitRequest;
	},
}));

const { default: handler } = await import("@/pages/api/providers/github/setup");

const ORG = "org-1";
const USER = "user-1";

const buildRes = () => {
	const res = {
		statusCode: 0,
		body: undefined as unknown,
		redirectedTo: undefined as string | undefined,
		status(code: number) {
			res.statusCode = code;
			return res;
		},
		json(payload: unknown) {
			res.body = payload;
			return res;
		},
		redirect(_code: number, url: string) {
			res.redirectedTo = url;
			return res;
		},
	};
	return res;
};

const call = async (githubUrl?: string | string[]) => {
	const res = buildRes();
	const req = {
		query: {
			code: "manifest-code",
			state: `gh_init:${ORG}:${USER}`,
			...(githubUrl === undefined ? {} : { githubUrl }),
		},
		headers: {},
	} as unknown as Parameters<typeof handler>[0];

	await handler(req, res as unknown as Parameters<typeof handler>[1]);
	return res;
};

describe("github setup handler — host validation", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockValidateRequest.mockResolvedValue({
			user: { id: USER },
			session: { activeOrganizationId: ORG },
		});
		mockHasPermission.mockResolvedValue(true);
		mockOctokitRequest.mockResolvedValue({
			data: {
				name: "Dokploy",
				html_url: "https://acme.ghe.com/apps/dokploy",
				id: 1,
				client_id: "cid",
				client_secret: "csecret",
				webhook_secret: "wsecret",
				pem: "key",
			},
		});
		mockCreateGithub.mockResolvedValue(undefined);
	});

	it.each([
		["http://acme.ghe.com", "plaintext http"],
		["http://localhost:2375", "internal service over http"],
		["https://metadata", "dotless hostname"],
		["htps://acme.ghe.com", "scheme typo"],
	])("rejects %s (%s) with 400 and no outbound request", async (githubUrl) => {
		const res = await call(githubUrl);

		expect(res.statusCode).toBe(400);
		expect(mockOctokitRequest).not.toHaveBeenCalled();
		expect(mockCreateGithub).not.toHaveBeenCalled();
	});

	it("throws on a repeated parameter instead of silently picking one", async () => {
		// ?githubUrl=a&githubUrl=b reaches .trim() on an array.
		await expect(
			call(["https://acme.ghe.com", "https://evil.com"]),
		).rejects.toThrow();

		expect(mockCreateGithub).not.toHaveBeenCalled();
	});

	it("accepts a data residency tenant", async () => {
		await call("https://acme.ghe.com");

		expect(mockCreateGithub).toHaveBeenCalledWith(
			expect.objectContaining({ githubUrl: "https://acme.ghe.com" }),
			ORG,
			USER,
		);
	});

	it("accepts a self-hosted Enterprise Server host", async () => {
		await call("https://github.corp.acme.com");

		expect(mockCreateGithub).toHaveBeenCalledWith(
			expect.objectContaining({ githubUrl: "https://github.corp.acme.com" }),
			ORG,
			USER,
		);
	});

	it("treats an absent parameter as github.com", async () => {
		await call(undefined);

		expect(mockCreateGithub).toHaveBeenCalledWith(
			expect.objectContaining({ githubUrl: "https://github.com" }),
			ORG,
			USER,
		);
	});
});
