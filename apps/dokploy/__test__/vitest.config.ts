import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["__test__/**/*.test.ts"], // Incluir solo los archivos de test en el directorio __test__
		// Directories ported to `bun test` - see the test:bun script. Porting a
		// directory means moving it from here into that script's list.
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/.docker/**",
			"**/__test__/logs/**",
			"**/__test__/registry/**",
			"**/__test__/requests/**",
			"**/__test__/api/**",
			"**/__test__/cluster/**",
			"**/__test__/templates/**",
			"**/__test__/backups/**",
			"**/__test__/services/**",
			// utils is split per file: remote-stream stays here because `bun test`
			// spins at 100% CPU (about 1 run in 15) on a test that pipes one child
			// process into another and awaits its close - reproduced with plain
			// node:child_process and no project code on Bun 1.3.11 and 1.3.14, and
			// still 2 runs in 100 on 1.4.2.
			// The same code under plain `bun` never hangs; it is the test runner.
			"**/__test__/utils/backups.test.ts",
			"**/__test__/utils/hostname-validation.test.ts",
			"**/__test__/utils/log-type.test.ts",
			"**/__test__/queues/**",
			"**/__test__/drop/**",
			"**/__test__/traefik/**",
			"**/__test__/server/**",
			"**/__test__/permissions/**",
			"**/__test__/wss/**",
			"**/__test__/dns/**",
			"**/__test__/compose/**",
			"**/__test__/git-provider/**",
			"**/__test__/deploy/**",
		],
		pool: "forks",
		setupFiles: [path.resolve(__dirname, "setup.ts")],
	},
	define: {
		"process.env": {
			NODE: "test",
			GITHUB_CLIENT_ID: "test",
			GITHUB_CLIENT_SECRET: "test",
			GOOGLE_CLIENT_ID: "test",
			GOOGLE_CLIENT_SECRET: "test",
		},
	},
	plugins: [
		tsconfigPaths({
			projects: [path.resolve(__dirname, "../tsconfig.json")],
		}),
	],
	resolve: {
		alias: {
			"@dokploy/server": path.resolve(
				__dirname,
				"../../../packages/server/src",
			),
		},
	},
});
