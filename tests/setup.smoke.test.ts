import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

// Smoke test: confirms the Vitest + fast-check toolchain is wired up and that
// the global fast-check configuration defaults each property to >= 100 runs
// (set in vitest.setup.ts). This is a scaffolding check, not domain logic.
describe("toolchain smoke test", () => {
	it("runs a fast-check property", () => {
		fc.assert(
			fc.property(fc.integer(), fc.integer(), (a, b) => {
				return a + b === b + a;
			}),
		);
	});

	it("defaults property runs to at least 100 iterations", () => {
		let runs = 0;
		fc.assert(
			fc.property(fc.integer(), () => {
				runs += 1;
				return true;
			}),
		);
		expect(runs).toBeGreaterThanOrEqual(100);
	});

	it("reads the global numRuns configuration", () => {
		expect(fc.readConfigureGlobal()?.numRuns).toBe(100);
	});
});
