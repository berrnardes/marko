// Drizzle-backed MessageTemplateRepository implementation (data layer).
//
// Side-effect boundary: implements the `MessageTemplateRepository` persistence
// interface from `@/services/repositories` against the shared Drizzle client.
// The `message_templates` table stores only the templates an operator has
// customized; a key with no row falls back to the built-in default template
// (`DEFAULT_TEMPLATES` in `@/core/messages`), so a fresh database needs no seed
// and "reset to default" simply deletes the row.

import { eq } from "drizzle-orm";

import { db, type Database } from "@/db/client";
import { messageTemplates } from "@/db/schema";
import type { TemplateKey } from "@/core/types";
import type { MessageTemplateRepository } from "@/services/repositories";

/**
 * Concrete {@link MessageTemplateRepository} over Drizzle/PostgreSQL. Stateless
 * beyond the injected database client; safe to construct per request.
 */
export class DrizzleMessageTemplateRepository
	implements MessageTemplateRepository
{
	private readonly database: Database;

	constructor(database: Database = db) {
		this.database = database;
	}

	/** @inheritdoc */
	async getAll(): Promise<Partial<Record<TemplateKey, string>>> {
		const rows = await this.database.select().from(messageTemplates);
		const result: Partial<Record<TemplateKey, string>> = {};
		for (const row of rows) {
			result[row.templateKey] = row.body;
		}
		return result;
	}

	/** @inheritdoc */
	async upsert(key: TemplateKey, body: string): Promise<void> {
		await this.database
			.insert(messageTemplates)
			.values({ templateKey: key, body, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: messageTemplates.templateKey,
				set: { body, updatedAt: new Date() },
			});
	}

	/** @inheritdoc */
	async reset(key: TemplateKey): Promise<void> {
		await this.database
			.delete(messageTemplates)
			.where(eq(messageTemplates.templateKey, key));
	}
}
