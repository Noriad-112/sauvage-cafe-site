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

function fakeDom() {
  const els = {};
  const products = { innerHTML: 'PRODUCTS' };
  ['order', 'order-bar', 'order-bar-sum', 'order-bar-btn'].forEach((id) => {
    els[id] = {
      id, hidden: true, attrs: {}, textContent: '',
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      querySelector() { return products; },
      addEventListener() {},
    };
  });
  const classes = new Set();
  const doc = {
    getElementById: (id) => els[id] || null,
    body: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) } },
  };
  return { els, doc, classes, products };
}
const fakeWin = (setting, search, cfg, extra) => ({
  SAUVAGE_ORDERING: setting, SAUVAGE_SHOPIFY: cfg, location: { search }, console: { error() {} }, ...extra,
});
const never = () => new Promise(() => {});
const spy = (impl) => { const f = (...a) => { f.calls.push(a); return impl(...a); }; f.calls = []; return f; };
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
const tick = () => new Promise((r) => setImmediate(r));

test('init: hidden view leaves section hidden and loads nothing', async () => {
  const { els, doc } = fakeDom();
  const loadScript = spy(() => Promise.resolve());
  const r = await o.init(fakeWin('preview', '', FULL), doc, { loadScript, wait: never, buildShop: () => Promise.resolve() });
  assert.equal(r, 'hidden');
  assert.equal(els.order.hidden, true);
  assert.equal(loadScript.calls.length, 0);
});

test('init: off never loads Shopify even with preview param', async () => {
  const { doc } = fakeDom();
  const loadScript = spy(() => Promise.resolve());
  await o.init(fakeWin('off', '?preview=order', FULL), doc, { loadScript, wait: never, buildShop: () => Promise.resolve() });
  assert.equal(loadScript.calls.length, 0);
});

test('init: preview without config shows note, loads nothing', async () => {
  const { els, doc } = fakeDom();
  const loadScript = spy(() => Promise.resolve());
  const r = await o.init(fakeWin('preview', '?preview=order', EMPTY), doc, { loadScript, wait: never, buildShop: () => Promise.resolve() });
  assert.equal(r, 'not-configured');
  assert.equal(els.order.attrs['data-state'], 'not-configured');
  assert.equal(loadScript.calls.length, 0);
});

test('init: on without config shows fallback, loads nothing', async () => {
  const { els, doc } = fakeDom();
  const loadScript = spy(() => Promise.resolve());
  const r = await o.init(fakeWin('on', '', EMPTY), doc, { loadScript, wait: never, buildShop: () => Promise.resolve() });
  assert.equal(r, 'fallback');
  assert.equal(els.order.attrs['data-state'], 'fallback');
  assert.equal(loadScript.calls.length, 0);
});

test('init: shows loading state while SDK is pending', () => {
  const { els, doc } = fakeDom();
  o.init(fakeWin('on', '', FULL), doc, { loadScript: never, wait: never, buildShop: () => Promise.resolve() });
  assert.equal(els.order.hidden, false);
  assert.equal(els.order.attrs['data-state'], 'loading');
});

test('init: loads SDK URL then builds, ends ready', async () => {
  const { els, doc } = fakeDom();
  const loadScript = spy(() => Promise.resolve());
  const buildShop = spy(() => Promise.resolve());
  const r = await o.init(fakeWin('on', '', FULL), doc, { loadScript, wait: never, buildShop });
  assert.equal(r, 'ready');
  assert.deepEqual(loadScript.calls, [[o.SDK_URL]]);
  assert.equal(buildShop.calls[0][3], FULL);
  assert.equal(els.order.attrs['data-state'], 'ready');
});

test('init: SDK load error falls back', async () => {
  const { els, doc } = fakeDom();
  const r = await o.init(fakeWin('on', '', FULL), doc, {
    loadScript: () => Promise.reject(new Error('blocked')), wait: never, buildShop: () => Promise.resolve(),
  });
  assert.equal(r, 'fallback');
  assert.equal(els.order.attrs['data-state'], 'fallback');
});

test('init: build error falls back', async () => {
  const { doc } = fakeDom();
  const r = await o.init(fakeWin('on', '', FULL), doc, {
    loadScript: () => Promise.resolve(), wait: never, buildShop: () => Promise.reject(new Error('bad collection')),
  });
  assert.equal(r, 'fallback');
});

test('init: falls back when build hangs past the timeout', async () => {
  const { doc } = fakeDom();
  const wait = spy(() => Promise.reject(new Error('timeout')));
  const r = await o.init(fakeWin('on', '', FULL), doc, { loadScript: () => Promise.resolve(), wait, buildShop: never });
  assert.equal(r, 'fallback');
  assert.deepEqual(wait.calls, [[o.LOAD_TIMEOUT_MS]]);
});

