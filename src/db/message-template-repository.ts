// Drizzle-backed MessageTemplateRepository implementation (data layer).
//
// Side-effect boundary: implements the `MessageTemplateRepository` persistence
// interface from `@/services/repositories` against the shared Drizzle client.
// The `message_templates` table stores only the templates an operator has
// customized; a key with no row falls back to the built-in default template
// (`DEFAULT_TEMPLATES` in `@/core/messages`), so a fresh database needs no seed
// and "reset to default" simply deletes the row.

import { and, eq } from "drizzle-orm";

import { db, type Database } from "@/db/client";
import { messageTemplates } from "@/db/schema";
import type { TemplateKey } from "@/core/types";
import type { MessageTemplateRepository } from "@/services/repositories";

/**
 * Concrete {@link MessageTemplateRepository} over Drizzle/PostgreSQL, bound to
 * ONE organization at construction. The table's primary key is
 * `(organization_id, template_key)`, so each tenant customizes its own copy of a
 * template; before the tenancy retrofit the key was `template_key` alone and
 * every organization edited the same six rows. A tenant that has customized
 * nothing simply has no rows and falls back to the built-in defaults, so a new
 * organization needs no seed. Stateless beyond the injected org + database
 * client; safe to construct per request.
 */
export class DrizzleMessageTemplateRepository
	implements MessageTemplateRepository
{
	private readonly organizationId: string;
	private readonly database: Database;

	constructor(organizationId: string, database: Database = db) {
		this.organizationId = organizationId;
		this.database = database;
	}

	/** @inheritdoc */
	async getAll(): Promise<Partial<Record<TemplateKey, string>>> {
		const rows = await this.database
			.select()
			.from(messageTemplates)
			.where(eq(messageTemplates.organizationId, this.organizationId));
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
			.values({
				organizationId: this.organizationId,
				templateKey: key,
				body,
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				// The conflict target is the composite primary key, so one tenant's
				// edit can never overwrite another's row for the same key.
				target: [messageTemplates.organizationId, messageTemplates.templateKey],
				set: { body, updatedAt: new Date() },
			});
	}

	/** @inheritdoc */
	async reset(key: TemplateKey): Promise<void> {
		await this.database
			.delete(messageTemplates)
			.where(
				and(
					eq(messageTemplates.organizationId, this.organizationId),
					eq(messageTemplates.templateKey, key),
				),
			);
	}
}
