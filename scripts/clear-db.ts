import { Pool } from "pg";

const DEFAULT_DATABASE_URL = "postgres://localhost:5432/marko";
const DEFAULT_SCHEMAS = ["public", "pgboss"];
const SKIPPED_TABLES = new Set([
	"__drizzle_migrations",
	"account",
	"member",
	"organization",
	"session",
	"user",
	"verification",
]);

function hasConfirmation(): boolean {
	return (
		process.argv.includes("--confirm") || process.env.CLEAR_DB_CONFIRM === "yes"
	);
}

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

async function main(): Promise<void> {
	if (!hasConfirmation()) {
		console.error(
			"Refusing to clear the database without confirmation.\n\n" +
				"Run: npm run db:clear -- --confirm\n" +
				"Or set: CLEAR_DB_CONFIRM=yes npm run db:clear",
		);
		process.exitCode = 1;
		return;
	}

	const connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
	const pool = new Pool({ connectionString });

	try {
		const { rows: databaseRows } = await pool.query<{
			current_database: string;
		}>("select current_database()");
		const databaseName = databaseRows[0]?.current_database ?? "(unknown)";

		const { rows } = await pool.query<{
			table_schema: string;
			table_name: string;
		}>(
			`
				select table_schema, table_name
				from information_schema.tables
				where table_type = 'BASE TABLE'
					and table_schema = any($1::text[])
				order by table_schema, table_name
			`,
			[DEFAULT_SCHEMAS],
		);

		const tables = rows.filter((row) => !SKIPPED_TABLES.has(row.table_name));

		if (tables.length === 0) {
			console.log(`No tables to clear in database "${databaseName}".`);
			return;
		}

		const tableList = tables
			.map(
				(row) =>
					`${quoteIdent(row.table_schema)}.${quoteIdent(row.table_name)}`,
			)
			.join(", ");

		await pool.query("begin");
		await pool.query(`truncate table ${tableList} restart identity cascade`);
		await pool.query("commit");

		console.log(
			`Cleared ${tables.length} table(s) in database "${databaseName}":\n` +
				tables
					.map((row) => `- ${row.table_schema}.${row.table_name}`)
					.join("\n"),
		);
	} catch (error) {
		await pool.query("rollback").catch(() => undefined);
		throw error;
	} finally {
		await pool.end();
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
