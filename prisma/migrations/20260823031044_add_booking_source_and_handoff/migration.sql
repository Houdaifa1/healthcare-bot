-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('INBOUND', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "HandoffStatus" AS ENUM ('OPEN', 'ADMIN_HANDLING', 'RESOLVED');

-- AlterEnum
ALTER TYPE "MessageKey" ADD VALUE 'BOOKING_REQUEST_RECEIVED';

-- DropForeignKey
ALTER TABLE "BookingRequest" DROP CONSTRAINT "BookingRequest_campaignPatientId_fkey";

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "source" "BookingSource" NOT NULL DEFAULT 'CAMPAIGN';

-- AlterTable
ALTER TABLE "BookingRequest" ADD COLUMN     "clinopsPatientId" INTEGER,
ADD COLUMN     "language" "Language",
ADD COLUMN     "patientName" TEXT,
ADD COLUMN     "patientPhone" TEXT,
ADD COLUMN     "requestedDate" TEXT,
ADD COLUMN     "requestedTime" TEXT,
ADD COLUMN     "source" "BookingSource" NOT NULL DEFAULT 'CAMPAIGN',
ALTER COLUMN "campaignPatientId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Handoff" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "source" "BookingSource" NOT NULL,
    "phone" TEXT NOT NULL,
    "patientName" TEXT,
    "campaignPatientId" TEXT,
    "reason" TEXT,
    "language" "Language",
    "status" "HandoffStatus" NOT NULL DEFAULT 'OPEN',
    "messages" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Handoff_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_campaignPatientId_fkey" FOREIGN KEY ("campaignPatientId") REFERENCES "CampaignPatient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handoff" ADD CONSTRAINT "Handoff_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handoff" ADD CONSTRAINT "Handoff_campaignPatientId_fkey" FOREIGN KEY ("campaignPatientId") REFERENCES "CampaignPatient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
