#!/usr/bin/env bun
/**
 * Head-to-head runtime benchmark: this fork's Bun image against a Node build.
 *
 * The numbers in docs/bun-migration/SPIKE-RESULTS.md come from this script. It
 * exists so they can be re-run rather than taken on trust.
 *
 * What it does NOT measure: build tooling. Install time, CI wall-time and image
 * size are covered separately in that document.
 *
 *   docker build -t dokploy-bun-main:latest .
 *   git stash && git checkout <pre-migration-commit>
 *   docker build -t dokploy-node-baseline:latest .
 *   bun scripts/runtime-benchmark.ts
 *
 * Both images need to exist locally. Nothing is pulled and nothing is pushed.
 * The containers are created on their own network with a `dokbench-` prefix, so
 * this does not disturb anything else running on the host, and the Docker socket
 * is deliberately NOT mounted: the benchmark is about HTTP and memory, and an
 * unmounted socket keeps the host untouched. Both images fail
 * `initializeNetwork()` identically as a result, and both still serve HTTP
 * because `server.listen()` runs before that call in server.ts.
 */

const PG = "dokbench-pg";
const NET = "dokbench";

/** Boot repetitions. The first of each is discarded as warm-up. */
const BOOT_REPS = 5;
const START_REPS = 11;

interface Target {
	name: string;
	image: string;
	db: string;
	port: number;
	container: string;
}

const TARGETS: Target[] = [
	{
		name: "node",
		image: "dokploy-node-baseline:latest",
		db: "dokploy_node",
		port: 3802,
		container: "dokbench-node",
	},
	{
		name: "bun",
		image: "dokploy-bun-main:latest",
		db: "dokploy_bun",
		port: 3801,
		container: "dokbench-bun",
	},
];

