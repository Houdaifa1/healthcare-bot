-- AlterEnum
ALTER TYPE "CampaignStatus" ADD VALUE 'SCHEDULED';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "scheduledStartAt" TIMESTAMP(3);
