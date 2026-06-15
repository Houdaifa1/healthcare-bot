-- Make doctorId optional in appointments so we can delete doctors while keeping appointment records
-- Add doctorName column to preserve the doctor's name after deletion

ALTER TABLE "Appointment"
  ALTER COLUMN "doctorId" DROP NOT NULL,
  ADD COLUMN "doctorName" TEXT;

-- Backfill doctorName from the Doctor table for existing records
UPDATE "Appointment" a
SET "doctorName" = d."name"
FROM "Doctor" d
WHERE a."doctorId" = d."id";