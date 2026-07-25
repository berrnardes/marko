-- PR3 — Row-Level Security: the database-side safety net (ADR-004).
--
-- The application already scopes every query by organization (PR2). This
-- script makes the DATABASE enforce it too, so a query that forgets its filter
-- returns ZERO rows instead of every tenant's.
--
-- DELIBERATELY NOT A DRIZZLE MIGRATION. It is kept out of
-- `src/db/migrations/` and out of `_journal.json` because:
--   - drizzle-kit models neither policies nor roles, so it could never
--     generate or diff this;
--   - it depends on roles that must be created out-of-band with superuser
--     (`rls-roles.sql`), which a migration runner cannot order; and
--   - `drizzle-kit migrate` fails silently in this project, and this is the
--     one change that must never be assumed applied.
-- Apply it by hand and verify with the queries at the bottom.
--
-- Prerequisites, in order — read
-- `docs/adr/004-rls-como-rede-de-seguranca.md` first:
--
--   1. `scripts/backfill-organization-id.ts` has run and migration 0002 is
--      applied: this assumes `organization_id` exists and is NOT NULL on all
--      nine tables.
--   2. `docs/ops/rls-roles.sql` has run (needs superuser).
--   3. The worker's `DATABASE_URL` switches to `marko_worker` in the SAME
--      window. `FORCE` applies policies to the table owner, so a worker still
--      connecting as `marko` stops working the moment this lands.
--
-- Apply (directly to Postgres, NOT through PgBouncer):
--
--   docker compose exec -T postgres psql -U marko -d marko -v ON_ERROR_STOP=1 \
--     -f - < docs/ops/rls-policies.sql
--
-- Rollback: `ALTER TABLE <t> DISABLE ROW LEVEL SECURITY;` on the nine tables.
-- The policies can be left in place; they are inert while RLS is disabled.
--
-- The `--> statement-breakpoint` markers mirror the convention of the Drizzle
-- migrations; psql ignores them as comments.

-- ---------------------------------------------------------------------------
-- Tenant context
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS app;--> statement-breakpoint

-- The organization the current transaction is acting for, or NULL when none
-- was set. `withOrg()` in the application sets it with
-- `set_config('app.org_id', $1, true)` — the `true` scopes the value to the
-- transaction, which is what makes this safe under PgBouncer's transaction
-- pooling (a session-level SET would leak into the next client to borrow the
-- connection).
--
-- The empty string is normalized to NULL so a blank value can never be
-- mistaken for a real organization id.
CREATE OR REPLACE FUNCTION app.current_org() RETURNS text
	LANGUAGE sql
	STABLE
	PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.org_id', true), '') $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Inbound chicken-and-egg: resolve a WAHA session to its owning organization
-- ---------------------------------------------------------------------------

-- A WAHA webhook delivery identifies itself only by session name, so the
-- organization is unknown before this lookup — and the lookup itself reads a
-- policy-protected table. This function is the deliberate, minimal hole:
-- SECURITY DEFINER, owned by `marko_rls_bypass` (a NOLOGIN role carrying
-- BYPASSRLS), returning ONLY the id/organization pair for one session name.
-- It exposes no other column and no other table.
--
-- `session_name` carries a global UNIQUE constraint (migration 0002), so this
-- returns at most one row.
CREATE OR REPLACE FUNCTION app.resolve_session_org(p_session text)
	RETURNS TABLE (number_id uuid, organization_id text)
	LANGUAGE sql
	STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT n.id, n.organization_id
	FROM public.whatsapp_numbers n
	WHERE n.session_name = p_session
	LIMIT 1
$$;--> statement-breakpoint

ALTER FUNCTION app.resolve_session_org(text) OWNER TO marko_rls_bypass;--> statement-breakpoint

-- The function is the whole point of the `app` schema being reachable; the
-- tables behind it stay protected by their own policies.
GRANT USAGE ON SCHEMA app TO marko, marko_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_org() TO marko, marko_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resolve_session_org(text) TO marko, marko_worker;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Policies (nine tenant-scoped tables)
-- ---------------------------------------------------------------------------
--
-- One permissive policy per table covering ALL commands:
--   USING       — which existing rows this transaction may read/update/delete;
--   WITH CHECK  — which rows it may write, so a tenant cannot insert a row
--                 stamped with someone else's organization_id.
--
-- `FORCE` is what makes these apply to `marko`, the table owner and the role
-- the PgBouncer pool connects as (ADR-004). `marko_worker` carries BYPASSRLS
-- and is unaffected by both.

ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "leads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "leads_tenant_isolation" ON "leads";--> statement-breakpoint
CREATE POLICY "leads_tenant_isolation" ON "leads"
	USING ("organization_id" = app.current_org())
	WITH CHECK ("organization_id" = app.current_org());--> statement-breakpoint

