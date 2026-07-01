// Worker process entry point.
//
// This is the long-running companion to the Next.js web app. It boots the
// shared runtime (pg-boss + the wired domain services from
// `@/services/runtime`) and registers the cadence, nurture, and outbound job
// handlers (design "Entry points"). It shares the same domain modules
// (`src/core`, `src/services`, `src/db`) as the web app; only the entry point
// differs — the web app enqueues jobs and the worker consumes them.
//
// Run with: `npm run worker` (tsx src/worker/index.ts).

import { logger } from "@/logger";
import { getRuntime, registerWorkers } from "@/services/runtime";

async function main(): Promise<void> {
	logger.info({ event: "worker.starting" }, "worker starting");

	// Build (or reuse) the shared runtime: this starts pg-boss, creates the
	// durable queues, and wires the cadence/nurture/outbound workers to the live
	// Drizzle data layer.
	const runtime = await getRuntime();

	// Register the cadence, nurture, and outbound pg-boss handlers. Each delegates
	// to the already-wired worker domain logic; the web app never registers these
	// (it only enqueues), so the consumers live solely in this process.
	await registerWorkers(runtime);

	logger.info(
		{ event: "worker.ready" },
		"worker ready — cadence, nurture, and outbound handlers registered",
	);

	// Graceful shutdown: stop pg-boss so in-flight jobs are released cleanly and
	// the process exits without leaking the connection.
	const shutdown = async (signal: string): Promise<void> => {
		logger.info({ event: "worker.shutdown", signal }, "worker shutting down");
		try {
			await runtime.boss.stop();
		} catch (err) {
			logger.error(
				{ event: "worker.shutdown_error", err },
				"error during worker shutdown",
			);
		} finally {
			process.exit(0);
		}
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
	logger.fatal({ event: "worker.fatal", err }, "worker fatal error");
	process.exit(1);
});
