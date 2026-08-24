-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "filterCinPassports" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "filterPhoneNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "onlyVerifiedNumbers" BOOLEAN NOT NULL DEFAULT true;
