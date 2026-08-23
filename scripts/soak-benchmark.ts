#!/usr/bin/env bun
/**
 * Long-running memory soak: does the Bun build's memory grow over hours under
 * sustained load, and does Node's not?
 *
 * This exists to test one specific claim, made against Bun in Dokploy/dokploy#3149
 * and repeated widely elsewhere: that a Bun process "just keeps increasing in
 * memory within hours until it consumes all RAM and then crashes", where the same
 * code on Node stays flat.
 *
 * `runtime-benchmark.ts` cannot answer that. It measures a freshly started server
 * over seconds, so a leak that takes hours to become visible would not appear in
 * it at all - and a lower number at minute one says nothing about hour eight. The
 * two scripts are complementary and neither replaces the other.
 *
 *   docker build -t dokploy-bun-main:latest .
 *   git stash && git checkout <pre-migration-commit>
 *   docker build -t dokploy-node-baseline:latest .
 *   bun scripts/soak-benchmark.ts                 # 8h soak, the default
 *   SOAK_HOURS=0.2 bun scripts/soak-benchmark.ts  # ~12min, to check the harness
 *
 * Four decisions that the result depends on, recorded so they can be argued with:
 *
 * 1. **Both targets run concurrently**, not one after the other. An eight-hour
 *    run cannot be repeated enough times to average out host conditions, so the
 *    only way to keep them comparable is to expose both to the same conditions at
 *    the same moment. They contend for CPU, which depresses both equally and does
 *    not manufacture a leak in either.
 *
 * 2. **Load is rate-limited, not maximised.** Under an open-throughput benchmark
 *    the faster runtime serves more requests, so a per-request leak would make it
 *    look leakier purely for being faster. Pinning both to the same requests per
 *    second makes any per-request growth directly comparable. It also means this
 *    is not a throughput benchmark and must not be quoted as one.
 *
 * 3. **`--latency-correction`** is passed to oha. At a fixed rate, uncorrected
 *    percentiles hide queueing delay behind service time, which is precisely the
 *    coordinated-omission trap. Latency here is measured from when a request was
 *    *due* to be sent, so degradation over hours shows up rather than hiding.
 *
 * 4. **An idle phase follows the soak, and then a second load phase.** This is
 *    the part that makes the result mean something. Memory rising under load is
 *    not a leak - allocator arenas, caches and a not-yet-run GC all do that. A
 *    leak is memory that does *not* come back when the load stops, and that
 *    ratchets higher on the next load phase. Growth alone would be a weaker
 *    claim than the one being tested, in either direction.
 *
 * Writes soak-samples.jsonl (one row per sample) and soak-results.json. Nothing
 * is pulled and nothing is pushed; the Docker socket is deliberately not mounted.
 */

const PG = "dokbench-pg";
const NET = "dokbench";

const HOURS = Number(process.env.SOAK_HOURS ?? "8");
/**
 * Idle and reload are absolute minutes, not fractions of the soak.
 *
 * They were fractions at first, which is wrong on reflection: how long an
 * allocator needs to return memory is a property of the allocator, not of how
 * long you loaded it beforehand. Tying them to soak length also meant a short
 * soak produced too few samples for either phase to be worth reporting, which
 * is how the first run ended up with an idle floor computed from five samples.
 */
/** Excluded from the drift fit. The climb to a working set takes about an hour. */
const WARMUP_MINUTES = Number(process.env.SOAK_WARMUP_MINUTES ?? "60");
const IDLE_MINUTES = Number(process.env.SOAK_IDLE_MINUTES ?? "60");
const RECOVER_MINUTES = Number(process.env.SOAK_RELOAD_MINUTES ?? "30");
/** One oha invocation per chunk, so load failures surface and latency is a series. */
const CHUNK_MINUTES = Number(process.env.SOAK_CHUNK_MINUTES ?? "10");
const SAMPLE_SECONDS = 60;

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
		db: "dokploy_soak_node",
		port: 3812,
		container: "dokbench-soak-node",
	},
	{
		name: "bun",
		image: "dokploy-bun-main:latest",
		db: "dokploy_soak_bun",
		port: 3811,
		container: "dokbench-soak-bun",
	},
];

