/**
 * Shared foreign-object sources for the authorization sweeps (J3 mutation
 * sweep + J8 authorization-boundary gate). Each entry selects rows that are
 * NOT the attacker's ($ME = attacker id, $MYBIZ = attacker's businesses).
 */
/** Object id sources for each param route (rows that are NOT the attacker's). */
export function sourceFor(routeKey) {
  const path = routeKey.split(' ')[1];
  const map = [
    [/^payment-funds\/:id/, `SELECT "id" FROM "PaymentFund" WHERE "userId" <> $ME`],
    [/^scheduled-payments\/:id/, `SELECT "id" FROM "ScheduledPayment" WHERE "userId" <> $ME`],
    [/^hubs\/parcels\/:id/, `SELECT "id" FROM "HubParcel"`],
    [/^marketplace\/products\/:id/, `SELECT p."id" FROM "Product" p WHERE p."businessId" IS NULL OR p."businessId" NOT IN ($MYBIZ)`],
    [/^marketplace\/business\/:id/, `SELECT "id" FROM "Business" WHERE "id" NOT IN ($MYBIZ)`],
    [/^marketplace\/orders\/:id/, `SELECT "id" FROM "Order" WHERE "buyerId" IS DISTINCT FROM $ME`],
    [/^distribution\/invoices\/:id/, `SELECT "id" FROM "TradeInvoice"`],
    [/^transfers\/:reference\/undo/, `SELECT "reference" FROM "LedgerEntry" WHERE "type" = 'send' AND "userId" <> $ME`],
    [/^transfers\/requests\/:id/, `SELECT "id" FROM "MoneyRequest" WHERE "requesterId" <> $ME AND "payerId" IS DISTINCT FROM $ME`],
    [/^deliveries\/:id/, `SELECT "id" FROM "DeliveryTask" WHERE "buyerId" IS DISTINCT FROM $ME AND "assignedDriverId" IS DISTINCT FROM $ME`],
    [/^agent\/deposits\/:id/, `SELECT "id" FROM "AgentDeposit"`],
    [/^agent\/withdrawals\/:id/, `SELECT "id" FROM "AgentWithdrawal"`],
    // J6: foreign cash transactions and service points.
    [/^agent-cash\/tx\/:id/, `SELECT "id" FROM "AgentCashTransaction" WHERE "customerId" <> $ME`],
    [/^agent\/cash\/:id/, `SELECT "id" FROM "AgentCashTransaction" WHERE "customerId" <> $ME`],
    [/^agent\/service-points\/:id/, `SELECT sp."id" FROM "AgentServicePoint" sp JOIN "AgentOrganization" o ON o."id" = sp."organizationId" WHERE o."ownerUserId" <> $ME`],
    [/^tontine\/groups\/:id/, `SELECT "id" FROM "TontineGroup" WHERE "createdBy" <> $ME`],
    [/^mbolo\/threads\/:id/, `SELECT t."id" FROM "MboloThread" t WHERE NOT EXISTS (SELECT 1 FROM "MboloMember" m WHERE m."threadId" = t."id" AND m."userId" = $ME)`],
    [/^mbolo\/messages\/:id/, `SELECT "id" FROM "MboloMessage" WHERE "senderId" <> $ME`],
    // J10: someone else's moderation decision (appealing it must be refused).
    [/^me\/moderation\/:id/, `SELECT "id" FROM "ModerationAction" WHERE "userId" <> $ME`],
    [/^mbolo\/vault\/:id/, `SELECT "id" FROM "MbooloMediaAsset" WHERE "ownerId" <> $ME`],
    [/^mbolo\/gifs\/:id/, `SELECT "id" FROM "MbooloGif"`],
    [/^events\/:id/, `SELECT "id" FROM "Event" WHERE "promoterId" <> $ME`],
    [/^jekkal\/campaigns\/:id/, `SELECT "id" FROM "SolidarityCampaign" WHERE "creatorId" <> $ME`],
    [/^friends\/requests\/:id/, `SELECT "id" FROM "FriendRequest" WHERE "toId" <> $ME AND "fromId" <> $ME`],
    [/^friends\/:id/, `SELECT "id" FROM "User" WHERE "id" <> $ME`],
    [/^notifications\/:id/, `SELECT "id" FROM "Notification" WHERE "userId" <> $ME`],
    [/^trust\/block\/:id/, `SELECT "id" FROM "UserBlock" WHERE "blockerId" <> $ME`],
    [/^channels\/posts\/:id/, `SELECT p."id" FROM "ChannelPost" p JOIN "Channel" c ON c."id" = p."channelId" WHERE c."ownerId" <> $ME`],
    [/^channels\/:id/, `SELECT "id" FROM "Channel" WHERE "ownerId" <> $ME`],
    [/^polls\/:id/, `SELECT "id" FROM "UserPoll" WHERE "userId" <> $ME`],
    [/^merchants\/:id/, `SELECT "id" FROM "Business" WHERE "id" NOT IN ($MYBIZ)`],
    [/^affiliate\/links\/:code/, `SELECT "linkCode" FROM "AffiliateLink"`],
    [/^trending\/alerts\/:id/, `SELECT "id" FROM "RegionalAlert"`],
    [/^support\/tickets\/:id/, `SELECT "id" FROM "SupportTicket" WHERE "userId" <> $ME`],
    [/^auth\/sessions\/:id/, `SELECT "id" FROM "AuthSession" WHERE "userId" <> $ME`],
    [/^auth\/devices\/:id/, `SELECT "id" FROM "UserDevice" WHERE "userId" <> $ME`],
    // J5 business OS sub-objects: another business's own rows.
    [/^businesses\/:id\/os\/orders\/:subId/, `SELECT "businessId" || '|' || "id" FROM "Order" WHERE "businessId" IS NOT NULL AND "businessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/os\/(catalog|stock)\/:subId/, `SELECT "businessId" || '|' || "id" FROM "Product" WHERE "businessId" IS NOT NULL AND "businessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/os\/relationships\/:subId/, `SELECT "merchantBusinessId" || '|' || "id" FROM "MerchantRelationship" WHERE "merchantBusinessId" IS NOT NULL AND "merchantBusinessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/os\/integrations\/:subId/, `SELECT "businessId" || '|' || "id" FROM "ExternalLink" WHERE "businessId" IS NOT NULL AND "businessId" NOT IN ($MYBIZ)`],
    [/^me\/distribution-invitations\/:id/, `SELECT "id" FROM "MerchantRelationship" WHERE "invitedUserId" IS DISTINCT FROM $ME`],
    [/^businesses\/:id\/os\/locations\/:subId/, `SELECT "businessId" || '|' || "id" FROM "BusinessLocation" WHERE "businessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/members\/:subId/, `SELECT "businessId" || '|' || "id" FROM "BusinessMember" WHERE "businessId" NOT IN ($MYBIZ) AND "userId" <> $ME`],
    [/^businesses\/:id\/school\/periods\/:subId/, `SELECT "businessId" || '|' || "id" FROM "SchoolFeePeriod" WHERE "businessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/cooperative\/deliveries\/:subId/, `SELECT "businessId" || '|' || "id" FROM "FarmerDeliveryLog" WHERE "businessId" NOT IN ($MYBIZ)`],
    // J7 B2B sub-objects: another business's purchase orders / invoices / returns (both sides), relationships, territories, depots.
    // J8: a fresh attacker is never a party to an existing shipment / dispute.
    [/^logistics\/shipments\/:id/, `SELECT "id" FROM "Shipment"`],
    [/^logistics\/disputes\/:id/, `SELECT "id" FROM "ShipmentDispute"`],
    [/^businesses\/:id\/b2b\/purchase-orders\/:subId/, `SELECT v FROM (SELECT "buyerBusinessId" || '|' || "id" AS v FROM "PurchaseOrder" WHERE "buyerBusinessId" NOT IN ($MYBIZ) UNION ALL SELECT "sellerBusinessId" || '|' || "id" FROM "PurchaseOrder" WHERE "sellerBusinessId" NOT IN ($MYBIZ)) u`],
    [/^businesses\/:id\/b2b\/invoices\/:subId/, `SELECT v FROM (SELECT "buyerBusinessId" || '|' || "id" AS v FROM "TradeInvoice" WHERE "buyerBusinessId" IS NOT NULL AND "buyerBusinessId" NOT IN ($MYBIZ) UNION ALL SELECT "supplierBusinessId" || '|' || "id" FROM "TradeInvoice" WHERE "supplierBusinessId" NOT IN ($MYBIZ)) u`],
    [/^businesses\/:id\/b2b\/returns\/:subId/, `SELECT v FROM (SELECT "buyerBusinessId" || '|' || "id" AS v FROM "CommercialReturn" WHERE "buyerBusinessId" NOT IN ($MYBIZ) UNION ALL SELECT "sellerBusinessId" || '|' || "id" FROM "CommercialReturn" WHERE "sellerBusinessId" NOT IN ($MYBIZ)) u`],
    [/^businesses\/:id\/b2b\/relationships\/:subId/, `SELECT "distributorBusinessId" || '|' || "id" FROM "MerchantRelationship" WHERE "distributorBusinessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/b2b\/territories\/:subId/, `SELECT "distributorBusinessId" || '|' || "id" FROM "Territory" WHERE "distributorBusinessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/b2b\/depots\/:subId/, `SELECT "operatorBusinessId" || '|' || "id" FROM "InventoryLocation" WHERE "operatorBusinessId" IS NOT NULL AND "operatorBusinessId" NOT IN ($MYBIZ)`],
    // J9: another worker's offers / assignments / disputes; another business's offers / assignments / rules.
    [/^work\/offers\/:id/, `SELECT "id" FROM "WorkOffer" WHERE "workerUserId" <> $ME`],
    [/^work\/assignments\/:id/, `SELECT "id" FROM "WorkAssignment" WHERE "workerUserId" <> $ME`],
    [/^work\/opportunities\/:id/, `SELECT "id" FROM "WorkOpportunity" WHERE "businessId" NOT IN ($MYBIZ)`],
    [/^work\/applications\/:id/, `SELECT "id" FROM "WorkApplication" WHERE "workerUserId" <> $ME`],
    [/^work\/disputes\/:id/, `SELECT d."id" FROM "WorkDispute" d JOIN "WorkAssignment" a ON a."id" = d."assignmentId" WHERE a."workerUserId" <> $ME`],
    [/^work\/feedback\/:id/, `SELECT "id" FROM "WorkFeedback" WHERE "subjectUserId" IS DISTINCT FROM $ME`],
    [/^businesses\/:id\/work\/offers\/:subId/, `SELECT "businessId" || '|' || "id" FROM "WorkOffer" WHERE "businessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/work\/assignments\/:subId/, `SELECT "businessId" || '|' || "id" FROM "WorkAssignment" WHERE "businessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/work\/rules\/:subId/, `SELECT "businessId" || '|' || "id" FROM "WorkRule" WHERE "businessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/work\/opportunities\/:subId/, `SELECT "businessId" || '|' || "id" FROM "WorkOpportunity" WHERE "businessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/work\/applications\/:subId/, `SELECT o."businessId" || '|' || a."id" FROM "WorkApplication" a JOIN "WorkOpportunity" o ON o."id" = a."opportunityId" WHERE o."businessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id\/work\/disputes\/:subId/, `SELECT a."businessId" || '|' || d."id" FROM "WorkDispute" d JOIN "WorkAssignment" a ON a."id" = d."assignmentId" WHERE a."businessId" NOT IN ($MYBIZ)`],
    [/^businesses\/:id/, `SELECT "id" FROM "Business" WHERE "id" NOT IN ($MYBIZ)`],
    [/^money\/charges\/:id/, `SELECT "code" FROM "MerchantCharge" WHERE "businessId" NOT IN ($MYBIZ)`],
    [/^money\/payments\/:reference/, `SELECT e."reference" FROM "JournalEntry" e WHERE e."kind" IN ('pay_merchant','merchant_payment','charge_payment','business_payment') AND NOT EXISTS (SELECT 1 FROM "Posting" p JOIN "LedgerAccount" a ON a."id" = p."accountId" WHERE p."entryId" = e."id" AND (a."code" LIKE 'customer:' || $ME || ':%' OR a."ownerId" IN ($ME, $MYBIZ)))`],
    [/^roles\/:id/, null], // self-scoped: covered by tests/j3/authz-roles (no foreign object)
  ];
  const hit = map.find(([re]) => re.test(path));
  return hit ? hit[1] : undefined;
}

