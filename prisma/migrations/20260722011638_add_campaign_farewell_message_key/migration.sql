-- AlterEnum
ALTER TYPE "MessageKey" ADD VALUE 'CAMPAIGN_FAREWELL_MESSAGE';

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignPatientId" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiUsage_clinicId_campaignId_campaignPatientId_idx" ON "AiUsage"("clinicId", "campaignId", "campaignPatientId");
