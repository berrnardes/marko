import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Discover unit + property tests co-located in src and under tests/.
		include: ["src/**/*.{test,spec}.ts", "tests/**/*.{test,spec}.ts"],
		// Loaded before each test file; sets the fast-check global defaults
		// (>= 100 runs per property) used across the property-based tests.
		setupFiles: ["./vitest.setup.ts"],
		environment: "node",
	},
	resolve: {
		alias: {
			// Mirror the "@/*" -> "./src/*" path mapping from tsconfig.json so tests
			// can import domain modules the same way the app does.
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
});
