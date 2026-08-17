// Bundles the server entrypoints with Bun.build.
//
// No build-time env inlining. The previous esbuild config parsed .env.production
// and baked every value into the bundle via `define`, because Node does not read
// .env on its own. Bun does, and the Docker image already ships .env at runtime,
// so the inlining was redundant - and it made the bundle carry build-machine
// values, which is worse than reading them where they are actually used.
//
// Output keeps the .mjs extension so the Dockerfile CMD and the package.json
// start/reset/migration scripts stay untouched. Target stays "node": this phase
// swaps the bundler only, the runtime moves to Bun in phase 4.
//
// Excluded from tsconfig.json like migration.ts and setup.ts, so Bun globals do
// not leak into the app's type program (pulling in bun-types globally rewrites
// `fetch` and breaks the test suite's fetch mocks).

const output = await Bun.build({
	entrypoints: [
		"server/server.ts",
		"migration.ts",
		"wait-for-postgres.ts",
		"reset-password.ts",
		"reset-2fa.ts",
		"scripts/migrate-auth-secret.ts",
	],
	outdir: "dist",
	target: "node",
	format: "esm",
	minify: true,
	sourcemap: "external",
	packages: "external",
	naming: { entry: "[name].mjs" },
});

if (!output.success) {
	for (const log of output.logs) {
		console.error(log);
	}
	process.exit(1);
}

console.log(`Built ${output.outputs.length} files to dist/`);
