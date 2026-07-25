// Pure core (no I/O).
//
// This layer holds deterministic, side-effect-free functions over plain values:
// phone normalization, the lifecycle transition table, the send guard, opt-out
// detection, anti-ban accounting (cap/ramp/delay/window math), cadence timing,
// and message templating. These functions hold the testable correctness
// properties and are property-tested with fast-check.
//
// The shared domain types, enums, and injectable seams (`Clock`, `Rng`) live in
// `./types` and are re-exported here.
//
// Lead scoring and score-band classification were removed with the beta scope
// cuts (ADR-002).
export * from "./anti-ban";
export * from "./cadence";
export * from "./lifecycle";
export * from "./messages";
export * from "./opt-out";
export * from "./phone";
export * from "./send-guard";
export * from "./types";