const sh = async (cmd: string[]) => {
	const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	await new Response(p.stderr).text();
	await p.exited;
	return out.trim();
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Poll until the server answers 200. Returns ms elapsed since `t0`. */
const waitForHealth = async (port: number, t0: number, timeoutMs = 180_000) => {
	while (Date.now() - t0 < timeoutMs) {
		try {
			const res = await fetch(`http://localhost:${port}/api/health`, {
				signal: AbortSignal.timeout(1000),
			});
			if (res.status === 200) {
				await res.text();
				return Date.now() - t0;
			}
		} catch {
			// not listening yet
		}
		await sleep(25);
	}
	return Number.NaN;
};

const resetDb = (db: string) =>
	sh([
		"docker",
		"exec",
		PG,
		"psql",
		"-U",
		"dokploy",
		"-d",
		"postgres",
		"-c",
		`DROP DATABASE IF EXISTS ${db} WITH (FORCE);`,
		"-c",
		`CREATE DATABASE ${db};`,
	]);

const createContainer = async (t: Target) => {
	await sh(["docker", "rm", "-f", t.container]);
	await sh([
		"docker",
		"create",
		"--name",
		t.container,
		"--network",
		NET,
		"-e",
		`DATABASE_URL=postgres://dokploy:bench@${PG}:5432/${t.db}`,
		"-e",
		"BETTER_AUTH_SECRET=benchsecret",
		"-e",
		"NODE_ENV=production",
		"-e",
		"PORT=3000",
		"-p",
		`${t.port}:3000`,
		t.image,
	]);
};

/** Container memory in MiB, as Docker itself reports it. */
const rss = async (container: string) => {
	const out = await sh([
		"docker",
		"stats",
		"--no-stream",
		"--format",
		"{{.MemUsage}}",
		container,
	]);
	const raw = out.split("/")[0]?.trim() ?? "";
	const n = Number.parseFloat(raw);
	if (Number.isNaN(n)) return Number.NaN;
	if (raw.endsWith("GiB")) return n * 1024;
	if (raw.endsWith("KiB")) return n / 1024;
	return n;
};

const sampleRss = async (container: string, samples = 5) => {
	const xs: number[] = [];
	for (let i = 0; i < samples; i++) {
		xs.push(await rss(container));
		await sleep(2000);
	}
	return median(xs.filter((x) => !Number.isNaN(x)));
};

const load = async (url: string, seconds: number, concurrency: number) => {
	const out = await sh([
		"oha",
		"-z",
		`${seconds}s`,
		"-c",
		String(concurrency),
		"--no-tui",
		"--output-format",
		"json",
		url,
	]);
	const d = JSON.parse(out);
	return {
		rps: d.summary.requestsPerSec as number,
		p50: (d.latencyPercentiles.p50 as number) * 1000,
		p95: (d.latencyPercentiles.p95 as number) * 1000,
		p99: (d.latencyPercentiles.p99 as number) * 1000,
		successRate: d.summary.successRate as number,
	};
};

const setupInfra = async () => {
	await sh(["docker", "network", "create", NET]);
	await sh(["docker", "rm", "-f", PG]);
	await sh([
		"docker",
		"run",
		"-d",
		"--name",
		PG,
		"--network",
		NET,
		"-e",
		"POSTGRES_USER=dokploy",
		"-e",
		"POSTGRES_PASSWORD=bench",
		"-e",
		"POSTGRES_DB=postgres",
		"postgres:16",
	]);
	for (let i = 0; i < 60; i++) {
		const out = await sh(["docker", "exec", PG, "pg_isready", "-U", "dokploy"]);
		if (out.includes("accepting connections")) return;
		await sleep(1000);
	}
	throw new Error("postgres did not become ready");
};

const teardown = async () => {
	for (const t of TARGETS) await sh(["docker", "rm", "-f", t.container]);
	await sh(["docker", "rm", "-f", PG]);
	await sh(["docker", "network", "rm", NET]);
};

// ---------------------------------------------------------------------------

const results: Record<string, Record<string, unknown>> = {};
for (const t of TARGETS) results[t.name] = {};

await setupInfra();

try {
	console.log("=== cold boot (fresh database, full migration chain) ===");
	const cold: Record<string, number[]> = { node: [], bun: [] };
	for (let rep = 0; rep < BOOT_REPS; rep++) {
		// Alternate order so host-level drift is shared evenly between targets.
		const order = rep % 2 === 0 ? TARGETS : [...TARGETS].reverse();
		for (const t of order) {
			await resetDb(t.db);
			await createContainer(t);
			const t0 = Date.now();
			await sh(["docker", "start", t.container]);
			const ms = await waitForHealth(t.port, t0);
			cold[t.name]!.push(ms);
			console.log(`  rep ${rep + 1} ${t.name.padEnd(4)} ${ms}ms`);
			await sh(["docker", "stop", t.container]);
		}
	}

	console.log("\n=== start and stop (already-migrated database) ===");
	const start: Record<string, number[]> = { node: [], bun: [] };
	const stop: Record<string, number[]> = { node: [], bun: [] };
	for (const t of TARGETS) await sh(["docker", "start", t.container]);
	for (const t of TARGETS) await waitForHealth(t.port, Date.now());
	for (let rep = 0; rep < START_REPS; rep++) {
		const order = rep % 2 === 0 ? TARGETS : [...TARGETS].reverse();
		for (const t of order) {
			// Stop is timed separately rather than using `docker restart`, which
			// would fold shutdown into the start number.
			const s0 = Date.now();
			await sh(["docker", "stop", t.container]);
			stop[t.name]!.push(Date.now() - s0);

			const t0 = Date.now();
			await sh(["docker", "start", t.container]);
			const ms = await waitForHealth(t.port, t0);
			start[t.name]!.push(ms);
			console.log(
				`  rep ${rep + 1} ${t.name.padEnd(4)} start ${ms}ms  stop ${stop[t.name]!.at(-1)}ms`,
			);
			await sleep(5000);
		}
	}

	console.log("\n=== idle memory (60s settle) ===");
	await sleep(60_000);
	for (const t of TARGETS) {
		results[t.name]!.idleRss = await sampleRss(t.container);
		console.log(
			`  ${t.name.padEnd(4)} ${(results[t.name]!.idleRss as number).toFixed(1)} MiB`,
		);
	}

	console.log("\n=== load ===");
	const SCENARIOS = [
		{ key: "health", path: "/api/health", seconds: 30, concurrency: 50 },
		{ key: "ssr", path: "/register", seconds: 30, concurrency: 20 },
	];
	for (const s of SCENARIOS) {
		const order = s.key === "health" ? TARGETS : [...TARGETS].reverse();
		for (const t of order) {
			const r = await load(
				`http://localhost:${t.port}${s.path}`,
				s.seconds,
				s.concurrency,
			);
			results[t.name]![s.key] = r;
			console.log(
				`  ${t.name.padEnd(4)} ${s.key.padEnd(6)} ${r.rps.toFixed(0)} rps  ` +
					`p50 ${r.p50.toFixed(2)}ms  p95 ${r.p95.toFixed(2)}ms  ` +
					`p99 ${r.p99.toFixed(2)}ms  ok ${(r.successRate * 100).toFixed(1)}%`,
			);
			await sleep(10_000);
		}
	}

	console.log("\n=== memory after load ===");
	for (const t of TARGETS) {
		results[t.name]!.loadedRss = await sampleRss(t.container);
		console.log(
			`  ${t.name.padEnd(4)} ${(results[t.name]!.loadedRss as number).toFixed(1)} MiB`,
		);
	}

	// Drop rep 1 of each series: the first run of an image pays host page-cache
	// costs the later ones do not, and it skews a five-sample median.
	for (const t of TARGETS) {
		const r = results[t.name]!;
		r.cold = cold[t.name];
		r.start = start[t.name];
		r.stop = stop[t.name];
		r.coldMedian = median(cold[t.name]!.slice(1));
		r.startMedian = median(start[t.name]!.slice(1));
		r.stopMedian = median(stop[t.name]!.slice(1));
	}

	console.log("\n=== medians (warm-up run excluded) ===");
	for (const t of TARGETS) {
		const r = results[t.name]!;
		console.log(
			`  ${t.name.padEnd(4)} cold ${r.coldMedian}ms  start ${r.startMedian}ms  ` +
				`stop ${r.stopMedian}ms  idle ${(r.idleRss as number).toFixed(1)}MiB  ` +
				`loaded ${(r.loadedRss as number).toFixed(1)}MiB`,
		);
	}

	await Bun.write(
		"runtime-benchmark-results.json",
		JSON.stringify(results, null, 2),
	);
	console.log("\nwrote runtime-benchmark-results.json");
} finally {
	await teardown();
}
