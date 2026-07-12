// Drizzle-backed ConsultantRepository implementation (data layer).
//
// Side-effect boundary: implements the `ConsultantRepository` boundary from
// `@/services/repositories` against the shared Drizzle client. This is the one
// place the application touches Better Auth's tables (`member` ⋈ `user`), and
// it touches only the domain-owned columns the application added to them —
// `user.phone_e164`, `user.phone_verified_at`, and
// `member.receives_handoff_alerts`. Everything Better Auth manages (identity,
// sessions, memberships themselves) stays written by Better Auth alone (see
// `@/db/auth-schema`).
//
// A handoff-alert recipient must satisfy all three gates: the membership has
// `receives_handoff_alerts` on, and the user has a phone that is VERIFIED
// (`phone_verified_at` stamped server-side after the WhatsApp confirmation
// loop). Until `tenant_id` lands on the domain tables the recipient query is
// org-agnostic; it then gains an organization filter so each lead alerts only
// its own org's consultants.

import { and, eq, isNotNull } from "drizzle-orm";

import { member, user } from "@/db/auth-schema";
import { db, type Database } from "@/db/client";
import type {
	ConsultantNotificationSettings,
	ConsultantRepository,
} from "@/services/repositories";

/** Drizzle-backed {@link ConsultantRepository} over `member` ⋈ `user`. */
export class DrizzleConsultantRepository implements ConsultantRepository {
	private readonly database: Database;

	constructor(database: Database = db) {
		this.database = database;
	}

	/** @inheritdoc */
	async listHandoffAlertRecipients(): Promise<string[]> {
		const rows = await this.database
			.selectDistinct({ phoneE164: user.phoneE164 })
			.from(member)
			.innerJoin(user, eq(member.userId, user.id))
			.where(
				and(
					eq(member.receivesHandoffAlerts, true),
					isNotNull(user.phoneE164),
					isNotNull(user.phoneVerifiedAt),
				),
			);
		return rows
			.map((row) => row.phoneE164)
			.filter((phone): phone is string => phone !== null);
	}

	/** @inheritdoc */
	async getNotificationSettings(
		userId: string,
		organizationId: string,
	): Promise<ConsultantNotificationSettings | null> {
		const [row] = await this.database
			.select({
				phoneE164: user.phoneE164,
				phoneVerifiedAt: user.phoneVerifiedAt,
				receivesHandoffAlerts: member.receivesHandoffAlerts,
			})
			.from(member)
			.innerJoin(user, eq(member.userId, user.id))
			.where(
				and(
					eq(member.userId, userId),
					eq(member.organizationId, organizationId),
				),
			)
			.limit(1);
		return row ?? null;
	}

	/** @inheritdoc */
	async setPhone(userId: string, phoneE164: string): Promise<void> {
		await this.database
			.update(user)
			.set({ phoneE164, phoneVerifiedAt: null, updatedAt: new Date() })
			.where(eq(user.id, userId));
	}

	/** @inheritdoc */
	async stampPhoneVerified(
		userId: string,
		phoneE164: string,
		at: Date,
	): Promise<boolean> {
		const stamped = await this.database
			.update(user)
			.set({ phoneVerifiedAt: at, updatedAt: new Date() })
			.where(and(eq(user.id, userId), eq(user.phoneE164, phoneE164)))
			.returning({ id: user.id });
		return stamped.length > 0;
	}

	/** @inheritdoc */
	async setAlertOptIn(
		userId: string,
		organizationId: string,
		enabled: boolean,
	): Promise<void> {
		await this.database
			.update(member)
			.set({ receivesHandoffAlerts: enabled })
			.where(
				and(
					eq(member.userId, userId),
					eq(member.organizationId, organizationId),
				),
			);
	}
}
