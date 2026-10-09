-- J11 collective money engine. ADDITIVE ONLY: new tables; no legacy tontine table or row is touched.
-- CreateTable
CREATE TABLE "CollectiveGroup" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "rulesVersion" INTEGER NOT NULL DEFAULT 0,
    "rulesHash" TEXT,
    "rulesJson" TEXT,
    "contributionKori" INTEGER NOT NULL,
    "frequency" TEXT NOT NULL,
    "graceDays" INTEGER NOT NULL DEFAULT 3,
    "rotationMethod" TEXT NOT NULL DEFAULT 'draw',
    "targetKori" INTEGER,
    "withdrawPolicy" TEXT,
    "cycleCount" INTEGER,
    "currentCycle" INTEGER NOT NULL DEFAULT 0,
    "startAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "frozenAt" TIMESTAMP(3),
    "frozenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectiveGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectiveMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'invited',
    "position" INTEGER,
    "acceptedRulesVersion" INTEGER,
    "acceptedRulesHash" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "invitedById" TEXT,
    "joinedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectiveMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectiveObligation" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "graceUntil" TIMESTAMP(3) NOT NULL,
    "amountDueKori" INTEGER NOT NULL,
    "amountPaidKori" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectiveObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectivePayment" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectivePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectivePayout" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "recipientId" TEXT NOT NULL,
    "amountKori" INTEGER NOT NULL,
    "basis" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectivePayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectiveVote" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cycle" INTEGER,
    "topic" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "subjectUser" TEXT,
    "payloadJson" TEXT NOT NULL,
    "eligibleJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectiveVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectiveBallot" (
    "id" TEXT NOT NULL,
    "voteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "choice" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectiveBallot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectiveDispute" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "openedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "ruledBy" TEXT,
    "ruledAt" TIMESTAMP(3),
    "rulingNote" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectiveDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectiveEvent" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "detailJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectiveEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CollectiveGroup_organizerId_idx" ON "CollectiveGroup"("organizerId");

-- CreateIndex
CREATE INDEX "CollectiveGroup_status_idx" ON "CollectiveGroup"("status");

-- CreateIndex
CREATE INDEX "CollectiveMember_userId_idx" ON "CollectiveMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectiveMember_groupId_userId_key" ON "CollectiveMember"("groupId", "userId");

-- CreateIndex
CREATE INDEX "CollectiveObligation_groupId_cycle_idx" ON "CollectiveObligation"("groupId", "cycle");

-- CreateIndex
CREATE INDEX "CollectiveObligation_userId_status_idx" ON "CollectiveObligation"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CollectiveObligation_groupId_cycle_userId_key" ON "CollectiveObligation"("groupId", "cycle", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectivePayment_reference_key" ON "CollectivePayment"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "CollectivePayment_idempotencyKey_key" ON "CollectivePayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CollectivePayment_groupId_cycle_idx" ON "CollectivePayment"("groupId", "cycle");

-- CreateIndex
CREATE INDEX "CollectivePayment_userId_createdAt_idx" ON "CollectivePayment"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollectivePayout_reference_key" ON "CollectivePayout"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "CollectivePayout_groupId_cycle_key" ON "CollectivePayout"("groupId", "cycle");

-- CreateIndex
CREATE INDEX "CollectiveVote_groupId_status_idx" ON "CollectiveVote"("groupId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CollectiveBallot_voteId_userId_key" ON "CollectiveBallot"("voteId", "userId");

-- CreateIndex
CREATE INDEX "CollectiveDispute_groupId_status_idx" ON "CollectiveDispute"("groupId", "status");

-- CreateIndex
CREATE INDEX "CollectiveDispute_status_createdAt_idx" ON "CollectiveDispute"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CollectiveEvent_groupId_createdAt_idx" ON "CollectiveEvent"("groupId", "createdAt");

-- AddForeignKey
ALTER TABLE "CollectiveMember" ADD CONSTRAINT "CollectiveMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CollectiveGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectiveObligation" ADD CONSTRAINT "CollectiveObligation_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CollectiveGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectivePayment" ADD CONSTRAINT "CollectivePayment_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CollectiveGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectivePayout" ADD CONSTRAINT "CollectivePayout_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CollectiveGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectiveVote" ADD CONSTRAINT "CollectiveVote_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CollectiveGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectiveBallot" ADD CONSTRAINT "CollectiveBallot_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "CollectiveVote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectiveDispute" ADD CONSTRAINT "CollectiveDispute_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CollectiveGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectiveEvent" ADD CONSTRAINT "CollectiveEvent_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CollectiveGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- J11: group money history, payouts and ballots are append-only.
DROP TRIGGER IF EXISTS "CollectivePayment_append_only" ON "CollectivePayment";
CREATE TRIGGER "CollectivePayment_append_only" BEFORE UPDATE OR DELETE ON "CollectivePayment"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
DROP TRIGGER IF EXISTS "CollectivePayout_append_only" ON "CollectivePayout";
CREATE TRIGGER "CollectivePayout_append_only" BEFORE UPDATE OR DELETE ON "CollectivePayout"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
DROP TRIGGER IF EXISTS "CollectiveEvent_append_only" ON "CollectiveEvent";
CREATE TRIGGER "CollectiveEvent_append_only" BEFORE UPDATE OR DELETE ON "CollectiveEvent"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();
DROP TRIGGER IF EXISTS "CollectiveBallot_append_only" ON "CollectiveBallot";
CREATE TRIGGER "CollectiveBallot_append_only" BEFORE UPDATE OR DELETE ON "CollectiveBallot"
  FOR EACH ROW EXECUTE FUNCTION joko_ledger_append_only();

-- J11: rules are locked once a group is active. Nobody (organizer, code bug or operator) can change
-- the accepted terms, rotation, amount or schedule afterwards; groups are never deleted.
CREATE OR REPLACE FUNCTION joko_collective_rules_locked() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'collective groups are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('active', 'completed', 'cancelled') AND (
       NEW."rulesHash" IS DISTINCT FROM OLD."rulesHash" OR NEW."rulesJson" IS DISTINCT FROM OLD."rulesJson"
    OR NEW."rulesVersion" IS DISTINCT FROM OLD."rulesVersion" OR NEW."contributionKori" IS DISTINCT FROM OLD."contributionKori"
    OR NEW.frequency IS DISTINCT FROM OLD.frequency OR NEW."cycleCount" IS DISTINCT FROM OLD."cycleCount"
    OR NEW."targetKori" IS DISTINCT FROM OLD."targetKori" OR NEW."withdrawPolicy" IS DISTINCT FROM OLD."withdrawPolicy"
    OR NEW."organizerId" IS DISTINCT FROM OLD."organizerId" OR NEW.kind IS DISTINCT FROM OLD.kind) THEN
    RAISE EXCEPTION 'collective rules are locked after activation' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('completed', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a closed collective group cannot reopen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "CollectiveGroup_rules_locked" ON "CollectiveGroup";
CREATE TRIGGER "CollectiveGroup_rules_locked" BEFORE UPDATE OR DELETE ON "CollectiveGroup"
  FOR EACH ROW EXECUTE FUNCTION joko_collective_rules_locked();

-- A member's position in the rotation is unique within a group.
CREATE UNIQUE INDEX "CollectiveMember_group_position_key" ON "CollectiveMember"("groupId", "position") WHERE "position" IS NOT NULL;
