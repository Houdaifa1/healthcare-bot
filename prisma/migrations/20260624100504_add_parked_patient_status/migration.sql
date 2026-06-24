-- AlterEnum
ALTER TYPE "CampaignPatientStatus" ADD VALUE 'PARKED';

-- AlterTable
ALTER TABLE "CampaignPatient" ADD COLUMN     "parkedAt" TIMESTAMP(3);
