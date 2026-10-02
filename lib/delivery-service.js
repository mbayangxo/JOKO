import { formatKori, KORI_EARN, nationalToKori } from './kori.js';
import { distanceKm, estimateMinutesFromDistance, formatDistanceKm } from './geo.js';
import { debitNational, creditNational, lockWallets, runMoneyTransaction } from './wallet-atomic.js';
import { touchRiderActivity } from './cron/rider-status.js';
import { recordWorkerReceiptInTx } from './worker-service.js';

const DISPUTE_HOLD_HOURS = 24;
const AUTO_RELEASE_MINUTES = 30;

export class DeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'DeliveryError';
  }
}

export function deliveryErrorStatus(code) {
  switch (code) {
    case 'not_found':
      return 404;
    case 'forbidden':
      return 403;
    case 'invalid_state':
    case 'insufficient':
      return 400;
    default:
      return 400;
  }
}

function isAssignedTo(task, userId) {
  return task.assignedDriverId === userId;
}

function isBuyer(task, userId) {
  return task.buyerId === userId;
}

export function deliveryListShape(task, { riderLat, riderLng, viewerId, accepted, hub } = {}) {
  const distance =
    riderLat != null && riderLng != null && task.pickupLat != null && task.pickupLng != null
      ? distanceKm(riderLat, riderLng, task.pickupLat, task.pickupLng)
      : null;

  const showExact =
    accepted ||
    isAssignedTo(task, viewerId) ||
    task.status !== 'open';

  const hubInfo = hub ?? task.hub ?? null;

  return {
    id: task.id,
    status: task.status,
    pickup: {
      type: task.pickupType,
      label: task.pickupLabel ?? task.pickupAddress ?? 'Point de collecte',
      address: task.pickupAddress,
      lat: task.pickupLat,
      lng: task.pickupLng,
    },
    hub: hubInfo
      ? {
          id: hubInfo.id,
          name: hubInfo.name,
          address: hubInfo.address,
          isWarehouse: hubInfo.isWarehouse ?? false,
        }
      : null,
    productSummary: task.productSummary ?? null,
    dropoff: {
      area: task.dropoffArea,
      exact: showExact ? (task.dropoffExact ?? task.dropoffAddress) : null,
      lat: showExact ? task.dropoffLat : null,
      lng: showExact ? task.dropoffLng : null,
    },
    distanceKm: distance,
    distanceLabel: formatDistanceKm(distance),
    estimatedMinutes: task.estimatedMinutes ?? estimateMinutesFromDistance(distance),
    // The rider is paid the buyer's escrowed delivery fee (no minted reward).
    riderKoriEarnings: nationalToKori(task.deliveryFeeNational ?? 0, 'SN'),
    riderKoriFormatted: formatKori(nationalToKori(task.deliveryFeeNational ?? 0, 'SN')),
    deliveryFeeNational: task.deliveryFeeNational,
    createdAt: task.createdAt.toISOString(),
  };
}

export async function listNearbyDeliveries(db, { riderLat, riderLng, viewerId }) {
  const tasks = await db.deliveryTask.findMany({
    where: { status: 'open' },
    include: { hub: true },
    orderBy: { createdAt: 'desc' },
  });

  const shaped = tasks.map((task) =>
    deliveryListShape(task, { riderLat, riderLng, viewerId, accepted: false, hub: task.hub }),
  );

  if (riderLat != null && riderLng != null) {
    shaped.sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
  }

  return shaped;
}

