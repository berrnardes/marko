// Data layer (Drizzle ORM + PostgreSQL).
//
// Holds the Drizzle schema, migrations, the database client, and the repository
// implementations (leads, messages, scheduled jobs, numbers, compliance
// records). Better Auth and pg-boss own their own schemas alongside these
// tables in the same PostgreSQL database.
//
// The schema (tables, enum value tuples, and the row types Drizzle infers) is
// re-exported here so consumers import the data layer from a single barrel; the
// database client and repository implementations are added by task 9.2.
export * from "./schema";
