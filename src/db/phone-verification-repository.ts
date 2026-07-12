// Drizzle-backed PhoneVerificationRepository implementation (data layer).
//
// Side-effect boundary: implements the `PhoneVerificationRepository`
// persistence interface from `@/services/repositories` against the shared
// Drizzle client. Holds the pending phone-verification state — the hashed
// 6-digit code, its expiry, and the wrong-guess counter — keyed by user id, so
// starting a new verification replaces any pending one (`ON CONFLICT` upsert
// on the `user_id` primary key).

import { eq, sql } from "drizzle-orm";

import { db, type Database } from "@/db/client";
import { phoneVerifications } from "@/db/schema";
import type {
	PhoneVerificationRecord,
	PhoneVerificationRepository,
} from "@/services/repositories";

/** Drizzle-backed {@link PhoneVerificationRepository} over `phone_verifications`. */
export class DrizzlePhoneVerificationRepository
	implements PhoneVerificationRepository
{
	private readonly database: Database;

	constructor(database: Database = db) {
		this.database = database;
	}

	/** @inheritdoc */
	async upsert(input: {
		userId: string;
		phoneE164: string;
		codeHash: string;
		expiresAt: Date;
	}): Promise<void> {
		await this.database
			.insert(phoneVerifications)
			.values(input)
			.onConflictDoUpdate({
				target: phoneVerifications.userId,
				set: {
					phoneE164: input.phoneE164,
					codeHash: input.codeHash,
					expiresAt: input.expiresAt,
					attempts: 0,
					createdAt: new Date(),
				},
			});
	}

	/** @inheritdoc */
	async findByUser(userId: string): Promise<PhoneVerificationRecord | null> {
		const [row] = await this.database
			.select()
			.from(phoneVerifications)
			.where(eq(phoneVerifications.userId, userId))
			.limit(1);
		return row ?? null;
	}

	/** @inheritdoc */
	async incrementAttempts(userId: string): Promise<number> {
		const [row] = await this.database
			.update(phoneVerifications)
			.set({ attempts: sql`${phoneVerifications.attempts} + 1` })
			.where(eq(phoneVerifications.userId, userId))
			.returning({ attempts: phoneVerifications.attempts });
		return row?.attempts ?? 0;
	}

	/** @inheritdoc */
	async delete(userId: string): Promise<void> {
		await this.database
			.delete(phoneVerifications)
			.where(eq(phoneVerifications.userId, userId));
	}
}
