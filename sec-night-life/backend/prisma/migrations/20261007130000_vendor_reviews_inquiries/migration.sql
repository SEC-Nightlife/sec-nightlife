-- CreateEnum
CREATE TYPE "VendorInquiryStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'DECLINED', 'COMPLETED', 'CANCELLED');

-- AlterEnum


ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VENDOR_REVIEW_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VENDOR_INQUIRY_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VENDOR_INQUIRY_UPDATED';

-- AlterTable
ALTER TABLE "vendor_businesses" ADD COLUMN     "country" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "instagram" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "price_from_zar" DOUBLE PRECISION,
ADD COLUMN     "price_unit" TEXT,
ADD COLUMN     "quote_on_request" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "service_area" TEXT,
ADD COLUMN     "unpublished_by_admin_at" TIMESTAMP(3),
ADD COLUMN     "unpublished_reason" TEXT,
ADD COLUMN     "whatsapp" TEXT;

-- CreateTable
CREATE TABLE "vendor_reviews" (
    "id" TEXT NOT NULL,
    "vendor_business_id" TEXT NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "inquiry_id" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flag_reason" TEXT,
    "flagged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_vendor_reviews" (
    "id" TEXT NOT NULL,
    "vendor_business_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "author_user_id" TEXT NOT NULL,
    "inquiry_id" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flag_reason" TEXT,
    "flagged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_vendor_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_inquiries" (
    "id" TEXT NOT NULL,
    "vendor_business_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "requester_user_id" TEXT NOT NULL,
    "event_date" TIMESTAMP(3),
    "message" TEXT NOT NULL,
    "status" "VendorInquiryStatus" NOT NULL DEFAULT 'REQUESTED',
    "vendor_response" TEXT,
    "responded_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_reviews_vendor_business_id_idx" ON "vendor_reviews"("vendor_business_id");

-- CreateIndex
CREATE INDEX "vendor_reviews_flagged_idx" ON "vendor_reviews"("flagged");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_reviews_reviewer_id_vendor_business_id_key" ON "vendor_reviews"("reviewer_id", "vendor_business_id");

-- CreateIndex
CREATE INDEX "venue_vendor_reviews_vendor_business_id_idx" ON "venue_vendor_reviews"("vendor_business_id");

-- CreateIndex
CREATE INDEX "venue_vendor_reviews_author_user_id_idx" ON "venue_vendor_reviews"("author_user_id");

-- CreateIndex
CREATE INDEX "venue_vendor_reviews_flagged_idx" ON "venue_vendor_reviews"("flagged");

-- CreateIndex
CREATE UNIQUE INDEX "venue_vendor_reviews_venue_id_vendor_business_id_key" ON "venue_vendor_reviews"("venue_id", "vendor_business_id");

-- CreateIndex
CREATE INDEX "vendor_inquiries_vendor_business_id_status_idx" ON "vendor_inquiries"("vendor_business_id", "status");

-- CreateIndex
CREATE INDEX "vendor_inquiries_venue_id_idx" ON "vendor_inquiries"("venue_id");

-- CreateIndex
CREATE INDEX "vendor_inquiries_requester_user_id_idx" ON "vendor_inquiries"("requester_user_id");

-- AddForeignKey
ALTER TABLE "vendor_reviews" ADD CONSTRAINT "vendor_reviews_vendor_business_id_fkey" FOREIGN KEY ("vendor_business_id") REFERENCES "vendor_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_reviews" ADD CONSTRAINT "vendor_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_vendor_reviews" ADD CONSTRAINT "venue_vendor_reviews_vendor_business_id_fkey" FOREIGN KEY ("vendor_business_id") REFERENCES "vendor_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_vendor_reviews" ADD CONSTRAINT "venue_vendor_reviews_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_vendor_reviews" ADD CONSTRAINT "venue_vendor_reviews_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_inquiries" ADD CONSTRAINT "vendor_inquiries_vendor_business_id_fkey" FOREIGN KEY ("vendor_business_id") REFERENCES "vendor_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_inquiries" ADD CONSTRAINT "vendor_inquiries_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_inquiries" ADD CONSTRAINT "vendor_inquiries_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

