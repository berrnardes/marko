// Domain services (I/O + orchestration).
//
// This layer wires the pure core to the outside world: the WAHA client,
// anti-ban controller, lifecycle/compliance/handoff managers, the lead
// importer, the cadence/nurture/outbound workers' domain logic, the LangGraph
// qualification agent, and the inbound handler. Services read/write PostgreSQL,
// enqueue/cancel pg-boss jobs, and call external APIs through injectable seams.
//
// Service implementations are added by subsequent tasks. The repository
// interfaces (the persistence I/O boundary the services depend on) live in
// `./repositories` and are re-exported here.
export * from "./repositories";
export * from "./waha-client";
