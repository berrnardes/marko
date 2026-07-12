// Auth_Service — Better Auth server instance and session helpers (Req 21).
//
// Side-effect boundary: this is the authentication composition root. Unlike the
// domain services (which depend only on repository INTERFACES), the Auth_Service
// legitimately wires Better Auth — which owns and migrates its own tables — to
// the concrete Drizzle client (`@/db/client`) through Better Auth's Drizzle
// adapter. It performs authentication I/O (session create/read/expire) directly.
//
// Responsibilities:
//   - Configure Better Auth with the Drizzle adapter over PostgreSQL.
//   - Expose `auth` (the server instance) for the Next.js route handler and for
//     server-side session validation.
//   - Provide `getServerSession`, the server-side guard used by protected
//     pages and internal data endpoints to deny unauthenticated or expired
//     sessions (Req 21.1, 21.3).

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { headers as nextHeaders } from "next/headers";

import { authSchema, member } from "@/db/auth-schema";
import { db } from "@/db/client";

/**
 * The Better Auth server instance, backed by the Drizzle adapter over the
 * shared PostgreSQL client. Email/password is enabled as the operator login
 * method; `nextCookies()` lets server actions set the session cookie.
 *
 * The secret and base URL are read from the environment by name (never
 * hard-coded): `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`.
 *
 * Multi-tenancy: the `organization` plugin models each customer as an
 * organization (tenant). Public self-service registration is open — the
 * `/signup` page creates the user and their organization in one flow — and
 * the session-creation hook stamps `activeOrganizationId` from the user's
 * first membership so every login lands scoped to their tenant.
 */
export const auth = betterAuth({
	database: drizzleAdapter(db, {
		provider: "pg",
		schema: authSchema,
	}),
	secret: process.env.BETTER_AUTH_SECRET,
	baseURL: process.env.BETTER_AUTH_URL,
	emailAndPassword: {
		enabled: true,
	},
	user: {
		additionalFields: {
			// Consultant WhatsApp for handoff alerts (E.164). Settable by the
			// user; verification is stamped server-side only, so a client can
			// never mark its own number verified.
			phoneE164: {
				type: "string",
				required: false,
				input: true,
			},
			phoneVerifiedAt: {
				type: "date",
				required: false,
				input: false,
			},
		},
	},
	databaseHooks: {
		user: {
			update: {
				before: async (data) => {
					// A phone changed through any Better Auth path must re-verify:
					// drop the stamp whenever `phoneE164` is written without an
					// accompanying (server-set) `phoneVerifiedAt`. The settings flow
					// writes through `DrizzleConsultantRepository.setPhone`, which
					// resets it itself; this guards the generic update-user path.
					if ("phoneE164" in data && !("phoneVerifiedAt" in data)) {
						return { data: { ...data, phoneVerifiedAt: null } };
					}
					return { data };
				},
			},
		},
		session: {
			create: {
				before: async (session) => {
					const [membership] = await db
						.select({ organizationId: member.organizationId })
						.from(member)
						.where(eq(member.userId, session.userId))
						.limit(1);
					return {
						data: {
							...session,
							activeOrganizationId: membership?.organizationId ?? null,
						},
					};
				},
			},
		},
	},
	plugins: [
		organization({
			schema: {
				member: {
					additionalFields: {
						// Per-membership opt-in to handoff alerts (default on), so
						// the same consultant can mute one org without another.
						receivesHandoffAlerts: {
							type: "boolean",
							required: false,
							defaultValue: true,
							input: false,
						},
					},
				},
			},
		}),
		nextCookies(),
	],
});

/** A validated session as returned by Better Auth, or `null` when none/expired. */
export type ServerSession = Awaited<ReturnType<typeof auth.api.getSession>>;

/**
 * Resolve and validate the current request's session on the server (Req 21.1,
 * 21.3). Returns the session when the caller is authenticated with a live
 * session, or `null` when unauthenticated or the session has expired. Better
 * Auth enforces expiry against `session.expiresAt` server-side, so an expired
 * cookie resolves to `null` here regardless of its presence.
 */
export async function getServerSession(): Promise<ServerSession> {
	return auth.api.getSession({ headers: await nextHeaders() });
}