ALTER TABLE "whatsapp_numbers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "whatsapp_numbers_tenant_isolation" ON "whatsapp_numbers";--> statement-breakpoint
CREATE POLICY "whatsapp_numbers_tenant_isolation" ON "whatsapp_numbers"
	USING ("organization_id" = app.current_org())
	WITH CHECK ("organization_id" = app.current_org());--> statement-breakpoint

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "messages_tenant_isolation" ON "messages";--> statement-breakpoint
CREATE POLICY "messages_tenant_isolation" ON "messages"
	USING ("organization_id" = app.current_org())
	WITH CHECK ("organization_id" = app.current_org());--> statement-breakpoint

ALTER TABLE "scheduled_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "scheduled_jobs_tenant_isolation" ON "scheduled_jobs";--> statement-breakpoint
CREATE POLICY "scheduled_jobs_tenant_isolation" ON "scheduled_jobs"
	USING ("organization_id" = app.current_org())
	WITH CHECK ("organization_id" = app.current_org());--> statement-breakpoint

ALTER TABLE "handoff_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "handoff_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "handoff_events_tenant_isolation" ON "handoff_events";--> statement-breakpoint
CREATE POLICY "handoff_events_tenant_isolation" ON "handoff_events"
	USING ("organization_id" = app.current_org())
	WITH CHECK ("organization_id" = app.current_org());--> statement-breakpoint

ALTER TABLE "compliance_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "compliance_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "compliance_records_tenant_isolation" ON "compliance_records";--> statement-breakpoint
CREATE POLICY "compliance_records_tenant_isolation" ON "compliance_records"
	USING ("organization_id" = app.current_org())
	WITH CHECK ("organization_id" = app.current_org());--> statement-breakpoint

ALTER TABLE "import_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "import_reports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "import_reports_tenant_isolation" ON "import_reports";--> statement-breakpoint
CREATE POLICY "import_reports_tenant_isolation" ON "import_reports"
	USING ("organization_id" = app.current_org())
	WITH CHECK ("organization_id" = app.current_org());--> statement-breakpoint

ALTER TABLE "import_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "import_rows" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "import_rows_tenant_isolation" ON "import_rows";--> statement-breakpoint
CREATE POLICY "import_rows_tenant_isolation" ON "import_rows"
	USING ("organization_id" = app.current_org())
	WITH CHECK ("organization_id" = app.current_org());--> statement-breakpoint

ALTER TABLE "message_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_templates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "message_templates_tenant_isolation" ON "message_templates";--> statement-breakpoint
CREATE POLICY "message_templates_tenant_isolation" ON "message_templates"
	USING ("organization_id" = app.current_org())
	WITH CHECK ("organization_id" = app.current_org());--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Verification (run as `marko`, i.e. the role the web pool connects as)
-- ---------------------------------------------------------------------------

-- 1. All nine tables show relrowsecurity = t AND relforcerowsecurity = t.
--    `relforcerowsecurity = f` means the policies do NOT apply to the owner —
--    the web app would read everything and the net would be an illusion.
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
	AND c.relname IN (
		'leads', 'whatsapp_numbers', 'messages', 'scheduled_jobs',
		'handoff_events', 'compliance_records', 'import_reports',
		'import_rows', 'message_templates'
	)
ORDER BY c.relname;--> statement-breakpoint

-- 2. Fails closed: with no tenant context, a plain read returns ZERO rows —
--    not an error, and above all not every tenant's leads. This is the exact
--    behaviour the production leak lacked.
SELECT count(*) AS leads_visible_without_context FROM leads;--> statement-breakpoint

-- 3. With a context set, only that organization's rows are visible. Replace
--    the id with a real one; the two counts must differ once more than one
--    organization has leads.
BEGIN;
SELECT set_config('app.org_id', 'REPLACE_WITH_ORG_ID', true);
SELECT count(*) AS leads_visible_with_context FROM leads;
COMMIT;
