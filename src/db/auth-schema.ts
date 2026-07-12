// Better Auth Drizzle schema (PostgreSQL, default schema).
//
// Better Auth owns these tables (`user`, `session`, `account`, `verification`,
// and the organization plugin's `organization`, `member`, `invitation`) and is
// the only writer of them; the application's domain tables live in
// `./schema.ts`. They are kept in this separate file — rather than mixed into
// the application schema — to preserve that ownership boundary (Req 21): the
// application never WRITES these rows (Better Auth manages their lifecycle
// through its own adapter/CLI); the one application reader is the read-only
// `DrizzleConsultantRepository`, which resolves handoff-alert recipients from
// `member` ⋈ `user`.
//
// The column shapes mirror Better Auth's core schema exactly so the Drizzle
// adapter (see `@/services/auth`) can map each model onto the matching table.
// The exported variable names (`user`, `session`, `account`, `verification`)
// intentionally equal Better Auth's model names so the adapter resolves them
// without extra mapping.

import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Authenticated CRM user — an Operator or Consultant (Req 21.2). */
export const user = pgTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").notNull().default(false),
	image: text("image"),
	phoneE164: text("phone_e164"),
	phoneVerifiedAt: timestamp("phone_verified_at"),
	createdAt: timestamp("created_at").notNull().defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * A login session. `expiresAt` is the single source of truth for session
 * expiry; an unauthenticated or expired session is denied access to Lead data
 * (Req 21.1, 21.3).
 */
export const session = pgTable("session", {
	id: text("id").primaryKey(),
	expiresAt: timestamp("expires_at").notNull(),
	token: text("token").notNull().unique(),
	createdAt: timestamp("created_at").notNull().defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	activeOrganizationId: text("active_organization_id"),
});

/** Credential / OAuth account linkage owned by Better Auth. */
export const account = pgTable("account", {
	id: text("id").primaryKey(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at"),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
	scope: text("scope"),
	password: text("password"),
	createdAt: timestamp("created_at").notNull().defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Short-lived verification tokens (e.g. email verification) owned by Better Auth. */
export const verification = pgTable("verification", {
	id: text("id").primaryKey(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: timestamp("expires_at").notNull(),
	createdAt: timestamp("created_at").notNull().defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * A tenant (Better Auth organization plugin). Every signup creates one
 * organization — the customer's workspace — and all domain data is scoped to
 * it as the multi-tenant seams land.
 */
export const organization = pgTable("organization", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	slug: text("slug").notNull().unique(),
	logo: text("logo"),
	createdAt: timestamp("created_at").notNull().defaultNow(),
	metadata: text("metadata"),
});

/** A user's membership (and role) in an organization. */
export const member = pgTable("member", {
	id: text("id").primaryKey(),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	role: text("role").notNull().default("member"),
	receivesHandoffAlerts: boolean("receives_handoff_alerts")
		.notNull()
		.default(true),
	createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** A pending invite for a user to join an organization. */
export const invitation = pgTable("invitation", {
	id: text("id").primaryKey(),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	email: text("email").notNull(),
	role: text("role"),
	status: text("status").notNull().default("pending"),
	expiresAt: timestamp("expires_at").notNull(),
	inviterId: text("inviter_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
});

/** The Better Auth table set, keyed by model name for the Drizzle adapter. */
export const authSchema = {
	user,
	session,
	account,
	verification,
	organization,
	member,
	invitation,
} as const;
