-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('SENT', 'DELIVERED', 'READ', 'WARNING', 'FAILED');

-- AlterTable
ALTER TABLE "CampaignPatient" ADD COLUMN "outboundMessageId" TEXT;
ALTER TABLE "CampaignPatient" ADD COLUMN "deliveryStatus" "DeliveryStatus";
