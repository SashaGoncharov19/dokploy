import http from "node:http";
import {
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	IS_CLOUD,
	initCancelDeployments,
	initCronJobs,
	initEnterpriseBackupCronJobs,
	initializeNetwork,
	initSchedules,
	initVolumeBackupsCronJobs,
	sendDokployRestartNotifications,
	setupDirectories,
} from "@dokploy/server";
import next from "next";
import packageInfo from "../package.json";
import { setupDockerContainerLogsWebSocketServer } from "./wss/docker-container-logs";
import { setupDockerContainerTerminalWebSocketServer } from "./wss/docker-container-terminal";
import { setupDockerStatsMonitoringSocketServer } from "./wss/docker-stats";
import { setupDrawerLogsWebSocketServer } from "./wss/drawer-logs";
import { setupDeploymentLogsWebSocketServer } from "./wss/listen-deployment";
import { setupTerminalWebSocketServer } from "./wss/terminal";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const dev = process.env.NODE_ENV !== "production";

// Initialize critical directories and Traefik config BEFORE Next.js starts
// This prevents race conditions with the install script
if (process.env.NODE_ENV === "production" && !IS_CLOUD) {
	setupDirectories();
	createDefaultTraefikConfig();
	createDefaultServerTraefikConfig();
	console.log("✅ initialization complete");
}

// Passing `turbopack: false` is not an opt-out: with neither flag truthy Next 16
// falls through to `process.env.TURBOPACK ??= "auto"` and uses Turbopack anyway.
// Webpack has to be asked for explicitly. Turbopack's dev output refers to
// externalised packages by a hash-suffixed synthetic name that Bun's resolver
// cannot resolve ("Cannot find package 'next-themes-6b0513a0c1105732'"), so under
// Bun the dev server only works on webpack. This also matches `next build
// --webpack`, so dev and build now use the same bundler.
const useTurbopack = process.env.TURBOPACK === "1";
const app = next({ dev, turbopack: useTurbopack, webpack: !useTurbopack });
const handle = app.getRequestHandler();
void app.prepare().then(async () => {
	try {
		console.log("Running DokployVersion: ", packageInfo.version);
		const server = http.createServer((req, res) => {
			handle(req, res);
		});

		// WEBSOCKET
		setupDrawerLogsWebSocketServer(server);
		setupDeploymentLogsWebSocketServer(server);
		setupDockerContainerLogsWebSocketServer(server);
		setupDockerContainerTerminalWebSocketServer(server);
		setupTerminalWebSocketServer(server);
		if (!IS_CLOUD) {
			setupDockerStatsMonitoringSocketServer(server);
		}

		server.listen(PORT, HOST);
		console.log(`Server Started on: http://${HOST}:${PORT}`);
		if (process.env.NODE_ENV === "production" && !IS_CLOUD) {
			createDefaultMiddlewares();
			await initializeNetwork();
			await initCronJobs();
			await initSchedules();
			await initCancelDeployments();
			await initVolumeBackupsCronJobs();
			await sendDokployRestartNotifications();
		}
		await initEnterpriseBackupCronJobs();

		if (!IS_CLOUD) {
			console.log("Starting Deployment Worker");
			const { startDeploymentWorker } = await import("./queues/queueSetup");
			await startDeploymentWorker();
		}
	} catch (e) {
		console.error("Main Server Error", e);
	}
});
