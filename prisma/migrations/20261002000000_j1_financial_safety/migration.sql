-- DropForeignKey
ALTER TABLE "AdminAuditLog" DROP CONSTRAINT "AdminAuditLog_adminUserId_fkey";

-- DropForeignKey
ALTER TABLE "AdminRefund" DROP CONSTRAINT "AdminRefund_adminUserId_fkey";

-- DropForeignKey
ALTER TABLE "AdminRefund" DROP CONSTRAINT "AdminRefund_recipientUserId_fkey";

-- DropForeignKey
ALTER TABLE "AffiliateCommission" DROP CONSTRAINT "AffiliateCommission_affiliateId_fkey";

-- DropForeignKey
ALTER TABLE "AgentDeposit" DROP CONSTRAINT "AgentDeposit_userId_fkey";

-- DropForeignKey
ALTER TABLE "AgentFloatEntry" DROP CONSTRAINT "AgentFloatEntry_agentId_fkey";

-- DropForeignKey
ALTER TABLE "AgentPayout" DROP CONSTRAINT "AgentPayout_agentId_fkey";

-- DropForeignKey
ALTER TABLE "AgentProfile" DROP CONSTRAINT "AgentProfile_userId_fkey";

-- DropForeignKey
ALTER TABLE "AgentWithdrawal" DROP CONSTRAINT "AgentWithdrawal_userId_fkey";

-- DropForeignKey
ALTER TABLE "BusinessLedgerEntry" DROP CONSTRAINT "BusinessLedgerEntry_businessId_fkey";

-- DropForeignKey
ALTER TABLE "BusinessLedgerEntry" DROP CONSTRAINT "BusinessLedgerEntry_businessWalletId_fkey";

-- DropForeignKey
ALTER TABLE "BusinessWallet" DROP CONSTRAINT "BusinessWallet_businessId_fkey";

-- DropForeignKey
ALTER TABLE "DeliveryEscrow" DROP CONSTRAINT "DeliveryEscrow_deliveryTaskId_fkey";

-- DropForeignKey
ALTER TABLE "HeldTransaction" DROP CONSTRAINT "HeldTransaction_userId_fkey";

-- DropForeignKey
ALTER TABLE "KoriTransaction" DROP CONSTRAINT "KoriTransaction_recipientId_fkey";

-- DropForeignKey
ALTER TABLE "KoriTransaction" DROP CONSTRAINT "KoriTransaction_senderId_fkey";

-- DropForeignKey
ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_userId_fkey";

-- DropForeignKey
ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_walletId_fkey";

-- DropForeignKey
ALTER TABLE "MerchantVoucher" DROP CONSTRAINT "MerchantVoucher_businessId_fkey";

-- DropForeignKey
ALTER TABLE "MerchantVoucher" DROP CONSTRAINT "MerchantVoucher_userId_fkey";

-- DropForeignKey
ALTER TABLE "MoneyRequest" DROP CONSTRAINT "MoneyRequest_payerId_fkey";

-- DropForeignKey
ALTER TABLE "MoneyRequest" DROP CONSTRAINT "MoneyRequest_requesterId_fkey";

-- DropForeignKey
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_orderId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentFund" DROP CONSTRAINT "PaymentFund_userId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollRun" DROP CONSTRAINT "PayrollRun_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "RailTransaction" DROP CONSTRAINT "RailTransaction_userId_fkey";

-- DropForeignKey
ALTER TABLE "ScheduledPayment" DROP CONSTRAINT "ScheduledPayment_userId_fkey";

-- DropForeignKey
ALTER TABLE "SchoolFeePayment" DROP CONSTRAINT "SchoolFeePayment_periodId_fkey";

-- DropForeignKey
ALTER TABLE "SchoolFeePayment" DROP CONSTRAINT "SchoolFeePayment_studentId_fkey";

-- DropForeignKey
ALTER TABLE "SolidarityContribution" DROP CONSTRAINT "SolidarityContribution_campaignId_fkey";

-- DropForeignKey
ALTER TABLE "StripeDeposit" DROP CONSTRAINT "StripeDeposit_userId_fkey";

-- DropForeignKey
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_eventId_fkey";

-- DropForeignKey
ALTER TABLE "TontineMembership" DROP CONSTRAINT "TontineMembership_groupId_fkey";

