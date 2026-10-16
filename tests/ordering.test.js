const test = require('node:test');
const assert = require('node:assert/strict');
const o = require('../assets/ordering.js');

const FULL = { domain: 'x.myshopify.com', storefrontAccessToken: 'pub', collectionId: '123', areaTransport: 'attribute' };
const EMPTY = { domain: '', storefrontAccessToken: '', collectionId: '', areaTransport: '' };

test('isConfigured needs all three non-blank values', () => {
  assert.equal(o.isConfigured(FULL), true);
  assert.equal(o.isConfigured(EMPTY), false);
  assert.equal(o.isConfigured(undefined), false);
  assert.equal(o.isConfigured({ ...FULL, collectionId: '   ' }), false);
});

test('decideView: off is always hidden', () => {
  assert.equal(o.decideView('off', '', FULL), 'hidden');
  assert.equal(o.decideView('off', '?preview=order', FULL), 'hidden');
});

test('decideView: preview is hidden without the param', () => {
  assert.equal(o.decideView('preview', '', FULL), 'hidden');
  assert.equal(o.decideView('preview', '?preview=menu', FULL), 'hidden');
});

test('decideView: preview with param loads or reports missing config', () => {
  assert.equal(o.decideView('preview', '?preview=order', FULL), 'load');
  assert.equal(o.decideView('preview', '?preview=order', EMPTY), 'not-configured');
});

test('decideView accepts extra params and any case', () => {
  assert.equal(o.decideView('preview', '?utm_source=qr&preview=order', FULL), 'load');
  assert.equal(o.decideView('preview', '?preview=ORDER', FULL), 'load');
});

test('decideView: on shows to everyone, falls back without config', () => {
  assert.equal(o.decideView('on', '', FULL), 'load');
  assert.equal(o.decideView('on', '', EMPTY), 'fallback');
});

test('decideView: unknown or missing setting is hidden', () => {
  assert.equal(o.decideView(undefined, '?preview=order', FULL), 'hidden');
  assert.equal(o.decideView('ON', '', FULL), 'hidden');
});

test('cartSummary handles both Shopify price shapes', () => {
  const items = [
    { quantity: 2, variant: { price: '5.00' } },
    { quantity: 1, variant: { price: { amount: '10.0' } } },
  ];
  assert.deepEqual(o.cartSummary(items), { count: 3, total: 20 });
  assert.deepEqual(o.cartSummary([]), { count: 0, total: 0 });
  assert.deepEqual(o.cartSummary(undefined), { count: 0, total: 0 });
});

test('formatSummary is empty for an empty cart', () => {
  assert.equal(o.formatSummary({ count: 0, total: 0 }), '');
});

test('formatSummary singular, plural, whole euros', () => {
  assert.equal(o.formatSummary({ count: 1, total: 5 }), '· 1 item · €5');
  assert.equal(o.formatSummary({ count: 2, total: 15 }), '· 2 items · €15');
});

test('formatSummary rounds and uses comma cents', () => {
  const s = o.cartSummary([{ quantity: 3, variant: { price: '4.95' } }]);
  assert.equal(o.formatSummary(s), '· 3 items · €14,85');
  assert.equal(o.formatSummary({ count: 1, total: 12.5 }), '· 1 item · €12,50');
});