/** Rates are per target and deliberately modest: this is a duration test. */
const STREAMS = [
	{ key: "health", path: "/api/health", qps: 20, concurrency: 8 },
	{ key: "ssr", path: "/register", qps: 5, concurrency: 4 },
];

/**
 * Keep the host awake for the length of the run.
 *
 * The first eight-hour attempt at this benchmark was run on a laptop on battery
 * and macOS put it into Maintenance Sleep repeatedly from hour 7.5 onward. Wall
 * clock kept advancing while nothing executed, so the sampler's 60s cadence
 * stretched to gaps of 15, 32 and 282 minutes, and oha's latency correction -
 * correctly - attributed the whole sleep to queueing delay and reported a p99 of
 * 141 seconds. None of that was a property of either runtime.
 *
 * `caffeinate -w <pid>` holds the assertion until this process exits, including
 * if it is killed, so there is no assertion to leak. Not available off Darwin,
 * where this is a no-op and the guard below is the only protection.
 */
const keepAwake = () => {
	if (process.platform !== "darwin") return null;
	try {
		return Bun.spawn(["caffeinate", "-dimsu", "-w", String(process.pid)], {
			stdout: "ignore",
			stderr: "ignore",
		});
	} catch {
		return null;
	}
};

const sh = async (cmd: string[]) => {
	const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	await new Response(p.stderr).text();
	await p.exited;
	return out.trim();
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = (t: number) => new Date(t).toISOString();

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Least-squares slope of y over x. Here: MiB per hour.
 *
 * Returns NaN below MIN_SLOPE_POINTS. A three-sample run happily reports
 * "+3884 MiB/h", which is not a leak, it is a regression through noise - and a
 * harness that emits a number like that invites exactly the misreading this
 * whole exercise is meant to correct.
 */
const MIN_SLOPE_POINTS = 12;

/**
 * Slope with its standard error, because the slope alone is not usable.
 *
 * Measured across two runs the drift estimate moved from +1.49 to +6.87 MiB/h
 * for the same image on the same host, and within one run it moved from +6.87 to
 * +14.33 depending only on how much warm-up was excluded - while its own error
 * bar widened faster than the estimate did. A bare number invites being quoted
 * as a finding; one that must be printed as `+6.87 +/- 2.84` cannot hide that it
 * is barely distinguishable from flat.
 */
const slope = (pts: Array<{ x: number; y: number }>) => {
	const n = pts.length;
	if (n < MIN_SLOPE_POINTS) return { b: Number.NaN, se: Number.NaN };
	const mx = pts.reduce((a, p) => a + p.x, 0) / n;
	const my = pts.reduce((a, p) => a + p.y, 0) / n;
	let num = 0;
	let den = 0;
	for (const p of pts) {
		num += (p.x - mx) * (p.y - my);
		den += (p.x - mx) ** 2;
	}
	if (den === 0) return { b: Number.NaN, se: Number.NaN };
	const b = num / den;
	const a0 = my - b * mx;
	const rss = pts.reduce((acc, p) => acc + (p.y - (a0 + b * p.x)) ** 2, 0);
	return { b, se: Math.sqrt(rss / (n - 2) / den) };
};

const waitForHealth = async (port: number, t0: number, timeoutMs = 300_000) => {
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
		await sleep(50);
	}
	return Number.NaN;
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

/**
 * Whether the container is still the same running process. A leak that ends in
 * an OOM kill shows up here rather than in the memory series, because Docker
 * restarts the container and RSS drops back to a healthy-looking number.
 */
const health = async (container: string) => {
	const out = await sh([
		"docker",
		"inspect",
		"--format",
		"{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.RestartCount}}|{{.State.StartedAt}}",
		container,
	]);
	const [status, exitCode, oom, restarts, startedAt] = out.split("|");
	return {
		status: status ?? "unknown",
		exitCode: Number(exitCode ?? -1),
		oomKilled: oom === "true",
		restarts: Number(restarts ?? 0),
		startedAt: startedAt ?? "",
	};
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

interface Sample {
	t: string;
	elapsedHours: number;
	phase: string;
	target: string;
	rssMib: number;
	status: string;
	restarts: number;
	oomKilled: boolean;
}

interface ChunkResult {
	t: string;
	elapsedHours: number;
	phase: string;
	target: string;
	stream: string;
	rps: number;
	p50: number;
	p95: number;
	p99: number;
	successRate: number;
}

/**
 * A phase is only reportable if the sampler actually ran on cadence throughout.
 *
 * This is the guard that matters more than the power assertion: caffeinate can
 * fail, a VM can be paused, a container host can be throttled. Reporting a
 * median computed across a gap where nothing executed produces a number that
 * looks exactly like a measurement and is not one - the precise failure this
 * whole exercise exists to argue against.
 */
const MAX_GAP_FACTOR = 3;

const gapReport = (rows: Sample[]) => {
	const gaps: Array<{ from: number; to: number; minutes: number }> = [];
	for (let i = 1; i < rows.length; i++) {
		const minutes = (rows[i]!.elapsedHours - rows[i - 1]!.elapsedHours) * 60;
		if (minutes > (SAMPLE_SECONDS / 60) * MAX_GAP_FACTOR) {
			gaps.push({
				from: rows[i - 1]!.elapsedHours,
				to: rows[i]!.elapsedHours,
				minutes,
			});
		}
	}
	return gaps;
};

const samples: Sample[] = [];
const chunks: ChunkResult[] = [];
const sampleFile = "soak-samples.jsonl";
let t0 = Date.now();
let phase = "setup";
let loading = false;

const elapsedHours = () => (Date.now() - t0) / 3_600_000;

/**
 * Appended through a FileSink rather than a read-modify-write, so an eight-hour
 * run does not get quadratically slower in its own sampler - and so the rows are
 * on disk as they happen. If the host dies at hour seven, the partial series is
 * still the answer.
 */
const sink = Bun.file(sampleFile).writer();
const appendJsonl = async (row: unknown) => {
	sink.write(`${JSON.stringify(row)}\n`);
	await sink.flush();
};

/** Samples every target on a fixed cadence for as long as the soak runs. */
const runSampler = async (until: () => boolean) => {
	while (until()) {
		for (const t of TARGETS) {
			const h = await health(t.container);
			const s: Sample = {
				t: nowIso(Date.now()),
				elapsedHours: Number(elapsedHours().toFixed(4)),
				phase,
				target: t.name,
				rssMib: Number((await rss(t.container)).toFixed(1)),
				status: h.status,
				restarts: h.restarts,
				oomKilled: h.oomKilled,
			};
			samples.push(s);
			await appendJsonl(s);
			if (h.status !== "running" || h.restarts > 0) {
				console.log(
					`  !! ${t.name} status=${h.status} exit=${h.exitCode} oom=${h.oomKilled} restarts=${h.restarts}`,
				);
			}
		}
		const line = TARGETS.map((t) => {
			const last = [...samples].reverse().find((s) => s.target === t.name);
			return `${t.name} ${last?.rssMib.toFixed(0).padStart(5)}MiB`;
		}).join("   ");
		console.log(`  [${elapsedHours().toFixed(2)}h ${phase.padEnd(8)}] ${line}`);
		await sleep(SAMPLE_SECONDS * 1000);
	}
};

/** One oha invocation. Rate-limited and latency-corrected; see the header. */
const loadChunk = async (t: Target, stream: (typeof STREAMS)[number]) => {
	const out = await sh([
		"oha",
		"-z",
		`${CHUNK_MINUTES}m`,
		"-q",
		String(stream.qps),
		"-c",
		String(stream.concurrency),
		"--latency-correction",
		"--no-tui",
		"--output-format",
		"json",
		`http://localhost:${t.port}${stream.path}`,
	]);
	try {
		const d = JSON.parse(out);
		const c: ChunkResult = {
			t: nowIso(Date.now()),
			elapsedHours: Number(elapsedHours().toFixed(4)),
			phase,
			target: t.name,
			stream: stream.key,
			rps: d.summary.requestsPerSec,
			p50: d.latencyPercentiles.p50 * 1000,
			p95: d.latencyPercentiles.p95 * 1000,
			p99: d.latencyPercentiles.p99 * 1000,
			successRate: d.summary.successRate,
		};
		chunks.push(c);
		await appendJsonl({ kind: "chunk", ...c });
		return c;
	} catch {
		console.log(
			`  !! oha produced no parseable output for ${t.name}/${stream.key}`,
		);
		return null;
	}
};

/** Keeps every stream on every target loaded until `until()` goes false. */
const runLoad = async (until: () => boolean) => {
	while (until()) {
		const all = TARGETS.flatMap((t) =>
			STREAMS.map((s) => loadChunk(t, s).then((c) => ({ t, s, c }))),
		);
		const done = await Promise.all(all);
		for (const { t, s, c } of done) {
			if (!c) continue;
			console.log(
				`  ${t.name.padEnd(4)} ${s.key.padEnd(6)} ${c.rps.toFixed(1)} rps  ` +
					`p50 ${c.p50.toFixed(1)}ms  p95 ${c.p95.toFixed(1)}ms  ` +
					`p99 ${c.p99.toFixed(1)}ms  ok ${(c.successRate * 100).toFixed(1)}%`,
			);
		}
	}
	loading = false;
};

const awake = keepAwake();
if (!awake && process.platform === "darwin") {
	console.log("  !! caffeinate unavailable - the host may sleep mid-run");
}

await setupInfra();

const results: Record<string, Record<string, unknown>> = {};
for (const t of TARGETS) results[t.name] = {};

try {
	console.log("=== boot ===");
	for (const t of TARGETS) {
		await resetDb(t.db);
		await createContainer(t);
	}
	for (const t of TARGETS) await sh(["docker", "start", t.container]);
	for (const t of TARGETS) {
		const ms = await waitForHealth(t.port, Date.now());
		console.log(`  ${t.name.padEnd(4)} healthy in ${ms}ms`);
		if (Number.isNaN(ms)) throw new Error(`${t.name} never became healthy`);
	}

	const soakMs = HOURS * 3_600_000;
	const idleMs = IDLE_MINUTES * 60_000;
	const recoverMs = RECOVER_MINUTES * 60_000;

	console.log(
		`\n=== soak: ${HOURS}h load, ${IDLE_MINUTES}min idle, ` +
			`${RECOVER_MINUTES}min reload ===`,
	);
	console.log(
		`  ${STREAMS.map((s) => `${s.key} ${s.qps}rps`).join(", ")} per target, ` +
			`sampling every ${SAMPLE_SECONDS}s\n`,
	);

	t0 = Date.now();

	// Phase 1 - baseline, before any load has touched either server.
	phase = "baseline";
	const baselineEnd = Date.now() + 5 * SAMPLE_SECONDS * 1000;
	await runSampler(() => Date.now() < baselineEnd);
	for (const t of TARGETS) {
		results[t.name]!.baselineRss = median(
			samples
				.filter((s) => s.target === t.name && s.phase === "baseline")
				.map((s) => s.rssMib),
		);
	}

	// Phase 2 - sustained load.
	phase = "soak";
	loading = true;
	const soakEnd = Date.now() + soakMs;
	await Promise.all([
		runLoad(() => Date.now() < soakEnd),
		runSampler(() => Date.now() < soakEnd || loading),
	]);

	// Phase 3 - idle. The one that separates a leak from an arena.
	phase = "idle";
	const idleEnd = Date.now() + idleMs;
	await runSampler(() => Date.now() < idleEnd);

	// Phase 4 - load again. A leak ratchets; a cache returns to its plateau.
	phase = "recover";
	loading = true;
	const recoverEnd = Date.now() + recoverMs;
	await Promise.all([
		runLoad(() => Date.now() < recoverEnd),
		runSampler(() => Date.now() < recoverEnd || loading),
	]);

	// -----------------------------------------------------------------------

	console.log("\n=== result ===");
	for (const t of TARGETS) {
		const mine = samples.filter((s) => s.target === t.name);
		const soak = mine.filter((s) => s.phase === "soak");
		const idle = mine.filter((s) => s.phase === "idle");
		const recover = mine.filter((s) => s.phase === "recover");

		// Skip a fixed WARMUP_MINUTES: the climb to a working set is not drift.
		// This was a fraction of the soak, which quietly made runs of different
		// lengths incomparable - an 8h soak excluded 48 minutes and a 3h soak 18,
		// so the two were not measuring the same quantity.
		const settled = soak.filter(
			(s) => s.elapsedHours - soak[0]!.elapsedHours >= WARMUP_MINUTES / 60,
		);
		const soakSlope = slope(
			settled.map((s) => ({ x: s.elapsedHours, y: s.rssMib })),
		);

		const soakPeak = soak.length
			? Math.max(...soak.map((s) => s.rssMib))
			: Number.NaN;
		// Late idle only - the first minutes still drain in-flight work.
		const idleFloor = idle.length
			? median(idle.slice(Math.floor(idle.length / 2)).map((s) => s.rssMib))
			: Number.NaN;
		const recoverPlateau = recover.length
			? median(
					recover.slice(Math.floor(recover.length / 2)).map((s) => s.rssMib),
				)
			: Number.NaN;
		const soakPlateau = settled.length
			? median(
					settled.slice(Math.floor(settled.length / 2)).map((s) => s.rssMib),
				)
			: Number.NaN;

		// A gap means the host stalled. Every statistic below spans it, so the
		// phase is reported as unusable rather than as a number.
		const stalls = Object.fromEntries(
			(["baseline", "soak", "idle", "recover"] as const).map((ph) => [
				ph,
				gapReport(mine.filter((x) => x.phase === ph)),
			]),
		);
		const contaminated = Object.entries(stalls)
			.filter(([, g]) => g.length > 0)
			.map(([ph]) => ph);

		const r = results[t.name]!;
		r.stalls = stalls;
		r.contaminatedPhases = contaminated;
		r.soakSlopeMibPerHour = Number(soakSlope.b.toFixed(2));
		r.soakSlopeStdErr = Number(soakSlope.se.toFixed(2));
		r.soakDriftDistinguishableFromFlat =
			Math.abs(soakSlope.b) > 2 * soakSlope.se;
		r.soakPeakRss = Number(soakPeak.toFixed(1));
		r.soakPlateauRss = Number(soakPlateau.toFixed(1));
		r.idleFloorRss = Number(idleFloor.toFixed(1));
		r.recoverPlateauRss = Number(recoverPlateau.toFixed(1));
		r.reclaimedMib = Number((soakPlateau - idleFloor).toFixed(1));
		r.ratchetMib = Number((recoverPlateau - soakPlateau).toFixed(1));
		r.phaseSamples = {
			baseline: mine.filter((s) => s.phase === "baseline").length,
			soak: soak.length,
			idle: idle.length,
			recover: recover.length,
		};
		r.restarts = Math.max(...mine.map((s) => s.restarts), 0);
		r.oomKilled = mine.some((s) => s.oomKilled);
		r.finalStatus = mine.at(-1)?.status ?? "unknown";
		r.samples = mine.length;

		const ssr = chunks.filter(
			(c) => c.target === t.name && c.stream === "ssr" && c.phase === "soak",
		);
		if (ssr.length >= MIN_SLOPE_POINTS) {
			r.ssrP99First = Number(ssr[0]!.p99.toFixed(1));
			r.ssrP99Last = Number(ssr.at(-1)!.p99.toFixed(1));
			const p99 = slope(ssr.map((c) => ({ x: c.elapsedHours, y: c.p99 })));
			r.ssrP99SlopeMsPerHour = Number(p99.b.toFixed(2));
			r.ssrP99SlopeStdErr = Number(p99.se.toFixed(2));
		}

		console.log(
			`\n  ${t.name}\n` +
				`    baseline            ${(r.baselineRss as number).toFixed(1)} MiB\n` +
				`    soak plateau        ${(r.soakPlateauRss as number).toFixed(1)} MiB\n` +
				`    soak peak           ${(r.soakPeakRss as number).toFixed(1)} MiB\n` +
				`    drift under load    ${
					Number.isNaN(soakSlope.b)
						? `not reported (${settled.length} samples, needs ${MIN_SLOPE_POINTS})`
						: `${soakSlope.b >= 0 ? "+" : ""}${soakSlope.b.toFixed(2)} +/- ${(2 * soakSlope.se).toFixed(2)} MiB/h${
								Math.abs(soakSlope.b) > 2 * soakSlope.se
									? ""
									: "  (not distinguishable from flat)"
							}`
				}\n` +
				`    idle floor          ${(r.idleFloorRss as number).toFixed(1)} MiB  (reclaimed ${(r.reclaimedMib as number).toFixed(1)} MiB)\n` +
				`    plateau on reload   ${(r.recoverPlateauRss as number).toFixed(1)} MiB  (ratchet ${(r.ratchetMib as number) >= 0 ? "+" : ""}${(r.ratchetMib as number).toFixed(1)} MiB)\n` +
				`    samples             soak ${soak.length}, idle ${idle.length}, reload ${recover.length}\n` +
				`    restarts ${r.restarts}  oom ${r.oomKilled}  final ${r.finalStatus}` +
				(r.ssrP99SlopeMsPerHour !== undefined
					? `\n    ssr p99 drift       ${(r.ssrP99SlopeMsPerHour as number) >= 0 ? "+" : ""}${r.ssrP99SlopeMsPerHour} ms/h ` +
						`(${r.ssrP99First}ms -> ${r.ssrP99Last}ms)`
					: ""),
		);
	}

	const anyContaminated = TARGETS.some(
		(t) => (results[t.name]!.contaminatedPhases as string[]).length > 0,
	);
	if (anyContaminated) {
		console.log(
			"\n  !! HOST STALLED - this run is not reportable as it stands.",
		);
		for (const t of TARGETS) {
			const stalls = results[t.name]!.stalls as Record<
				string,
				Array<{ from: number; to: number; minutes: number }>
			>;
			for (const [ph, gaps] of Object.entries(stalls)) {
				for (const g of gaps) {
					console.log(
						`     ${t.name} ${ph}: ${g.minutes.toFixed(1)} min with no samples ` +
							`(${g.from.toFixed(2)}h -> ${g.to.toFixed(2)}h)`,
					);
				}
			}
		}
		console.log(
			"     Statistics for those phases span a window where nothing executed.\n" +
				"     Latency in particular is meaningless: with --latency-correction the\n" +
				"     stall is charged to queueing delay. Re-run the affected phases.",
		);
	}

	console.log(
		"\n  Reading this: drift is only a leak if the idle floor stays high and the\n" +
			"  reload plateau ratchets above the first one. Growth that is reclaimed when\n" +
			"  load stops is a working set, not a leak.",
	);

	await Bun.write(
		"soak-results.json",
		JSON.stringify(
			{
				config: {
					hours: HOURS,
					idleMinutes: IDLE_MINUTES,
					reloadMinutes: RECOVER_MINUTES,
					streams: STREAMS,
					chunkMinutes: CHUNK_MINUTES,
					sampleSeconds: SAMPLE_SECONDS,
				},
				startedAt: nowIso(t0),
				finishedAt: nowIso(Date.now()),
				results,
				chunks,
			},
			null,
			2,
		),
	);
	console.log("\nwrote soak-results.json and soak-samples.jsonl");
} finally {
	await sink.end();
	await teardown();
	awake?.kill();
}
