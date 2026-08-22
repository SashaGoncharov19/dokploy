import { describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";

/**
 * The runtime must not hand its children an absurd RLIMIT_NOFILE.
 *
 * This guards the root cause of oven-sh/bun#8849, which is the single concrete,
 * experience-based reason upstream gave for refusing the Bun migration in
 * Dokploy/dokploy#3149: "I tried using Bun at the beginning of dokploy's
 * development, but this bug I encountered made me realize I couldn't fully trust
 * it at that time."
 *
 * The bug: Bun raised its own soft file-descriptor limit at startup to something
 * near RLIM_INFINITY. Spawned children inherited it, and any tool that reads the
 * limit into an `int` overflowed. `ssh-keyscan` did exactly that and died with
 * "fdlim_get: bad value". Bun capped the startup raise at 1<<20 to match Node
 * (oven-sh/bun#29617) and the issue was closed on 2026-07-24.
 *
 * We care because `addHostToKnownHostsCommand` in
 * `packages/server/src/utils/providers/git.ts` spawns `ssh-keyscan` on every SSH
 * clone. It is written `|| true`, so a regression would not fail a deploy - it
 * would quietly stop populating known_hosts, which is worse than a crash.
 *
 * The invariant is asserted here rather than the symptom, because the symptom
 * could not be reproduced on demand (see the ssh-keyscan test below) while the
 * cause can be measured directly.
 */
describe("child processes inherit a sane RLIMIT_NOFILE", () => {
	const softLimitOf = (prelude = "") =>
		execSync(`${prelude}ulimit -Sn`, { shell: "/bin/sh" }).toString().trim();

	/** Node's cap, and the one Bun adopted. */
	const CAP = 1 << 20;

	test("the limit a spawned child sees is finite and at or below 1<<20", () => {
		const soft = softLimitOf();

		// "unlimited" is the failure mode: it is what a child inherited before
		// the fix, and what overflows an int in the tools we spawn.
		expect(soft).not.toBe("unlimited");
		expect(Number.isNaN(Number(soft))).toBe(false);
		expect(Number(soft)).toBeGreaterThan(0);
		expect(Number(soft)).toBeLessThanOrEqual(CAP);
	});

	/**
	 * Proves the assertion above is capable of failing.
	 *
	 * Without this, the test is indistinguishable from one that reads a constant:
	 * it would pass on a runtime that had regressed, if the measurement were
	 * broken. Lowering a soft limit is always permitted, so this works unprivileged
	 * and on any host, unlike raising one.
	 */
	test("the measurement tracks the real rlimit rather than reporting a constant", () => {
		expect(softLimitOf("ulimit -Sn 256; ")).toBe("256");
		expect(softLimitOf("ulimit -Sn 512; ")).toBe("512");
		expect(softLimitOf()).not.toBe("256");
	});
});

/**
 * The symptom itself, at the exact call site.
 *
 * Read this for what it is: a smoke check, weaker than the rlimit tests above.
 * The original failure could NOT be reproduced on demand on the development host
 * even with the soft limit raised to unlimited, so this assertion cannot be shown
 * failing, and a test that cannot fail proves less than it appears to.
 *
 * It still earns its place: it proves `ssh-keyscan` spawns and runs to completion
 * under this runtime, through the same `sh -c` path the clone uses. A bogus
 * hostname keeps it offline, and the fd-limit check in ssh-keyscan runs at
 * startup - before any name resolution - so the path under test is reached
 * whether or not the host resolves.
 */
describe("ssh-keyscan runs under this runtime", () => {
	const available = (() => {
		try {
			execFileSync("command", ["-v", "ssh-keyscan"], { shell: "/bin/sh" });
			return true;
		} catch {
			return false;
		}
	})();

	test.skipIf(!available)("spawns without an fd-limit failure", () => {
		const out = execSync("ssh-keyscan -p 22 -H nohost.invalid 2>&1 || true", {
			shell: "/bin/sh",
		}).toString();

		expect(out).not.toContain("fdlim_get");
		expect(out).not.toContain("bad value");
		// It reached name resolution, so it got past its own startup checks.
		expect(out.toLowerCase()).toContain("getaddrinfo");
	});
});
