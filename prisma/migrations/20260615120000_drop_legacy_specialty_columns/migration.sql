-- ─────────────────────────────────────────────────────────────────────────────
-- Drop legacy `label` + `language` columns from Specialty table.
-- These were from the old per-row translation schema.
-- The new schema uses a single `labels` JSONB column: { "FR": "...", "EN": "..." }
-- ─────────────────────────────────────────────────────────────────────────────

-- Remove the default placeholder so JSONB column is properly required
ALTER TABLE "Specialty" ALTER COLUMN "labels" DROP DEFAULT;

-- Drop legacy columns (idempotent)
DO $$ BEGIN
  ALTER TABLE "Specialty" DROP COLUMN "label";
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Specialty" DROP COLUMN "language";
EXCEPTION WHEN undefined_column THEN NULL;
END $$;