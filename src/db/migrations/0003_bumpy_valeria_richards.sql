-- ADR-003: the ten-state lifecycle becomes seven, and scoring leaves the schema.
--
-- HAND-EDITED after `drizzle-kit generate`. What it produced was the constraint
-- swap and the column drops — correct as far as it goes, and unusable on its
-- own: it never rewrites the existing rows, so the new CHECK would reject every
-- lead already in the table and the migration would abort. Steps 2 and 3 below
-- are the part drizzle-kit cannot know about. Do not regenerate this file.
--
-- ORDER MATTERS: drop the old CHECK, rewrite the values, then add the new one.
-- The other order fails on the first legacy row.
--
-- Legacy → new mapping (decided 2026-07-25):
--
--   COLD_QUEUED        -> QUEUED       rename only
--   IN_CADENCE         -> IN_CADENCE   unchanged
--   REPLIED            -> REPLIED      unchanged
--   OPTED_OUT          -> OPTED_OUT    unchanged
--   CADENCE_EXHAUSTED  -> COMPLETED    rename only
--   MONTHLY_NURTURE    -> COMPLETED    nurture was cut (ADR-002); these leads
--                                      had finished their cadence
--   QUALIFYING         -> REPLIED      they replied; what followed was scoring,
--   HOT                -> REPLIED      which no longer exists
--   WARM               -> REPLIED
--   DISQUALIFIED       -> REPLIED      NOT `LOST`: the classifier that
--                                      disqualified them is the same one being
--                                      removed, so its verdict is not trusted
--                                      enough to record as an outcome. They go
--                                      back to the consultant, who decides.
--
-- Net effect: no lead is born with an outcome. `WON`/`LOST` are 100% manual from
-- here on, which is what makes "conversion = WON / imported" mean anything.
--
-- No explicit BEGIN/COMMIT: drizzle-kit already runs each migration inside a
-- transaction, so a failure at any step rolls the whole thing back.

-- 1. Release the old constraints so the values can be rewritten.
ALTER TABLE "leads" DROP CONSTRAINT IF EXISTS "leads_classification_band_check";--> statement-breakpoint
ALTER TABLE "leads" DROP CONSTRAINT IF EXISTS "leads_score_range_check";--> statement-breakpoint
ALTER TABLE "leads" DROP CONSTRAINT IF EXISTS "leads_lifecycle_state_check";--> statement-breakpoint

-- 2. Rewrite the legacy values.
UPDATE "leads" SET "lifecycle_state" = CASE "lifecycle_state"
	WHEN 'COLD_QUEUED'       THEN 'QUEUED'
	WHEN 'CADENCE_EXHAUSTED' THEN 'COMPLETED'
	WHEN 'MONTHLY_NURTURE'   THEN 'COMPLETED'
	WHEN 'QUALIFYING'        THEN 'REPLIED'
	WHEN 'HOT'               THEN 'REPLIED'
	WHEN 'WARM'              THEN 'REPLIED'
	WHEN 'DISQUALIFIED'      THEN 'REPLIED'
	ELSE "lifecycle_state"
END
WHERE "lifecycle_state" IN (
	'COLD_QUEUED', 'CADENCE_EXHAUSTED', 'MONTHLY_NURTURE',
	'QUALIFYING', 'HOT', 'WARM', 'DISQUALIFIED'
);--> statement-breakpoint

-- 3. Fail loudly on anything the mapping did not cover, instead of letting the
--    CHECK in step 5 report it as an opaque constraint violation.
DO $$
DECLARE unmapped text;
BEGIN
	SELECT string_agg(DISTINCT lifecycle_state, ', ') INTO unmapped
	FROM "leads"
	WHERE "lifecycle_state" NOT IN (
		'QUEUED', 'IN_CADENCE', 'REPLIED', 'COMPLETED', 'WON', 'LOST', 'OPTED_OUT'
	);
	IF unmapped IS NOT NULL THEN
		RAISE EXCEPTION 'unmapped lifecycle_state values remain: %', unmapped;
	END IF;
END
$$;--> statement-breakpoint

-- 4. The column default followed the rename.
ALTER TABLE "leads" ALTER COLUMN "lifecycle_state" SET DEFAULT 'QUEUED';--> statement-breakpoint

-- 5. Scoring leaves the schema (ADR-002 cut the engine that fed these; nothing
--    has written either column since).
ALTER TABLE "leads" DROP COLUMN IF EXISTS "score";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN IF EXISTS "classification_band";--> statement-breakpoint

-- 6. The new constraint, added last so it validates already-rewritten rows.
ALTER TABLE "leads" ADD CONSTRAINT "leads_lifecycle_state_check" CHECK ("leads"."lifecycle_state" IN ('QUEUED', 'IN_CADENCE', 'REPLIED', 'COMPLETED', 'WON', 'LOST', 'OPTED_OUT'));
