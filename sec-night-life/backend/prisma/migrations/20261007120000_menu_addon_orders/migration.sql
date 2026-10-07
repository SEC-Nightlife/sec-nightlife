ALTER TYPE "TicketKind" ADD VALUE IF NOT EXISTS 'MENU_ADDON';
ALTER TYPE "OrderFulfillmentKind" ADD VALUE IF NOT EXISTS 'MENU_ADDON';

CREATE TYPE "MenuAddonParentKind" AS ENUM ('TICKET', 'ENTRANCE', 'VENUE_TABLE', 'HOSTED_TABLE');
CREATE TYPE "MenuAddonStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'REFUNDED', 'CANCELLED');

ALTER TABLE "order_fulfillments" ADD COLUMN "undone_at" TIMESTAMP(3);
ALTER TABLE "order_fulfillments" ADD COLUMN "undone_by_user_id" TEXT;

CREATE TABLE "menu_addon_orders" (
    "id" TEXT NOT NULL,
    "paystack_reference" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "venue_id" TEXT NOT NULL,
    "parent_kind" "MenuAddonParentKind" NOT NULL,
    "parent_reference" TEXT NOT NULL,
    "parent_ticket_id" TEXT,
    "event_id" TEXT,
    "venue_table_id" TEXT,
    "venue_table_member_id" TEXT,
    "hosted_table_id" TEXT,
    "hosted_table_member_id" TEXT,
    "items" JSONB NOT NULL,
    "subtotal_zar" DOUBLE PRECISION NOT NULL,
    "service_fee_zar" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_zar" DOUBLE PRECISION NOT NULL,
    "status" "MenuAddonStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "ticket_id" TEXT,
    "paid_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_addon_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "menu_addon_orders_paystack_reference_key" ON "menu_addon_orders"("paystack_reference");
CREATE INDEX "menu_addon_orders_user_id_idx" ON "menu_addon_orders"("user_id");
CREATE INDEX "menu_addon_orders_venue_id_idx" ON "menu_addon_orders"("venue_id");
CREATE INDEX "menu_addon_orders_parent_reference_idx" ON "menu_addon_orders"("parent_reference");
CREATE INDEX "menu_addon_orders_parent_ticket_id_idx" ON "menu_addon_orders"("parent_ticket_id");
CREATE INDEX "menu_addon_orders_status_idx" ON "menu_addon_orders"("status");

ALTER TYPE "RefundType" ADD VALUE IF NOT EXISTS 'MENU_ADDON';