test('init: late SDK after timeout is ignored', async () => {
  const { els, doc } = fakeDom();
  const sdk = deferred();
  const buildShop = spy(() => Promise.resolve());
  const r = await o.init(fakeWin('on', '', FULL), doc, {
    loadScript: () => sdk.p, wait: () => Promise.reject(new Error('timeout')), buildShop,
  });
  assert.equal(r, 'fallback');
  sdk.resolve();             // Shopify finally arrives
  await tick(); await tick();
  assert.equal(buildShop.calls.length, 0);
  assert.equal(els.order.attrs['data-state'], 'fallback');
  assert.equal(els['order-bar'].hidden, true);
});

test('init: late build after timeout is torn down', async () => {
  const { els, doc, products } = fakeDom();
  const built = deferred();
  let guardSeen;
  const r = await o.init(fakeWin('on', '', FULL), doc, {
    loadScript: () => Promise.resolve(),
    wait: () => new Promise((_, rej) => setImmediate(() => rej(new Error('timeout')))),
    buildShop: (w, d, s, c, guard) => { guardSeen = guard; return built.p; },
  });
  assert.equal(r, 'fallback');
  assert.equal(guardSeen.failed, true);
  products.innerHTML = 'LATE CART';  // what a late Shopify build would render
  built.resolve();                   // build completes too late
  await tick(); await tick();
  assert.equal(els.order.attrs['data-state'], 'fallback');
  assert.equal(products.innerHTML, '');
  assert.equal(els['order-bar'].hidden, true);
});

test('init: page without the section does nothing', async () => {
  const doc = { getElementById: () => null };
  assert.equal(await o.init(fakeWin('on', '', FULL), doc, {}), 'missing');
});

test('renderBar shows count and total', () => {
  const { els, doc, classes } = fakeDom();
  o.renderBar(doc, { count: 2, total: 15 });
  assert.equal(els['order-bar'].hidden, false);
  assert.equal(els['order-bar-sum'].textContent, '· 2 items · €15');
  assert.equal(classes.has('has-order-bar'), true);
});

test('renderBar hides bar for an empty cart', () => {
  const { els, doc, classes } = fakeDom();
  o.renderBar(doc, { count: 2, total: 15 });
  o.renderBar(doc, { count: 0, total: 0 });
  assert.equal(els['order-bar'].hidden, true);
  assert.equal(classes.has('has-order-bar'), false);
});

test('AREAS is exactly Upstairs, Entrance, Outside', () => {
  assert.deepEqual(o.AREAS.map((a) => a.value), ['Upstairs', 'Entrance', 'Outside']);
});

test('isArea accepts only the three values', () => {
  assert.equal(o.isArea('Outside'), true);
  assert.equal(o.isArea('outside'), false);
  assert.equal(o.isArea('Kitchen'), false);
  assert.equal(o.isArea(undefined), false);
});

test('checkoutBlocker', () => {
  assert.equal(o.checkoutBlocker('Outside', { count: 0, total: 0 }), 'empty');
  assert.equal(o.checkoutBlocker(undefined, { count: 2, total: 15 }), 'no-area');
  assert.equal(o.checkoutBlocker('Garden', { count: 2, total: 15 }), 'no-area');
  assert.equal(o.checkoutBlocker('Upstairs', { count: 2, total: 15 }), null);
});

test('shouldHidePrices needs the flag and a loaded Shopify list', () => {
  assert.equal(o.shouldHidePrices({ SAUVAGE_HIDE_MENU_PRICES: true }, 'ready'), true);
  assert.equal(o.shouldHidePrices({ SAUVAGE_HIDE_MENU_PRICES: true }, 'fallback'), false);
  assert.equal(o.shouldHidePrices({ SAUVAGE_HIDE_MENU_PRICES: true }, 'loading'), false);
  assert.equal(o.shouldHidePrices({ SAUVAGE_HIDE_MENU_PRICES: false }, 'ready'), false);
  assert.equal(o.shouldHidePrices({ SAUVAGE_HIDE_MENU_PRICES: 'true' }, 'ready'), false);
  assert.equal(o.shouldHidePrices({}, 'ready'), false);
});

test('init hides menu prices only after ready with the flag on', async () => {
  const { doc, classes } = fakeDom();
  await o.init(fakeWin('on', '', FULL, { SAUVAGE_HIDE_MENU_PRICES: true }), doc,
    { loadScript: () => Promise.resolve(), wait: never, buildShop: () => Promise.resolve() });
  assert.equal(classes.has('hide-menu-prices'), true);
});

test('init keeps menu prices when Shopify fails, even with the flag on', async () => {
  const { doc, classes } = fakeDom();
  await o.init(fakeWin('on', '', FULL, { SAUVAGE_HIDE_MENU_PRICES: true }), doc,
    { loadScript: () => Promise.reject(new Error('x')), wait: never, buildShop: () => Promise.resolve() });
  assert.equal(classes.has('hide-menu-prices'), false);
});

test('init keeps menu prices when the flag is off', async () => {
  const { doc, classes } = fakeDom();
  await o.init(fakeWin('on', '', FULL), doc,
    { loadScript: () => Promise.resolve(), wait: never, buildShop: () => Promise.resolve() });
  assert.equal(classes.has('hide-menu-prices'), false);
});
