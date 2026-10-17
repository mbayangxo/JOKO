-- J12-F12 / P-J12-4: balance-by-SMS becomes opt-in for NEW accounts. Default change only:
-- no existing row is modified (turning current users off is a separate, reviewed production decision).
ALTER TABLE "User" ALTER COLUMN "smsBalanceQueryEnabled" SET DEFAULT false;
