// Data layer (Drizzle ORM + PostgreSQL).
//
// Holds the Drizzle schema, migrations, the database client, and the repository
// implementations (leads, messages, scheduled jobs, numbers, compliance
// records). Better Auth and pg-boss own their own schemas alongside these
// tables in the same PostgreSQL database.
//
// Modules are added by subsequent tasks; this barrel intentionally exports
// nothing yet.
export {};
