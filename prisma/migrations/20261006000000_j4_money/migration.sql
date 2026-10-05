-- AlterTable
ALTER TABLE "MoneyRequest" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MerchantCharge" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "paymentRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MerchantCharge_code_key" ON "MerchantCharge"("code");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantCharge_paymentRef_key" ON "MerchantCharge"("paymentRef");

-- CreateIndex
CREATE INDEX "MerchantCharge_businessId_status_idx" ON "MerchantCharge"("businessId", "status");

