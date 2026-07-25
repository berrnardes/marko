// Domain services (I/O + orchestration).
//
// This layer wires the pure core to the outside world: the WAHA client,
// anti-ban controller, lifecycle/compliance/handoff managers, the lead
// importer, the cadence/outbound workers' domain logic, and the inbound
// handler. Services read/write PostgreSQL, enqueue/cancel pg-boss jobs, and call
// external APIs through injectable seams.
//
// The repository interfaces (the persistence I/O boundary the services depend
// on) live in `./repositories` and are re-exported here.
//
// The scoring engine and the monthly-nurture scheduler/worker were removed with
// the beta scope cuts (ADR-002): a lead that exhausts its cadence now reaches a
// terminal state instead of entering a second, parallel cadence.
export * from "./anti-ban-controller";
export * from "./cadence-scheduler";
export * from "./cadence-worker";
export * from "./compliance-manager";
export * from "./handoff-manager";
export * from "./handoff-notifier";
export * from "./inbound-handler";
export * from "./inbound-webhook";
export * from "./lead-importer";
export * from "./lifecycle-manager";
export * from "./outbound-worker";
export * from "./repositories";
export * from "./waha-client";
