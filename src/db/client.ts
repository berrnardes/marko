// Drizzle/PostgreSQL client (data-layer composition root).
//
// Side-effect boundary: this is one of the few modules that holds a live
// database connection. It opens a single shared `pg` connection pool and wraps
// it with Drizzle, exposing both the application schema (`./schema`) and the
// Better Auth schema (`./auth-schema`) so a single client can serve the domain
// repositories and the Better Auth Drizzle adapter (see `@/services/auth`).
//
// This module is intentionally NOT re-exported from the `@/db` barrel so that
// importing schema types stays free of connection side effects; consumers that
// genuinely need the live client import `@/db/client` explicitly.

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { authSchema } from "./auth-schema";
import * as appSchema from "./schema";

/** Connection string for the shared PostgreSQL instance (Tech: `DATABASE_URL`). */
const connectionString = process.env.DATABASE_URL;

/**
 * Shared connection pool. A module-level singleton is reused across hot reloads
 * in development so repeated imports do not exhaust PostgreSQL connections.
 */
const globalForDb = globalThis as unknown as { __markoPgPool?: Pool };

export const pool: Pool =
	globalForDb.__markoPgPool ?? new Pool({ connectionString });

if (process.env.NODE_ENV !== "production") {
	globalForDb.__markoPgPool = pool;
}

/** Drizzle client bound to the combined application + Better Auth schema. */
export const db = drizzle(pool, { schema: { ...appSchema, ...authSchema } });

export type Database = typeof db;
