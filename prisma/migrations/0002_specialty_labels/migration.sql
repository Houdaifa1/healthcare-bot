-- Migrate Specialty from dual-row (label + language) to single-row (labels JSON)
BEGIN;

-- 1. Add labels column
ALTER TABLE "Specialty" ADD COLUMN IF NOT EXISTS "labels" JSONB;

-- 2. Consolidate existing FR/EN rows into single JSON labels
--    Also map which ID to keep (the oldest one per slug)
WITH consolidated AS (
  SELECT
    s1."clinicId",
    s1."slug",
    jsonb_build_object(
      'FR', (SELECT s2."label" FROM "Specialty" s2 WHERE s2."clinicId" = s1."clinicId" AND s2."slug" = s1."slug" AND s2."language" = 'FR' LIMIT 1),
      'EN', (SELECT s3."label" FROM "Specialty" s3 WHERE s3."clinicId" = s1."clinicId" AND s3."slug" = s1."slug" AND s3."language" = 'EN' LIMIT 1)
    ) AS "newLabels",
    MIN(s1."id") AS "keepId",
    MAX(s1."id") AS "otherId",
    MIN(s1."displayOrder") AS "minDisplayOrder",
    MIN(s1."isActive"::int)::boolean AS "minIsActive"
  FROM "Specialty" s1
  GROUP BY s1."clinicId", s1."slug"
)
UPDATE "Specialty" s
SET
  "labels" = c."newLabels",
  "displayOrder" = c."minDisplayOrder",
  "isActive" = c."minIsActive"
FROM consolidated c
WHERE s."id" = c."keepId";

-- 3. Update any Doctor or Appointment that references the duplicate ID
--    to point to the kept ID instead
UPDATE "Doctor" d
SET "specialtyId" = c."keepId"
FROM consolidated c
WHERE d."specialtyId" = c."otherId";

UPDATE "Appointment" a
SET "specialtyId" = c."keepId"
FROM consolidated c
WHERE a."specialtyId" = c."otherId";

-- 4. Delete duplicate rows
DELETE FROM "Specialty" s1
WHERE s1."labels" IS NULL
   OR s1."id" NOT IN (
     SELECT MIN(s2."id")
     FROM "Specialty" s2
     WHERE s2."labels" IS NOT NULL
     GROUP BY s2."clinicId", s2."slug"
   );

-- 5. Make labels NOT NULL
ALTER TABLE "Specialty" ALTER COLUMN "labels" SET NOT NULL;

-- 6. Drop old columns and constraint
ALTER TABLE "Specialty" DROP CONSTRAINT IF EXISTS "Specialty_clinicId_slug_language_key";
ALTER TABLE "Specialty" DROP COLUMN IF EXISTS "label";
ALTER TABLE "Specialty" DROP COLUMN IF EXISTS "language";

-- 7. Create new unique constraint
ALTER TABLE "Specialty" ADD CONSTRAINT "Specialty_clinicId_slug_key" UNIQUE ("clinicId", "slug");

COMMIT;