-- Migration: make_specialty_nullable_add_specialty_name
-- Created: 2026-06-15

-- Make specialtyId nullable on Appointment
ALTER TABLE "Appointment" ALTER COLUMN "specialtyId" DROP NOT NULL;

-- Add specialtyName for history preservation (same pattern as doctorName)
ALTER TABLE "Appointment" ADD COLUMN "specialtyName" TEXT;