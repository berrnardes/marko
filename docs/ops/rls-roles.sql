-- Roles for PR3 / ADR-004. Run ONCE, as superuser, BEFORE migration 0003.
--
-- Not a Drizzle migration on purpose: `CREATE ROLE` is cluster-level and needs
-- privileges the application role does not have, and the passwords must not
-- live in the repository.
--
-- Connect DIRECTLY to Postgres for this — not through the PgBouncer on :5432.
-- From the Hetzner host:
--
--   docker compose exec -T postgres psql -U marko -d marko -f - < docs/ops/rls-roles.sql
--
-- (The bootstrap user `marko` is the cluster superuser created by
-- POSTGRES_USER in docker-compose.yml, so it can create roles.)

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- marko_rls_bypass — owns the SECURITY DEFINER session resolver
-- ---------------------------------------------------------------------------
--
-- NOLOGIN: nothing ever connects as this role. It exists only so that
-- `app.resolve_session_org()` runs with BYPASSRLS, letting the inbound webhook
-- resolve a WAHA session to its organization before any tenant context exists
-- (ADR-004). Keeping it loginless means the bypass is reachable ONLY through
-- that one function, which returns two columns of one row.

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'marko_rls_bypass') THEN
		CREATE ROLE marko_rls_bypass NOLOGIN BYPASSRLS;
	ELSE
		ALTER ROLE marko_rls_bypass NOLOGIN BYPASSRLS;
	END IF;
END
$$;

-- The function body reads `whatsapp_numbers` as its owner.
GRANT SELECT ON public.whatsapp_numbers TO marko_rls_bypass;

-- ---------------------------------------------------------------------------
-- marko_worker — the worker process connection
-- ---------------------------------------------------------------------------
--
-- BYPASSRLS because the worker legitimately cannot hold a transaction across
-- its work: the outbound choke point sleeps 30–120s for anti-ban pacing and
-- makes WAHA HTTP calls mid-flow. Its tenant scoping comes from the
-- application layer instead (PR2: repositories bound to the job's
-- organization).
--
-- Reachable only from inside the Docker network — the worker talks to
-- `postgres:5432` directly; Postgres publishes no host port.
--
-- Replace the password before running, and put the SAME value in
-- .env.production.

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'marko_worker') THEN
		CREATE ROLE marko_worker LOGIN BYPASSRLS PASSWORD 'CHANGE_ME';
	ELSE
		ALTER ROLE marko_worker LOGIN BYPASSRLS;
	END IF;
END
$$;

-- Domain + auth tables, the pg-boss queue schema, and the sequences behind
-- them. The worker consumes jobs, reads and writes leads/messages, and reads
-- membership to resolve handoff-alert recipients.
GRANT USAGE ON SCHEMA public TO marko_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO marko_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO marko_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO marko_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT USAGE, SELECT ON SEQUENCES TO marko_worker;

-- pg-boss owns its own schema and creates tables there at boot.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN
		EXECUTE 'GRANT USAGE, CREATE ON SCHEMA pgboss TO marko_worker';
		EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO marko_worker';
		EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO marko_worker';
		EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO marko_worker';
		EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO marko_worker';
	END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
--
-- Expect: marko_rls_bypass → rolcanlogin=f, rolbypassrls=t
--         marko_worker     → rolcanlogin=t, rolbypassrls=t

SELECT rolname, rolcanlogin, rolbypassrls
FROM pg_roles
WHERE rolname IN ('marko', 'marko_worker', 'marko_rls_bypass')
ORDER BY rolname;
