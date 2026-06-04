// Worker process entry point.
//
// This is the long-running companion to the Next.js web app. It boots pg-boss
// and registers the cadence, nurture, and outbound job handlers. It shares the
// same domain modules (`src/core`, `src/services`, `src/db`) as the web app;
// only the entry point differs.
//
// Run with: `npm run worker` (tsx src/worker/index.ts).
//
// The pg-boss wiring and handler registration are implemented in later tasks
// (see task 23.1). For now this is a minimal, runnable bootstrap.

async function main(): Promise<void> {
	console.log("[worker] starting…");

	// pg-boss start + handler registration (cadence / nurture / outbound) is
	// added in task 23.1. Keeping this as the single, shared entry point now so
	// the npm script and process model exist from the start.

	// Graceful shutdown so the process can be stopped cleanly once pg-boss is
	// wired in.
	const shutdown = (signal: string) => {
		console.log(`[worker] received ${signal}, shutting down…`);
		process.exit(0);
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));

	console.log("[worker] ready (no handlers registered yet).");
}

main().catch((err) => {
	console.error("[worker] fatal error:", err);
	process.exit(1);
});
