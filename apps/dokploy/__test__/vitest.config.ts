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
			"**/__test__/utils/**",
			"**/__test__/queues/**",
			"**/__test__/drop/**",
			"**/__test__/traefik/**",
			"**/__test__/server/**",
			"**/__test__/permissions/**",
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
