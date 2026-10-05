/** J5 — merchant-mode UX rules (src/lib/business-ux.js), pure. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chargeState, moneyLine, orderButtons, reasonProblem, stockBadge, visibleSections } from '../../src/lib/business-ux.js';
import { BUSINESS_ROLES } from '../../lib/authz/catalog.js';

const keys = (role) => visibleSections(BUSINESS_ROLES[role].caps).map((s) => s.key);

test('each role sees only its sections — a cashier sees Today + Encaisser + Commandes, never Équipe/Activité/Paie', () => {
  assert.deepEqual(keys('cashier'), ['today', 'payments', 'orders']);
  assert.deepEqual(keys('fulfillment'), ['today', 'orders', 'customers']);
  assert.deepEqual(keys('inventory'), ['today', 'orders', 'products', 'stock']);
  assert.ok(keys('finance').includes('activity') && !keys('finance').includes('team'));
  assert.ok(keys('manager').includes('team') && keys('manager').includes('settings'));
  assert.deepEqual(keys('viewer'), ['today']);
});

test('order buttons follow capability: fulfilment moves, cancel/refund only with their capability', () => {
  const order = { actions: { next: ['preparing'], cancel: true, refund: false } };
  const fulfil = { capabilities: BUSINESS_ROLES.fulfillment.caps };
  assert.deepEqual(orderButtons(order, fulfil).map((b) => b.kind), ['move']);
  const mgr = { capabilities: BUSINESS_ROLES.manager.caps };
  assert.deepEqual(orderButtons(order, mgr).map((b) => b.kind), ['move', 'cancel']);
  assert.deepEqual(orderButtons({ actions: { next: [], cancel: false, refund: true } }, { capabilities: BUSINESS_ROLES.cashier.caps }), []);
  assert.ok(orderButtons(order, mgr).find((b) => b.kind === 'cancel').needsReason);
});

test('money lines never invent an amount the server withheld; stock badges; charge states; reasons', () => {
  assert.deepEqual(moneyLine({ category: 'restricted', label: 'Mouvement réservé', amountKori: null }), { label: 'Mouvement réservé', amount: '—', tone: 'muted' });
  assert.equal(moneyLine({ category: 'sale', label: 'Vente', direction: 'in', amountKori: 300 }).amount, '+300 ₭');
  assert.equal(stockBadge({ kind: 'service', trackInventory: false }).label, 'Service / sans stock');
  assert.match(stockBadge({ kind: 'product', trackInventory: true, inventory: -2 }).label, /2 en commande/);
  assert.equal(stockBadge({ kind: 'product', trackInventory: true, inventory: 3, lowStock: true }).tone, 'warn');
  const now = new Date('2026-10-08T10:00:00Z');
  assert.equal(chargeState({ status: 'open', expiresAt: '2026-10-08T10:20:00Z' }, now).showQr, true);
  assert.equal(chargeState({ status: 'open', expiresAt: '2026-10-08T09:59:00Z' }, now).label, 'Expiré');
  assert.equal(chargeState({ status: 'paid' }, now).showQr, false);
  assert.ok(reasonProblem('  '));
  assert.equal(reasonProblem('casse'), null);
});
