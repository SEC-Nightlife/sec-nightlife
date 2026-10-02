-- Weekly batched payouts: one Paystack transfer per recipient per Monday run

DO $$ BEGIN
  CREATE TYPE "PayoutBatchStatus" AS ENUM ('PROCESSING', 'TRANSFERRED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "payout_batches" (
    "id" TEXT NOT NULL,
    "recipient_type" "PayoutRecipientType" NOT NULL,
    "recipient_user_id" TEXT,
    "recipient_venue_id" TEXT,
    "total_amount" DOUBLE PRECISION NOT NULL,
    "status" "PayoutBatchStatus" NOT NULL DEFAULT 'PROCESSING',
    "paystack_transfer_ref" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_batches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "payout_batches_status_idx" ON "payout_batches"("status");
CREATE INDEX IF NOT EXISTS "payout_batches_recipient_user_id_idx" ON "payout_batches"("recipient_user_id");
CREATE INDEX IF NOT EXISTS "payout_batches_recipient_venue_id_idx" ON "payout_batches"("recipient_venue_id");
CREATE INDEX IF NOT EXISTS "payout_batches_paystack_transfer_ref_idx" ON "payout_batches"("paystack_transfer_ref");

ALTER TABLE "payout_ledgers" ADD COLUMN IF NOT EXISTS "batch_id" TEXT;

CREATE INDEX IF NOT EXISTS "payout_ledgers_batch_id_idx" ON "payout_ledgers"("batch_id");

DO $$ BEGIN
  ALTER TABLE "payout_ledgers"
    ADD CONSTRAINT "payout_ledgers_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "payout_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
