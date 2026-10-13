/**
 * J13-F3/F5 — every notification kind the server emits opens something useful (or, for purely informative
 * kinds, shows no dead button). Kinds collected from lib/ createInAppNotification calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferKind, routeForKind } from '../../src/lib/notification-route.js';

const n = (kind, extra = {}) => ({ kind, title: 'x', body: 'y', ...extra });

test('emitted kinds map to a destination', () => {
  const expect = {
    jekkal: 'jekkal', hub_parcel: 'parcel', marketplace_order: 'order', low_stock: 'stock', support_ticket: 'support',
    trade_invoice: 'trade', trade_invoice_paid: 'trade', trade_invoice_overdue: 'trade', trade_cod_paid: 'trade', trade_account: 'trade',
    scheduled_payment: 'scheduled', scheduled_save: 'scheduled', agent_payout: 'agent', agent_approved: 'agent',
    agent_float_topup_approved: 'agent', business_invitation: 'business', distribution_invitation: 'business',
    friend: 'friend', call: 'call', affiliate: 'affiliate', money_request: 'money', work_offer: 'work', shipment_delivered: 'delivery',
  };
  for (const [k, kind] of Object.entries(expect)) assert.equal(inferKind(n(k)), kind, k);
  for (const kind of ['parcel', 'order', 'stock', 'support', 'trade', 'scheduled', 'agent', 'business']) {
    assert.ok(routeForKind(kind, 'ref1')?.screen, `${kind} has a screen`);
  }
  assert.deepEqual(routeForKind('parcel', 'p1'), { screen: 'HubParcelDetail', params: { parcelId: 'p1' } });
  assert.equal(routeForKind('generic', 'r'), null, 'no dead button for informative notices');
});
