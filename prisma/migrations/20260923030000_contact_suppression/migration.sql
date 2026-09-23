CREATE TABLE "ContactSuppression" (
  "id" TEXT NOT NULL,
  "clinicId" TEXT NOT NULL,
  "phoneNormalized" TEXT NOT NULL,
  "sourceMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactSuppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContactSuppression_clinicId_phoneNormalized_key"
  ON "ContactSuppression"("clinicId", "phoneNormalized");