-- DropForeignKey
ALTER TABLE "TontineMembership" DROP CONSTRAINT "TontineMembership_userId_fkey";

-- DropForeignKey
ALTER TABLE "TradeInvoice" DROP CONSTRAINT "TradeInvoice_buyerUserId_fkey";

-- DropForeignKey
ALTER TABLE "TradeInvoice" DROP CONSTRAINT "TradeInvoice_supplierBusinessId_fkey";

-- DropForeignKey
ALTER TABLE "TransferUndo" DROP CONSTRAINT "TransferUndo_recipientUserId_fkey";

-- DropForeignKey
ALTER TABLE "TransferUndo" DROP CONSTRAINT "TransferUndo_senderUserId_fkey";

-- DropForeignKey
ALTER TABLE "Wallet" DROP CONSTRAINT "Wallet_userId_fkey";

-- DropForeignKey
ALTER TABLE "WorkerReceipt" DROP CONSTRAINT "WorkerReceipt_workerProfileId_fkey";

-- AlterTable
ALTER TABLE "DeliveryEscrow" ADD COLUMN     "amountKoriHeld" INTEGER;

-- AlterTable
ALTER TABLE "OtpCode" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accountRecoveredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "RateLimitBucket_updatedAt_idx" ON "RateLimitBucket"("updatedAt");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KoriTransaction" ADD CONSTRAINT "KoriTransaction_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KoriTransaction" ADD CONSTRAINT "KoriTransaction_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessWallet" ADD CONSTRAINT "BusinessWallet_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessLedgerEntry" ADD CONSTRAINT "BusinessLedgerEntry_businessWalletId_fkey" FOREIGN KEY ("businessWalletId") REFERENCES "BusinessWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessLedgerEntry" ADD CONSTRAINT "BusinessLedgerEntry_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerReceipt" ADD CONSTRAINT "WorkerReceipt_workerProfileId_fkey" FOREIGN KEY ("workerProfileId") REFERENCES "WorkerProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeInvoice" ADD CONSTRAINT "TradeInvoice_supplierBusinessId_fkey" FOREIGN KEY ("supplierBusinessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeInvoice" ADD CONSTRAINT "TradeInvoice_buyerUserId_fkey" FOREIGN KEY ("buyerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryEscrow" ADD CONSTRAINT "DeliveryEscrow_deliveryTaskId_fkey" FOREIGN KEY ("deliveryTaskId") REFERENCES "DeliveryTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolidarityContribution" ADD CONSTRAINT "SolidarityContribution_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SolidarityCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TontineMembership" ADD CONSTRAINT "TontineMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TontineGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TontineMembership" ADD CONSTRAINT "TontineMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoneyRequest" ADD CONSTRAINT "MoneyRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoneyRequest" ADD CONSTRAINT "MoneyRequest_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantVoucher" ADD CONSTRAINT "MerchantVoucher_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantVoucher" ADD CONSTRAINT "MerchantVoucher_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentFund" ADD CONSTRAINT "PaymentFund_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledPayment" ADD CONSTRAINT "ScheduledPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RailTransaction" ADD CONSTRAINT "RailTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HeldTransaction" ADD CONSTRAINT "HeldTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminRefund" ADD CONSTRAINT "AdminRefund_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminRefund" ADD CONSTRAINT "AdminRefund_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferUndo" ADD CONSTRAINT "TransferUndo_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferUndo" ADD CONSTRAINT "TransferUndo_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "PayrollEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolFeePayment" ADD CONSTRAINT "SchoolFeePayment_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "SchoolFeePeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolFeePayment" ADD CONSTRAINT "SchoolFeePayment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "SchoolStudent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPayout" ADD CONSTRAINT "AgentPayout_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentDeposit" ADD CONSTRAINT "AgentDeposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentWithdrawal" ADD CONSTRAINT "AgentWithdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentFloatEntry" ADD CONSTRAINT "AgentFloatEntry_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeDeposit" ADD CONSTRAINT "StripeDeposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateCommission" ADD CONSTRAINT "AffiliateCommission_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "AffiliateProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- J1 financial invariants (CHECK >= 0 balances, append-only ledgers):
-- see prisma/sql/financial-invariants.sql — applied idempotently on every deploy.
