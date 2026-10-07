-- AlterTable
ALTER TABLE "user_profiles" ADD COLUMN     "country_code" TEXT,
ADD COLUMN     "region" TEXT;

-- AlterTable
ALTER TABLE "venues" ADD COLUMN     "country_code" TEXT,
ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "country_code" TEXT,
ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "promotions" ADD COLUMN     "target_country_code" TEXT;

-- AlterTable
ALTER TABLE "hosted_tables" ADD COLUMN     "city" TEXT,
ADD COLUMN     "country_code" TEXT,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "user_profiles_country_code_city_idx" ON "user_profiles"("country_code", "city");

-- CreateIndex
CREATE INDEX "vendor_businesses_country_city_idx" ON "vendor_businesses"("country", "city");

-- CreateIndex
CREATE INDEX "venues_country_code_city_idx" ON "venues"("country_code", "city");

-- CreateIndex
CREATE INDEX "events_country_code_city_idx" ON "events"("country_code", "city");

-- CreateIndex
CREATE INDEX "promotions_target_country_code_target_city_idx" ON "promotions"("target_country_code", "target_city");

-- CreateIndex
CREATE INDEX "hosted_tables_country_code_city_idx" ON "hosted_tables"("country_code", "city");

-- Backfill: every existing account, venue and listing is South African.
UPDATE "user_profiles" SET "country_code" = 'ZA' WHERE "country_code" IS NULL;
UPDATE "venues" SET "country_code" = 'ZA' WHERE "country_code" IS NULL;
UPDATE "venues" SET "timezone" = 'Africa/Johannesburg' WHERE "timezone" IS NULL;
UPDATE "events" SET "country_code" = 'ZA' WHERE "country_code" IS NULL;
UPDATE "events" SET "timezone" = 'Africa/Johannesburg' WHERE "timezone" IS NULL;
UPDATE "vendor_businesses" SET "country" = 'ZA' WHERE "country" IS NULL;
UPDATE "promotions" SET "target_country_code" = 'ZA' WHERE "target_country_code" IS NULL;
UPDATE "hosted_tables" SET "country_code" = 'ZA' WHERE "country_code" IS NULL;
UPDATE "hosted_tables" h SET "city" = e."city"
  FROM "events" e
  WHERE h."event_id" = e."id" AND h."city" IS NULL;