export async function getDeliveryDetail(db, taskId, viewerId) {
  const task = await db.deliveryTask.findUnique({
    where: { id: taskId },
    include: { escrow: true, dispute: { include: { evidence: true } }, hub: true },
  });

  if (!task) throw new DeliveryError('not_found', 'Delivery not found');

  const canView =
    task.status === 'open' ||
    isAssignedTo(task, viewerId) ||
    isBuyer(task, viewerId);

  if (!canView) throw new DeliveryError('forbidden', 'Not allowed to view this delivery');

  const accepted = isAssignedTo(task, viewerId) || task.status !== 'open';

  return {
    ...deliveryListShape(task, { viewerId, accepted, hub: task.hub }),
    buyerId: isBuyer(task, viewerId) || isAssignedTo(task, viewerId) ? task.buyerId : undefined,
    assignedDriverId: task.assignedDriverId,
    pickedUpAt: task.pickedUpAt?.toISOString() ?? null,
    deliveredAt: task.deliveredAt?.toISOString() ?? null,
    confirmedAt: task.confirmedAt?.toISOString() ?? null,
    autoReleaseAt: task.autoReleaseAt?.toISOString() ?? null,
    escrow: task.escrow
      ? {
          status: task.escrow.status,
          amountNational: task.escrow.amountNational,
          koriPayout: task.escrow.koriPayout,
        }
      : null,
    dispute: task.dispute
      ? {
          id: task.dispute.id,
          status: task.dispute.status,
          holdUntil: task.dispute.holdUntil.toISOString(),
          evidence: task.dispute.evidence.map((e) => ({
            id: e.id,
            userId: e.userId,
            type: e.type,
            content: e.content,
            lat: e.lat,
            lng: e.lng,
            createdAt: e.createdAt.toISOString(),
          })),
        }
      : null,
  };
}

export async function createDeliveryTask(db, params) {
  const {
    orderId,
    buyerId,
    pickupType = 'merchant',
    pickupLabel,
    pickupAddress,
    pickupLat,
    pickupLng,
    dropoffArea,
    dropoffExact,
    dropoffLat,
    dropoffLng,
    dropoffAddress,
    deliveryFeeNational = 1500,
    riderKoriEarnings = KORI_EARN.delivery,
    estimatedMinutes,
    hubId,
    productSummary,
  } = params;

  if (!orderId || !buyerId || !dropoffArea || !dropoffAddress) {
    throw new DeliveryError('invalid_state', 'Missing required delivery fields');
  }

  const distance =
    pickupLat != null && pickupLng != null && dropoffLat != null && dropoffLng != null
      ? distanceKm(pickupLat, pickupLng, dropoffLat, dropoffLng)
      : null;

  return db.deliveryTask.create({
    data: {
      orderId,
      buyerId,
      pickupType,
      pickupLabel,
      pickupAddress,
      pickupLat,
      pickupLng,
      dropoffArea,
      dropoffExact,
      dropoffLat,
      dropoffLng,
      dropoffAddress,
      deliveryFeeNational,
      riderKoriEarnings,
      estimatedMinutes: estimatedMinutes ?? estimateMinutesFromDistance(distance),
      status: 'open',
      hubId: hubId ?? null,
      productSummary: productSummary ?? null,
    },
  });
}

/**
 * Rider accepts — atomically reserve buyer funds in escrow (no rider payout yet).
 */
