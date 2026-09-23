ALTER TABLE "BookingRequest"
  ADD COLUMN "externalAttemptAt" TIMESTAMP(3),
  ADD COLUMN "externalAttemptState" TEXT;
