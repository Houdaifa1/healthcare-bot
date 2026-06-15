-- Make Doctor.specialtyId optional so a doctor can be detached
-- when its specialty is permanently deleted.

-- Drop the existing RESTRICT constraint
ALTER TABLE "Doctor" DROP CONSTRAINT IF EXISTS "Doctor_specialtyId_fkey";

-- Allow NULL
ALTER TABLE "Doctor" ALTER COLUMN "specialtyId" DROP NOT NULL;

-- Recreate with ON DELETE SET NULL
ALTER TABLE "Doctor" ADD CONSTRAINT "Doctor_specialtyId_fkey"
  FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;