export async function acceptDelivery(db, { taskId, riderId, reference }) {
  const task = await db.deliveryTask.findUnique({
    where: { id: taskId },
    include: { order: true, escrow: true },
  });

  if (!task) throw new DeliveryError('not_found', 'Delivery not found');
  if (task.status !== 'open') throw new DeliveryError('invalid_state', 'Delivery is no longer available');
  if (task.escrow) throw new DeliveryError('invalid_state', 'Delivery already has escrow');

  const buyerWallet = await db.wallet.findUnique({ where: { userId: task.buyerId } });
  if (!buyerWallet) throw new DeliveryError('invalid_state', 'Buyer wallet not found');

  const riderWallet = await db.wallet.findUnique({ where: { userId: riderId } });
  if (!riderWallet) throw new DeliveryError('invalid_state', 'Rider wallet not found');

  const fee = task.deliveryFeeNational;
  const buyer = await db.user.findUnique({ where: { id: task.buyerId }, select: { country: true } });
  // Escrow holds the fee converted to ₭; the same ₭ are later paid to the rider
  // or refunded to the buyer — value is moved, never minted or destroyed.
  const koriHeld = nationalToKori(fee, buyer?.country ?? 'SN');

  return runMoneyTransaction(db, async (tx) => {
    // Claim the task atomically so two riders can't both accept it.
    const claimed = await tx.deliveryTask.updateMany({
      where: { id: task.id, status: 'open' },
      data: { status: 'assigned', assignedDriverId: riderId },
    });
    if (claimed.count === 0) throw new DeliveryError('invalid_state', 'Delivery is no longer available');

    await debitNational(tx, {
      walletId: buyerWallet.id,
      userId: task.buyerId,
      amount: koriHeld,
      reference,
      ledger: {
        type: 'delivery_escrow_hold',
        counterpartyName: 'K21 Escrow',
        note: `Livraison · réservation ${task.id}`,
      },
    });

    await tx.deliveryEscrow.create({
      data: {
        deliveryTaskId: task.id,
        buyerId: task.buyerId,
        riderId,
        amountNational: fee,
        koriPayout: koriHeld,
        amountKoriHeld: koriHeld,
        status: 'reserved',
        reference,
      },
    });

    return tx.deliveryTask.findUniqueOrThrow({ where: { id: task.id } });
  }).then(async (updated) => {
    await touchRiderActivity(db, riderId, 'busy');
    return updated;
  });
}

export async function markPickedUp(db, { taskId, riderId }) {
  const task = await db.deliveryTask.findUnique({ where: { id: taskId }, include: { escrow: true } });
  if (!task) throw new DeliveryError('not_found', 'Delivery not found');
  if (!isAssignedTo(task, riderId)) throw new DeliveryError('forbidden', 'Not your delivery');
  if (task.status !== 'assigned') throw new DeliveryError('invalid_state', `Cannot pick up from status ${task.status}`);
  if (!task.escrow || task.escrow.status !== 'reserved') {
    throw new DeliveryError('invalid_state', 'Escrow not reserved');
  }

  return db.deliveryTask.update({
    where: { id: taskId },
    data: { status: 'picked_up', pickedUpAt: new Date() },
  }).then(async (updated) => {
    if (updated.orderId) {
      await db.order.updateMany({
        where: { id: updated.orderId, status: { in: ['confirmed', 'preparing', 'pending_delivery'] } },
        data: { status: 'out_for_delivery' },
      });
    }
    await touchRiderActivity(db, riderId, 'busy');
    return updated;
  });
}

export async function markDelivered(db, { taskId, riderId }) {
  const task = await db.deliveryTask.findUnique({
    where: { id: taskId },
    include: { escrow: true, dispute: true },
  });
  if (!task) throw new DeliveryError('not_found', 'Delivery not found');
  if (!isAssignedTo(task, riderId)) throw new DeliveryError('forbidden', 'Not your delivery');
  if (!['picked_up', 'in_transit'].includes(task.status)) {
    throw new DeliveryError('invalid_state', `Cannot mark delivered from status ${task.status}`);
  }

  const autoReleaseAt = new Date(Date.now() + AUTO_RELEASE_MINUTES * 60 * 1000);

  return db.deliveryTask.update({
    where: { id: taskId },
    data: {
      status: 'delivered',
      deliveredAt: new Date(),
      autoReleaseAt,
    },
  }).then(async (updated) => {
    if (updated.orderId) {
      await db.order.updateMany({
        where: { id: updated.orderId, status: { in: ['out_for_delivery', 'pending_delivery'] } },
        data: { status: 'delivered' },
      });
    }
    await touchRiderActivity(db, riderId, 'available');
    return updated;
  });
}

