import pino from "pino";
import pretty from "pino-pretty";

// pino-pretty as a stream rather than a `transport`. The transport form spawns a
// worker thread that loads thread-stream/lib/worker.js by absolute path, which is
// baked in at bundle time and does not exist in the runtime image - the service
// started and then died on it. Same output, no worker.
export const logger = pino(
	pretty({
		colorize: true,
	}),
);
