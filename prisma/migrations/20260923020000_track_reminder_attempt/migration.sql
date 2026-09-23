ALTER TABLE "CampaignPatient"
  ADD COLUMN "reminderAttemptAt" TIMESTAMP(3),
  ADD COLUMN "reminderAttemptState" TEXT;
