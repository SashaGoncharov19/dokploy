/// <reference types="bun" />

/**
 * Minimal pseudo-terminal wrapper over Bun's native `Bun.Terminal`.
 *
 * Replaces `node-pty`, which does not work under Bun: the PTY child exits a few
 * milliseconds after spawn and `resize()` then throws `EBADF`. Reproduced on both
 * macOS arm64 and Debian, with Node passing the identical test - see
 * docs/bun-migration/SPIKE-RESULTS.md.
 *
 * The surface deliberately mirrors the slice of node-pty this codebase used, so the
 * WebSocket handlers read the same as before and all Bun-specific detail stays here.
 */

export interface PtyOptions {
	name?: string;
	cwd?: string;
	env?: Record<string, string | undefined>;
	cols?: number;
	rows?: number;
}

export interface PtyProcess {
	onData(listener: (data: string) => void): void;
	onExit(listener: (exitCode: number) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
	readonly pid: number;
}

export const spawnPty = (
	file: string,
	args: string[],
	options: PtyOptions = {},
): PtyProcess => {
	const { name = "xterm-256color", cwd, env, cols = 80, rows = 30 } = options;

	const decoder = new TextDecoder();
	const dataListeners: ((data: string) => void)[] = [];
	const exitListeners: ((exitCode: number) => void)[] = [];

	const proc = Bun.spawn({
		cmd: [file, ...args],
		cwd,
		// Bun.spawn rejects undefined values; node-pty tolerated process.env directly.
		env: env
			? (Object.fromEntries(
					Object.entries(env).filter(([, v]) => v !== undefined),
				) as Record<string, string>)
			: undefined,
		terminal: {
			cols,
			rows,
			name,
			// Note the leading `terminal` argument - Bun passes the Terminal instance
			// first, unlike node-pty's onData(data). Getting this wrong silently hands
			// the callback a Terminal where a chunk is expected.
			data(_terminal, chunk: Uint8Array) {
				const text = decoder.decode(chunk, { stream: true });
				for (const listener of dataListeners) {
					listener(text);
				}
			},
			exit(_terminal, exitCode: number) {
				for (const listener of exitListeners) {
					listener(exitCode ?? 0);
				}
			},
		},
	});

	return {
		onData(listener) {
			dataListeners.push(listener);
		},
		onExit(listener) {
			exitListeners.push(listener);
		},
		write(data) {
			proc.terminal?.write(data);
		},
		resize(nextCols, nextRows) {
			proc.terminal?.resize(nextCols, nextRows);
		},
		kill() {
			// `proc.kill()` with no signal is a NO-OP on PTY-attached subprocesses in
			// Bun 1.3.14: the child stays in `ps`, `proc.exited` never resolves and the
			// exit callback never fires. Using it here would leak a `docker exec` or
			// `docker logs --follow` process on every closed WebSocket.
			//
			// Closing the PTY is the equivalent of node-pty's kill() (SIGHUP to the
			// foreground process group); the explicit SIGKILL guarantees termination
			// for children that ignore it, and is a no-op once the process is gone.
			proc.terminal?.close();
			proc.kill("SIGKILL");
		},
		get pid() {
			return proc.pid;
		},
	};
};
