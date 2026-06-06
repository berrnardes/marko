import { defineConfig } from "drizzle-kit";

// Drizzle Kit configuration for schema generation and migrations.
//
// The schema file (`src/db/schema.ts`) and its tables are defined in a later
// task (9.1). This config wires up the `db:generate` / `db:migrate` npm
// scripts now so the data-layer tooling is ready.

export default defineConfig({
	dialect: "postgresql",
	schema: ["./src/db/schema.ts", "./src/db/auth-schema.ts"],
	out: "./src/db/migrations",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "postgres://postgres:uc2xwqob:5432/marko",
	},
});
