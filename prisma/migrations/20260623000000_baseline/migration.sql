-- Baseline: exact DB snapshot as of 2026-06-23
-- This migration is marked as already applied via `migrate resolve --applied`.
-- It exists solely so the shadow DB can replay history cleanly for future migrations.
-- It is never run directly against the production DB.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."AdminRole" AS ENUM ('SUPER_ADMIN', 'CLINIC_ADMIN');

-- CreateEnum
CREATE TYPE "public"."AppointmentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "public"."Language" AS ENUM ('FR', 'AR', 'EN');

-- CreateEnum
CREATE TYPE "public"."MessageKey" AS ENUM (
  'WELCOME', 'LANGUAGE_PROMPT', 'ASK_NAME', 'SELECT_SPECIALTY', 'SELECT_DOCTOR',
  'SELECT_DATE', 'SELECT_TIME', 'CONFIRM_BOOKING', 'BOOKING_SUCCESS', 'BOOKING_CANCELLED',
  'FAQ_INTRO', 'FAQ_NOT_FOUND', 'FALLBACK', 'HANDOFF_TRIGGERED', 'SESSION_EXPIRED',
  'NO_SLOTS_AVAILABLE', 'OUTSIDE_HOURS', 'FAQ_FOLLOW_UP', 'FAQ_LIST_PROMPT',
  'ERROR_MISSING_INFO', 'ERROR_DOCTOR_NOT_FOUND', 'ERROR_SPECIALTY_NOT_FOUND',
  'ERROR_MISSING_SPECIALTY', 'ERROR_MISSING_DOCTOR',
  'BUTTON_CONFIRM', 'BUTTON_CANCEL', 'BUTTON_BOOK_APP', 'BUTTON_FAQ',
  'BUTTON_AGENT', 'BUTTON_MENU', 'BUTTON_FRENCH', 'BUTTON_ENGLISH',
  'HEADER_SPECIALTIES', 'HEADER_DOCTORS', 'HEADER_TIMES', 'HEADER_SELECT_TIME',
  'NO_DOCTORS_FOR_SPECIALTY', 'NO_SPECIALTIES_AVAILABLE', 'HANDOFF_WAITING',
  'BUTTON_FAQ_LIST', 'HEADER_SELECT_FAQ', 'HEADER_TIME_PAGE'
);

-- CreateEnum
CREATE TYPE "public"."NodeType" AS ENUM (
  'TEXT', 'BUTTONS', 'LIST', 'SPECIALTY_LIST', 'DOCTOR_LIST',
  'DATE_PICKER', 'TIME_PICKER', 'FREE_TEXT_INPUT', 'CONDITION',
  'BOOK_APPOINTMENT', 'END'
);

-- CreateTable
CREATE TABLE "public"."Clinic" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "address" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Casablanca',
    "defaultLanguage" "public"."Language" NOT NULL DEFAULT 'FR',
    "supportedLangs" "public"."Language"[] DEFAULT ARRAY['FR', 'EN']::"public"."Language"[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activeFlowId" TEXT,
    CONSTRAINT "Clinic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Flow" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Flow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FlowNode" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "type" "public"."NodeType" NOT NULL,
    "label" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FlowNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BotMessage" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "key" "public"."MessageKey" NOT NULL,
    "body" TEXT NOT NULL,
    "language" "public"."Language" NOT NULL DEFAULT 'FR',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BotMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Specialty" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "labels" JSONB NOT NULL,
    CONSTRAINT "Specialty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Doctor" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "specialtyId" TEXT,
    "name" TEXT NOT NULL,
    "bio" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Doctor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TimeSlot" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "slotDurationMinutes" INTEGER NOT NULL DEFAULT 30,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "TimeSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Appointment" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "doctorId" TEXT,
    "specialtyId" TEXT,
    "patientName" TEXT NOT NULL,
    "patientPhone" TEXT NOT NULL,
    "appointmentDate" TIMESTAMP(3) NOT NULL,
    "appointmentTime" TEXT NOT NULL,
    "status" "public"."AppointmentStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "doctorName" TEXT,
    "specialtyName" TEXT,
    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FAQ" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "keywords" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "language" "public"."Language" NOT NULL DEFAULT 'FR',
    CONSTRAINT "FAQ_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AdminUser" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "public"."AdminRole" NOT NULL DEFAULT 'CLINIC_ADMIN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuditLog" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "public"."AdminUser"("email" ASC);
CREATE UNIQUE INDEX "BotMessage_clinicId_key_language_key" ON "public"."BotMessage"("clinicId" ASC, "key" ASC, "language" ASC);
CREATE UNIQUE INDEX "Flow_clinicId_name_key" ON "public"."Flow"("clinicId" ASC, "name" ASC);
CREATE UNIQUE INDEX "FlowNode_flowId_position_key" ON "public"."FlowNode"("flowId" ASC, "position" ASC);
CREATE UNIQUE INDEX "Specialty_clinicId_slug_key" ON "public"."Specialty"("clinicId" ASC, "slug" ASC);

-- AddForeignKey
ALTER TABLE "public"."Clinic" ADD CONSTRAINT "Clinic_activeFlowId_fkey" FOREIGN KEY ("activeFlowId") REFERENCES "public"."Flow"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."Flow" ADD CONSTRAINT "Flow_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."FlowNode" ADD CONSTRAINT "FlowNode_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "public"."Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."BotMessage" ADD CONSTRAINT "BotMessage_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Specialty" ADD CONSTRAINT "Specialty_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Doctor" ADD CONSTRAINT "Doctor_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Doctor" ADD CONSTRAINT "Doctor_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "public"."Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."TimeSlot" ADD CONSTRAINT "TimeSlot_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "public"."Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Appointment" ADD CONSTRAINT "Appointment_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Appointment" ADD CONSTRAINT "Appointment_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "public"."Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Appointment" ADD CONSTRAINT "Appointment_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "public"."Specialty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."FAQ" ADD CONSTRAINT "FAQ_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."AdminUser" ADD CONSTRAINT "AdminUser_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."Clinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "public"."AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;