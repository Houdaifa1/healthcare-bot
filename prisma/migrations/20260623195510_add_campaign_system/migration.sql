/*
  Warnings:

  - You are about to drop the column `activeFlowId` on the `Clinic` table. All the data in the column will be lost.
  - You are about to drop the `Flow` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `FlowNode` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED', 'STOPPED');

-- CreateEnum
CREATE TYPE "CampaignPatientStatus" AS ENUM ('PENDING', 'CONTACTED', 'REPLIED', 'COMPLETED', 'OPTED_OUT', 'NO_RESPONSE');

-- CreateEnum
CREATE TYPE "ConversationOutcome" AS ENUM ('COMPLETED', 'COMPLAINED', 'REBOOKED', 'HANDED_OFF', 'URGENT', 'OPTED_OUT', 'NO_RESPONSE');

-- CreateEnum
CREATE TYPE "ComplaintType" AS ENUM ('COMPLAINT', 'MEDICAL_CONCERN', 'URGENT');

-- CreateEnum
CREATE TYPE "ComplaintSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('NEW', 'REVIEWED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "BookingRequestStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MessageKey" ADD VALUE 'HANDOFF_RESOLVED';
ALTER TYPE "MessageKey" ADD VALUE 'CAMPAIGN_OPENING_MESSAGE';
ALTER TYPE "MessageKey" ADD VALUE 'CAMPAIGN_REMINDER_MESSAGE';
ALTER TYPE "MessageKey" ADD VALUE 'CAMPAIGN_URGENT_MESSAGE';
ALTER TYPE "MessageKey" ADD VALUE 'CAMPAIGN_HANDOFF_MESSAGE';
ALTER TYPE "MessageKey" ADD VALUE 'CAMPAIGN_REBOOK_CONFIRM';

-- DropForeignKey
ALTER TABLE "Appointment" DROP CONSTRAINT "Appointment_doctorId_fkey";

-- DropForeignKey
ALTER TABLE "Appointment" DROP CONSTRAINT "Appointment_specialtyId_fkey";

-- DropForeignKey
ALTER TABLE "Clinic" DROP CONSTRAINT "Clinic_activeFlowId_fkey";

-- DropForeignKey
ALTER TABLE "Flow" DROP CONSTRAINT "Flow_clinicId_fkey";

-- DropForeignKey
ALTER TABLE "FlowNode" DROP CONSTRAINT "FlowNode_flowId_fkey";

-- AlterTable
ALTER TABLE "Clinic" DROP COLUMN "activeFlowId",
ADD COLUMN     "aiMaxTurns" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "campaignDelayHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "notificationPhone" TEXT,
ADD COLUMN     "reminderCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "reminderIntervalHours" INTEGER NOT NULL DEFAULT 48;

-- DropTable
DROP TABLE "Flow";

-- DropTable
DROP TABLE "FlowNode";

-- DropEnum
DROP TYPE "NodeType";

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "filterDateFrom" TIMESTAMP(3),
    "filterDateTo" TIMESTAMP(3),
    "filterDoctor" TEXT,
    "filterMotif" TEXT,
    "notificationPhone" TEXT,
    "delayHours" INTEGER,
    "reminderCount" INTEGER,
    "reminderIntervalHours" INTEGER,
    "aiMaxTurns" INTEGER,
    "targetedCount" INTEGER NOT NULL DEFAULT 0,
    "contactedCount" INTEGER NOT NULL DEFAULT 0,
    "repliedCount" INTEGER NOT NULL DEFAULT 0,
    "complainedCount" INTEGER NOT NULL DEFAULT 0,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "noResponseCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "launchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignPatient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "clinopsPatientId" INTEGER,
    "patientName" TEXT NOT NULL,
    "cin" TEXT,
    "sexe" TEXT,
    "ageYears" INTEGER,
    "ville" TEXT,
    "pays" TEXT,
    "phone" TEXT NOT NULL,
    "phoneSecondaire" TEXT,
    "soldeImpaye" TEXT,
    "visitDate" TIMESTAMP(3) NOT NULL,
    "prestation" TEXT NOT NULL,
    "medecinTraitant" TEXT NOT NULL,
    "patientSnapshot" JSONB NOT NULL,
    "status" "CampaignPatientStatus" NOT NULL DEFAULT 'PENDING',
    "language" "Language",
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "outcome" "ConversationOutcome",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "contactedAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CampaignPatient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Complaint" (
    "id" TEXT NOT NULL,
    "campaignPatientId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "type" "ComplaintType" NOT NULL,
    "severity" "ComplaintSeverity" NOT NULL,
    "triggeringMessage" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'NEW',
    "staffNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingRequest" (
    "id" TEXT NOT NULL,
    "campaignPatientId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "preferredSpecialty" TEXT,
    "preferredDoctor" TEXT,
    "preferredDateRange" TEXT,
    "reason" TEXT,
    "rawPatientRequest" TEXT NOT NULL,
    "status" "BookingRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "BookingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_appointmentId_key" ON "BookingRequest"("appointmentId");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignPatient" ADD CONSTRAINT "CampaignPatient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_campaignPatientId_fkey" FOREIGN KEY ("campaignPatientId") REFERENCES "CampaignPatient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_campaignPatientId_fkey" FOREIGN KEY ("campaignPatientId") REFERENCES "CampaignPatient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