async function releaseEscrowToRiderInTx(tx, task) {
  await tx.$executeRaw`SELECT id FROM "DeliveryEscrow" WHERE "deliveryTaskId" = ${task.id} FOR UPDATE`;
  const escrow = await tx.deliveryEscrow.findUnique({ where: { deliveryTaskId: task.id } });
  if (!escrow || !['reserved', 'disputed_held'].includes(escrow.status)) {
    throw new DeliveryError('invalid_state', 'Escrow not available for release');
  }

  const riderWallet = await tx.wallet.findUnique({ where: { userId: escrow.riderId } });
  if (!riderWallet) throw new DeliveryError('invalid_state', 'Rider wallet not found');

  // Pay the rider exactly what was escrowed from the buyer.
  const koriAmount = escrow.amountKoriHeld ?? escrow.amountNational;

  await creditNational(tx, {
    walletId: riderWallet.id,
    userId: escrow.riderId,
    amount: koriAmount,
    reference: `${escrow.reference}-PAYOUT`,
    ledger: {
      type: 'delivery_payout',
      counterpartyName: 'K21 Escrow',
      note: `Livraison · ${task.id}`,
    },
  });

  await tx.deliveryEscrow.update({
    where: { id: escrow.id },
    data: { status: 'released', releasedAt: new Date() },
  });

  const updatedTask = await tx.deliveryTask.update({
    where: { id: task.id },
    data: { status: 'completed', confirmedAt: new Date() },
  });

  const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: riderWallet.id } });

  if (escrow.riderId) {
    await recordWorkerReceiptInTx(tx, {
      userId: escrow.riderId,
      kind: 'delivery',
      sourceId: task.id,
      amountNational: escrow.amountNational,
      koriAmount: koriAmount,
      title: `Livraison · ${task.dropoffArea}`,
      subtitle: task.pickupLabel ?? task.pickupAddress ?? 'Course K21',
      reference: `${escrow.reference}-WR`,
    });
  }

  return { task: updatedTask, wallet, koriCredited: koriAmount };
}

async function releaseEscrowToRider(db, task) {
  return runMoneyTransaction(db, (tx) => releaseEscrowToRiderInTx(tx, task));
}

export async function confirmDelivery(db, { taskId, buyerId }) {
  const task = await db.deliveryTask.findUnique({
    where: { id: taskId },
    include: { escrow: true, dispute: true },
  });
  if (!task) throw new DeliveryError('not_found', 'Delivery not found');
  if (!isBuyer(task, buyerId)) throw new DeliveryError('forbidden', 'Only the customer can confirm');
  if (task.status !== 'delivered') throw new DeliveryError('invalid_state', 'Delivery not yet marked as delivered');
  if (task.dispute?.status === 'open') {
    throw new DeliveryError('invalid_state', 'Delivery is under dispute');
  }

  return releaseEscrowToRider(db, task);
}

export async function openDispute(db, { taskId, buyerId, note }) {
  const task = await db.deliveryTask.findUnique({
    where: { id: taskId },
    include: { escrow: true, dispute: true },
  });
  if (!task) throw new DeliveryError('not_found', 'Delivery not found');
  if (!isBuyer(task, buyerId)) throw new DeliveryError('forbidden', 'Only the customer can open a dispute');
  if (task.status !== 'delivered') throw new DeliveryError('invalid_state', 'Can only dispute after rider marks delivered');
  if (task.dispute) throw new DeliveryError('invalid_state', 'Dispute already open');

  const holdUntil = new Date(Date.now() + DISPUTE_HOLD_HOURS * 60 * 60 * 1000);

  return runMoneyTransaction(db, async (tx) => {
    await tx.deliveryEscrow.update({
      where: { deliveryTaskId: task.id },
      data: { status: 'disputed_held' },
    });

    const dispute = await tx.deliveryDispute.create({
      data: {
        deliveryTaskId: task.id,
        openedByUserId: buyerId,
        status: 'open',
        holdUntil,
        resolution: note ?? null,
      },
    });

    const updated = await tx.deliveryTask.update({
      where: { id: task.id },
      data: { status: 'disputed' },
    });

    return { task: updated, dispute };
  });
}

