/*
  Warnings:

  - You are about to drop the column `filterDoctor` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `filterMotif` on the `Campaign` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Campaign" DROP COLUMN "filterDoctor",
DROP COLUMN "filterMotif",
ADD COLUMN     "filterDoctors" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "filterMotifs" TEXT[] DEFAULT ARRAY[]::TEXT[];
