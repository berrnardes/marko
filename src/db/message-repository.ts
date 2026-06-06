// Drizzle-backed MessageRepository implementation (data layer).
//
// Side-effect boundary: implements the `MessageRepository` persistence
// interface from `@/services/repositories` against the shared Drizzle client.
// It persists the full inbound/outbound message history of a Lead (Req 19.3)
// and supports the at-least-once inbound idempotency lookup by `wa_message_id`
// (Req 7.4). Used by the inbound webhook (idempotency + raw persist), the
// inbound handler (append), and the outbound choke point's confirmed-send
// commit (append the outbound record).

import { asc, eq } from "drizzle-orm";

import { db, type Database } from "@/db/client";
import { messages } from "@/db/schema";
import type {
	MessageRecord,
	MessageRepository,
	NewMessageInput,
} from "@/services/repositories";

type MessageRow = typeof messages.$inferSelect;

/** Map a persisted message row to the domain {@link MessageRecord}. */
function toRecord(row: MessageRow): MessageRecord {
	return {
		id: row.id,
		leadId: row.leadId,
		direction: row.direction,
		content: row.content,
		waMessageId: row.waMessageId,
		numberId: row.numberId,
		createdAt: row.createdAt,
	};
}

/**
 * Concrete {@link MessageRepository} over Drizzle/PostgreSQL. Stateless beyond
 * the injected database client; safe to construct per request.
 */
export class DrizzleMessageRepository implements MessageRepository {
	private readonly database: Database;

	constructor(database: Database = db) {
		this.database = database;
	}

	/** @inheritdoc */
	async append(input: NewMessageInput): Promise<MessageRecord> {
		const [row] = await this.database
			.insert(messages)
			.values({
				leadId: input.leadId,
				direction: input.direction,
				content: input.content,
				waMessageId: input.waMessageId ?? null,
				numberId: input.numberId ?? null,
				createdAt: input.createdAt,
			})
			.returning();
		return toRecord(row);
	}

	/** @inheritdoc */
	async listByLead(leadId: string): Promise<MessageRecord[]> {
		const rows = await this.database
			.select()
			.from(messages)
			.where(eq(messages.leadId, leadId))
			.orderBy(asc(messages.createdAt));
		return rows.map(toRecord);
	}

	/** @inheritdoc */
	async findByWaMessageId(waMessageId: string): Promise<MessageRecord | null> {
		const [row] = await this.database
			.select()
			.from(messages)
			.where(eq(messages.waMessageId, waMessageId))
			.limit(1);
		return row ? toRecord(row) : null;
	}
}
