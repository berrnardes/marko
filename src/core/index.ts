// Pure core (no I/O).
//
// This layer holds deterministic, side-effect-free functions over plain values:
// phone normalization, scoring/classification, the lifecycle transition table,
// the send guard, opt-out detection, anti-ban accounting (cap/ramp/delay/window
// math), cadence/nurture timing, and message templating. These functions hold
// the testable correctness properties and are property-tested with fast-check.
//
// Pure functions (normalization, scoring, transitions, anti-ban math, etc.) are
// added by subsequent tasks. The shared domain types, enums, and injectable
// seams (`Clock`, `Rng`) live in `./types` and are re-exported here.
export * from "./classify";
export * from "./lifecycle";
export * from "./phone";
export * from "./scoring";
export * from "./types";
