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

import { getRuntime, registerWorkers } from "@/services/runtime";

async function main(): Promise<void> {
	console.log("[worker] starting…");

	// Build (or reuse) the shared runtime: this starts pg-boss, creates the
	// durable queues, and wires the cadence/nurture/outbound workers to the live
	// Drizzle data layer.
	const runtime = await getRuntime();

	// Register the cadence, nurture, and outbound pg-boss handlers. Each delegates
	// to the already-wired worker domain logic; the web app never registers these
	// (it only enqueues), so the consumers live solely in this process.
	await registerWorkers(runtime);

	console.log(
		"[worker] ready — cadence, nurture, and outbound handlers registered.",
	);

	// Graceful shutdown: stop pg-boss so in-flight jobs are released cleanly and
	// the process exits without leaking the connection.
	const shutdown = async (signal: string): Promise<void> => {
		console.log(`[worker] received ${signal}, shutting down…`);
		try {
			await runtime.boss.stop();
		} catch (err) {
			console.error("[worker] error during shutdown:", err);
		} finally {
			process.exit(0);
		}
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
	console.error("[worker] fatal error:", err);
	process.exit(1);
});