export async function submitDisputeEvidence(db, { taskId, userId, type, content, lat, lng }) {
  const task = await db.deliveryTask.findUnique({
    where: { id: taskId },
    include: { dispute: true },
  });
  if (!task?.dispute) throw new DeliveryError('not_found', 'No open dispute');
  if (task.dispute.status !== 'open') throw new DeliveryError('invalid_state', 'Dispute is closed');

  const isParty = isBuyer(task, userId) || isAssignedTo(task, userId);
  if (!isParty) throw new DeliveryError('forbidden', 'Not a party to this delivery');

  return db.deliveryDisputeEvidence.create({
    data: {
      disputeId: task.dispute.id,
      userId,
      type,
      content,
      lat: lat ?? null,
      lng: lng ?? null,
    },
  });
}

export async function resolveDispute(db, { taskId, outcome, resolutionNote }) {
  const task = await db.deliveryTask.findUnique({
    where: { id: taskId },
    include: { escrow: true, dispute: true },
  });
  if (!task?.dispute) throw new DeliveryError('not_found', 'No dispute found');
  if (!['open', 'under_review'].includes(task.dispute.status)) {
    throw new DeliveryError('invalid_state', 'Dispute already resolved');
  }

  if (outcome === 'rider') {
    return runMoneyTransaction(db, async (tx) => {
      await tx.deliveryDispute.update({
        where: { id: task.dispute.id },
        data: {
          status: 'resolved_rider',
          resolution: resolutionNote ?? 'Resolved in favor of rider',
          resolvedAt: new Date(),
        },
      });
      return releaseEscrowToRiderInTx(tx, task);
    });
  }

  return runMoneyTransaction(db, async (tx) => {
    await tx.$executeRaw`SELECT id FROM "DeliveryEscrow" WHERE "deliveryTaskId" = ${task.id} FOR UPDATE`;
    const escrow = await tx.deliveryEscrow.findUnique({ where: { deliveryTaskId: task.id } });
    if (escrow && (escrow.status === 'disputed_held' || escrow.status === 'reserved')) {
      await creditNational(tx, {
        walletId: (await tx.wallet.findUniqueOrThrow({ where: { userId: task.buyerId } })).id,
        userId: task.buyerId,
        amount: escrow.amountKoriHeld ?? escrow.amountNational,
        reference: `${escrow.reference}-REFUND`,
        ledger: {
          type: 'delivery_escrow_refund',
          note: 'Remboursement litige livraison',
        },
      });
      await tx.deliveryEscrow.update({
        where: { id: escrow.id },
        data: { status: 'refunded', releasedAt: new Date() },
      });
    }

    await tx.deliveryDispute.update({
      where: { id: task.dispute.id },
      data: {
        status: 'resolved_customer',
        resolution: resolutionNote ?? 'Resolved in favor of customer',
        resolvedAt: new Date(),
      },
    });

    return tx.deliveryTask.update({
      where: { id: task.id },
      data: { status: 'cancelled' },
    });
  });
}

export async function processAutoReleases(db) {
  const now = new Date();
  const due = await db.deliveryTask.findMany({
    where: {
      status: 'delivered',
      autoReleaseAt: { lte: now },
    },
    include: { escrow: true, dispute: true },
  });

  const results = [];
  for (const task of due) {
    if (task.dispute?.status === 'open') continue;
    try {
      const released = await releaseEscrowToRider(db, task);
      results.push({ taskId: task.id, ok: true, koriCredited: released.koriCredited });
    } catch (error) {
      console.error('[delivery auto-release]', task.id, error);
      results.push({ taskId: task.id, ok: false, error: error instanceof Error ? error.message : 'failed' });
    }
  }
  return results;
}

export async function processDisputeDeadlines(db) {
  const now = new Date();
  const expired = await db.deliveryDispute.findMany({
    where: { status: 'open', holdUntil: { lte: now } },
    include: { delivery: { include: { escrow: true } } },
  });

  const results = [];
  for (const dispute of expired) {
    await db.deliveryDispute.update({
      where: { id: dispute.id },
      data: { status: 'under_review' },
    });
    results.push({
      disputeId: dispute.id,
      taskId: dispute.deliveryTaskId,
      action: 'moved_to_under_review',
      message: 'Awaiting admin resolution',
    });
  }
  return results;
}
