-- ─────────────────────────────────────────────────────────────────────────────
-- 20260615043434_sync_fix — IDEMPOTENT VERSION
-- Safe to apply on any DB state: partial, fresh, or already-migrated.
-- All DDL uses IF NOT EXISTS / DO $$ guards so re-runs are no-ops.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Enums ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "Language" AS ENUM ('FR', 'AR', 'EN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AppointmentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'CLINIC_ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "MessageKey" AS ENUM (
    'WELCOME', 'LANGUAGE_PROMPT', 'ASK_NAME', 'SELECT_SPECIALTY', 'SELECT_DOCTOR',
    'SELECT_DATE', 'SELECT_TIME', 'CONFIRM_BOOKING', 'BOOKING_SUCCESS', 'BOOKING_CANCELLED',
    'FAQ_INTRO', 'FAQ_NOT_FOUND', 'FAQ_FOLLOW_UP', 'FAQ_LIST_PROMPT', 'FALLBACK',
    'HANDOFF_TRIGGERED', 'SESSION_EXPIRED', 'NO_SLOTS_AVAILABLE', 'OUTSIDE_HOURS',
    'ERROR_MISSING_INFO', 'ERROR_DOCTOR_NOT_FOUND', 'ERROR_SPECIALTY_NOT_FOUND',
    'ERROR_MISSING_SPECIALTY', 'ERROR_MISSING_DOCTOR',
    'BUTTON_CONFIRM', 'BUTTON_CANCEL', 'BUTTON_BOOK_APP', 'BUTTON_FAQ',
    'BUTTON_AGENT', 'BUTTON_MENU', 'BUTTON_FRENCH', 'BUTTON_ENGLISH',
    'HEADER_SPECIALTIES', 'HEADER_DOCTORS', 'HEADER_TIMES', 'HEADER_SELECT_TIME',
    'NO_DOCTORS_FOR_SPECIALTY', 'NO_SPECIALTIES_AVAILABLE', 'HANDOFF_WAITING',
    'BUTTON_FAQ_LIST', 'HEADER_SELECT_FAQ'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Clinic" (
    "id"              TEXT        NOT NULL,
    "name"            TEXT        NOT NULL,
    "phone"           TEXT        NOT NULL,
    "address"         TEXT,
    "timezone"        TEXT        NOT NULL DEFAULT 'Africa/Casablanca',
    "defaultLanguage" "Language"  NOT NULL DEFAULT 'FR',
    "supportedLangs"  "Language"[]         DEFAULT ARRAY['FR', 'EN']::"Language"[],
    "isActive"        BOOLEAN     NOT NULL DEFAULT true,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Clinic_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BotMessage" (
    "id"        TEXT        NOT NULL,
    "clinicId"  TEXT        NOT NULL,
    "key"       "MessageKey" NOT NULL,
    "body"      TEXT        NOT NULL,
    "language"  "Language"  NOT NULL DEFAULT 'FR',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BotMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Specialty" (
    "id"           TEXT         NOT NULL,
    "clinicId"     TEXT         NOT NULL,
    "labels"       JSONB        NOT NULL,
    "slug"         TEXT         NOT NULL,
    "isActive"     BOOLEAN      NOT NULL DEFAULT true,
    "displayOrder" INTEGER      NOT NULL DEFAULT 0,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Specialty_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Doctor" (
    "id"           TEXT         NOT NULL,
    "clinicId"     TEXT         NOT NULL,
    "specialtyId"  TEXT         NOT NULL,
    "name"         TEXT         NOT NULL,
    "bio"          TEXT,
    "isActive"     BOOLEAN      NOT NULL DEFAULT true,
    "displayOrder" INTEGER      NOT NULL DEFAULT 0,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Doctor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TimeSlot" (
    "id"                  TEXT    NOT NULL,
    "doctorId"            TEXT    NOT NULL,
    "dayOfWeek"           INTEGER NOT NULL,
    "startTime"           TEXT    NOT NULL,
    "endTime"             TEXT    NOT NULL,
    "slotDurationMinutes" INTEGER NOT NULL DEFAULT 30,
    "isActive"            BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "TimeSlot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Appointment" (
    "id"              TEXT               NOT NULL,
    "clinicId"        TEXT               NOT NULL,
    "doctorId"        TEXT               NOT NULL,
    "specialtyId"     TEXT               NOT NULL,
    "patientName"     TEXT               NOT NULL,
    "patientPhone"    TEXT               NOT NULL,
    "appointmentDate" TIMESTAMP(3)       NOT NULL,
    "appointmentTime" TEXT               NOT NULL,
    "status"          "AppointmentStatus" NOT NULL DEFAULT 'PENDING',
    "notes"           TEXT,
    "createdAt"       TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3)       NOT NULL,
    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FAQ" (
    "id"           TEXT         NOT NULL,
    "clinicId"     TEXT         NOT NULL,
    "question"     TEXT         NOT NULL,
    "answer"       TEXT         NOT NULL,
    "keywords"     TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "isActive"     BOOLEAN      NOT NULL DEFAULT true,
    "displayOrder" INTEGER      NOT NULL DEFAULT 0,
    "language"     "Language"   NOT NULL DEFAULT 'FR',
    CONSTRAINT "FAQ_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AdminUser" (
    "id"           TEXT         NOT NULL,
    "clinicId"     TEXT,
    "email"        TEXT         NOT NULL,
    "passwordHash" TEXT         NOT NULL,
    "role"         "AdminRole"  NOT NULL DEFAULT 'CLINIC_ADMIN',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id"          TEXT         NOT NULL,
    "adminUserId" TEXT         NOT NULL,
    "action"      TEXT         NOT NULL,
    "entity"      TEXT         NOT NULL,
    "entityId"    TEXT,
    "payload"     JSONB,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- ── Columns that may be missing on pre-existing tables ───────────────────────
-- Guards against partial-migration state (the Specialty.labels issue)

DO $$ BEGIN
  ALTER TABLE "Specialty" ADD COLUMN "labels" JSONB NOT NULL DEFAULT '{}';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "BotMessage_clinicId_key_language_key"
  ON "BotMessage"("clinicId", "key", "language");

CREATE UNIQUE INDEX IF NOT EXISTS "Specialty_clinicId_slug_key"
  ON "Specialty"("clinicId", "slug");

CREATE UNIQUE INDEX IF NOT EXISTS "AdminUser_email_key"
  ON "AdminUser"("email");

-- ── Foreign Keys (each guarded individually) ──────────────────────────────────

DO $$ BEGIN
  ALTER TABLE "BotMessage" ADD CONSTRAINT "BotMessage_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Specialty" ADD CONSTRAINT "Specialty_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Doctor" ADD CONSTRAINT "Doctor_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Doctor" ADD CONSTRAINT "Doctor_specialtyId_fkey"
    FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "TimeSlot" ADD CONSTRAINT "TimeSlot_doctorId_fkey"
    FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_doctorId_fkey"
    FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_specialtyId_fkey"
    FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "FAQ" ADD CONSTRAINT "FAQ_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_clinicId_fkey"
    FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_adminUserId_fkey"
    FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;