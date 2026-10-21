const test = require('node:test');
const assert = require('node:assert/strict');
const o = require('../assets/ordering.js');

const FULL = { domain: 'x.myshopify.com', storefrontAccessToken: 'pub', collectionId: '123', areaKey: 'Area' };
const EMPTY = { domain: '', storefrontAccessToken: '', collectionId: '', areaKey: '' };

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

// A fake Buy Button cart whose updateAttributes behaves like Shopify: it returns the same cart with the attributes it got.
function fakeCart(lineItems, attrs) {
  const calls = [];
  const cart = {
    model: { id: 'gid://cart/1', lineItems, customAttributes: attrs || [] },
    props: { client: { checkout: { updateAttributes: (id, input) => {
      calls.push([id, input]);
      return Promise.resolve({ id, lineItems, customAttributes: input.customAttributes });
    } } } },
    opened: 0,
    onCheckout() { this.opened += 1; },
  };
  return { cart, calls };
}
const ITEMS = [{ quantity: 2, variant: { price: { amount: '5.0' } } }];
const KEY = 'Area';
const confirmed = (area, lineItems) => ({ id: 'gid://cart/1', lineItems: lineItems || ITEMS, customAttributes: [{ key: 'Area', value: area }] });

// A checkout controller over one fake cart; area, guard and what it showed are inspectable.
function fakeCheckout(cart, opts) {
  const st = { area: 'Entrance', areaKey: KEY, timeoutMs: 50, shown: [], busy: [], guard: { failed: false }, ...opts };
  st.attempt = o.createCheckout({
    getCart: () => cart,
    getArea: () => st.area,
    areaKey: st.areaKey,
    show: (k) => st.shown.push(k),
    setBusy: (b) => st.busy.push(b),
    guard: st.guard,
    timeoutMs: st.timeoutMs,
  });
  return st;
}
const last = (a) => a[a.length - 1];

test('sendArea: sets the Area cart attribute and confirms it', async () => {
  const { cart, calls } = fakeCart(ITEMS);
  await o.sendArea(cart, 'Outside', KEY, 50);
  assert.deepEqual(calls, [['gid://cart/1', { customAttributes: [{ key: 'Area', value: 'Outside' }] }]]);
  assert.deepEqual(cart.model.customAttributes, [{ key: 'Area', value: 'Outside' }]);
});

test('sendArea: keeps unrelated cart attributes and replaces an old Area (forge #2)', async () => {
  const { cart, calls } = fakeCart(ITEMS, [{ key: 'Source', value: 'qr', extra: 1 }, { key: 'Area', value: 'Upstairs' }]);
  await o.sendArea(cart, 'Outside', KEY, 50);
  assert.deepEqual(calls[0][1].customAttributes, [{ key: 'Source', value: 'qr' }, { key: 'Area', value: 'Outside' }]);
});

test('sendArea: empty area key rejects and sends nothing', async () => {
  const { cart, calls } = fakeCart(ITEMS);
  await assert.rejects(o.sendArea(cart, 'Upstairs', '', 50));
  await assert.rejects(o.sendArea(cart, 'Upstairs', '  ', 50));
  assert.equal(calls.length, 0);
});

test('sendArea: refuses a value outside the three areas', async () => {
  const { cart, calls } = fakeCart(ITEMS);
  await assert.rejects(o.sendArea(cart, 'Kitchen', KEY, 50));
  assert.equal(calls.length, 0);
});

test('sendArea: a null result is not a confirmation (forge #2)', async () => {
  const { cart } = fakeCart(ITEMS);
  cart.props.client.checkout.updateAttributes = () => Promise.resolve(null);
  await assert.rejects(o.sendArea(cart, 'Outside', KEY, 50), /confirm/);
});

test('sendArea: a result for another cart or without the area is not a confirmation (forge #2)', async () => {
  const { cart } = fakeCart(ITEMS);
  cart.props.client.checkout.updateAttributes = () => Promise.resolve({ id: 'gid://cart/OTHER', customAttributes: [{ key: 'Area', value: 'Outside' }] });
  await assert.rejects(o.sendArea(cart, 'Outside', KEY, 50), /confirm/);
  cart.props.client.checkout.updateAttributes = (id) => Promise.resolve({ id, customAttributes: [{ key: 'Area', value: 'Upstairs' }] });
  await assert.rejects(o.sendArea(cart, 'Outside', KEY, 50), /confirm/);
  assert.equal(cart.model.customAttributes.length, 0);
});

test('sendArea: a synchronous SDK error becomes a rejection (forge #2)', async () => {
  const { cart } = fakeCart(ITEMS);
  cart.props.client.checkout.updateAttributes = () => { throw new Error('sdk blew up'); };
  await assert.rejects(o.sendArea(cart, 'Outside', KEY, 50), /sdk blew up/);
});

test('sendArea: a save that never answers times out (forge #2)', async () => {
  const { cart } = fakeCart(ITEMS);
  cart.props.client.checkout.updateAttributes = never;
  await assert.rejects(o.sendArea(cart, 'Outside', KEY, 20), /did not confirm/);
});

test('checkout: no area shows the message and does not check out', async () => {
  const { cart, calls } = fakeCart(ITEMS);
  const st = fakeCheckout(cart, { area: undefined });
  assert.equal(await st.attempt(), 'no-area');
  assert.deepEqual(st.shown, ['no-area']);
  assert.equal(calls.length, 0);
  assert.equal(cart.opened, 0);
});

test('checkout: area sent and confirmed, then checkout opens once; busy around the save', async () => {
  const { cart, calls } = fakeCart(ITEMS);
  const st = fakeCheckout(cart);
  assert.equal(await st.attempt(), 'checkout');
  assert.equal(calls.length, 1);
  assert.equal(cart.opened, 1);
  assert.deepEqual(st.shown, [null]);
  assert.deepEqual(st.busy, [true, false]);
});

test('checkout: empty area key never opens checkout', async () => {
  const { cart } = fakeCart(ITEMS);
  const st = fakeCheckout(cart, { areaKey: '' });
  assert.equal(await st.attempt(), 'error');
  assert.equal(cart.opened, 0);
  assert.equal(last(st.shown), 'failed');
});

test('checkout: failed area update never opens checkout and can be retried', async () => {
  const { cart } = fakeCart(ITEMS);
  const real = cart.props.client.checkout.updateAttributes;
  cart.props.client.checkout.updateAttributes = () => Promise.reject(new Error('network'));
  const st = fakeCheckout(cart);
  assert.equal(await st.attempt(), 'error');
  assert.equal(cart.opened, 0);
  assert.equal(last(st.shown), 'failed');
  cart.props.client.checkout.updateAttributes = real;
  assert.equal(await st.attempt(), 'checkout');
  assert.equal(cart.opened, 1);
});

test('checkout: null save result shows the error and never opens checkout (forge #2)', async () => {
  const { cart } = fakeCart(ITEMS);
  cart.props.client.checkout.updateAttributes = () => Promise.resolve(null);
  const st = fakeCheckout(cart);
  assert.equal(await st.attempt(), 'error');
  assert.equal(cart.opened, 0);
  assert.equal(last(st.shown), 'failed');
  assert.deepEqual(st.busy, [true, false]);
});

test('checkout: empty cart does nothing', async () => {
  const { cart, calls } = fakeCart([]);
  const st = fakeCheckout(cart);
  assert.equal(await st.attempt(), 'empty');
  assert.equal(calls.length, 0);
  assert.equal(cart.opened, 0);
});

test('checkout: repeated clicks while saving make one save and one checkout (forge #1)', async () => {
  const { cart, calls } = fakeCart(ITEMS);
  const d = deferred();
  cart.props.client.checkout.updateAttributes = (id, input) => { calls.push([id, input]); return d.p; };
  const st = fakeCheckout(cart);
  const first = st.attempt();
  assert.equal(await st.attempt(), 'busy');
  d.resolve(confirmed('Entrance'));
  assert.equal(await first, 'checkout');
  assert.equal(calls.length, 1);
  assert.equal(cart.opened, 1);
});

test('checkout: area changed while the save was pending does not open checkout (forge #1)', async () => {
  const { cart } = fakeCart(ITEMS);
  const d = deferred();
  cart.props.client.checkout.updateAttributes = () => d.p;
  const st = fakeCheckout(cart, { area: 'Upstairs' });
  const run = st.attempt();
  st.area = 'Outside';
  d.resolve(confirmed('Upstairs'));
  assert.equal(await run, 'changed');
  assert.equal(cart.opened, 0);
  assert.equal(last(st.shown), 'changed');
  assert.deepEqual(st.busy, [true, false]);
});

test('checkout: cart emptied while saving does not open checkout (forge #1)', async () => {
  const { cart } = fakeCart(ITEMS);
  const d = deferred();
  cart.props.client.checkout.updateAttributes = () => d.p;
  const st = fakeCheckout(cart);
  const run = st.attempt();
  d.resolve(confirmed('Entrance', []));
  assert.equal(await run, 'empty');
  assert.equal(cart.opened, 0);
});

test('checkout: a save that times out fails, and its late answer never opens checkout (forge #2)', async () => {
  const { cart } = fakeCart(ITEMS);
  const d = deferred();
  cart.props.client.checkout.updateAttributes = () => d.p;
  const st = fakeCheckout(cart, { timeoutMs: 20 });
  assert.equal(await st.attempt(), 'error');
  assert.equal(last(st.shown), 'failed');
  d.resolve(confirmed('Entrance'));
  await tick(); await tick();
  assert.equal(cart.opened, 0);
});

test('checkout: fallback during the save means checkout never opens', async () => {
  const { cart } = fakeCart(ITEMS);
  const d = deferred();
  cart.props.client.checkout.updateAttributes = () => d.p;
  const st = fakeCheckout(cart);
  const run = st.attempt();
  st.guard.failed = true;
  d.resolve(confirmed('Entrance'));
  assert.equal(await run, 'blocked');
  assert.equal(cart.opened, 0);
});

test('checkout: after the fallback nothing is sent', async () => {
  const { cart, calls } = fakeCart(ITEMS);
  const st = fakeCheckout(cart, { guard: { failed: true } });
  assert.equal(await st.attempt(), 'blocked');
  assert.equal(calls.length, 0);
});

test('checkout: a throwing onCheckout is reported, not left unhandled', async () => {
  const { cart } = fakeCart(ITEMS);
  cart.onCheckout = () => { throw new Error('popup blocked'); };
  const st = fakeCheckout(cart);
  assert.equal(await st.attempt(), 'error');
  assert.equal(last(st.shown), 'failed');
  assert.deepEqual(st.busy, [true, false]);
});


// --- final review fixes ---

test('isConfigured also needs a non-blank areaKey (review #4)', () => {
  assert.equal(o.isConfigured({ ...FULL, areaKey: '' }), false);
  assert.equal(o.isConfigured({ ...FULL, areaKey: '  ' }), false);
  assert.equal(o.isConfigured({ ...FULL, areaKey: undefined }), false);
  assert.equal(o.decideView('on', '', { ...FULL, areaKey: '' }), 'fallback');
  assert.equal(o.decideView('preview', '?preview=order', { ...FULL, areaKey: '' }), 'not-configured');
});

function fakeClick(isCheckout) {
  const ev = { stopped: 0, prevented: 0,
    target: { closest: (sel) => (isCheckout && sel === o.CHECKOUT_SELECTOR ? {} : null) },
    stopPropagation() { this.stopped += 1; }, stopImmediatePropagation() { this.stopped += 1; }, preventDefault() { this.prevented += 1; } };
  return ev;
}

test('checkoutCapture: takes over a Checkout click before Shopify sees it (review #1)', async () => {
  const ev = fakeClick(true);
  const attempt = spy(() => Promise.resolve('no-area'));
  const r = await o.checkoutCapture(ev, { guard: { failed: false }, attempt });
  assert.ok(ev.stopped > 0);
  assert.ok(ev.prevented > 0);
  assert.equal(r, 'no-area');
  assert.equal(attempt.calls.length, 1);
});

test('checkoutCapture: ignores clicks that are not on Checkout', async () => {
  const ev = fakeClick(false);
  const attempt = spy(() => Promise.resolve('checkout'));
  const r = await o.checkoutCapture(ev, { guard: { failed: false }, attempt });
  assert.equal(r, null);
  assert.equal(ev.stopped, 0);
  assert.equal(attempt.calls.length, 0);
});

test('checkoutCapture: after the fallback a Checkout click is swallowed', async () => {
  const ev = fakeClick(true);
  const attempt = spy(() => Promise.resolve('checkout'));
  const r = await o.checkoutCapture(ev, { guard: { failed: true }, attempt });
  assert.ok(ev.stopped > 0);
  assert.equal(r, 'blocked');
  assert.equal(attempt.calls.length, 0);
});

test('fallback hides any Shopify cart drawer already on the page (review #2)', async () => {
  const { doc, classes } = fakeDom();
  await o.init(fakeWin('on', '', FULL), doc, {
    loadScript: () => Promise.resolve(), wait: () => Promise.reject(new Error('timeout')), buildShop: never,
  });
  assert.equal(classes.has('ordering-failed'), true);
});

test('an empty Shopify collection counts as a failure and keeps prices (review #3)', async () => {
  const { els, doc, classes } = fakeDom();
  const r = await o.init(fakeWin('on', '', FULL, { SAUVAGE_HIDE_MENU_PRICES: true }), doc,
    { loadScript: () => Promise.resolve(), wait: never, buildShop: () => Promise.resolve(0) });
  assert.equal(r, 'fallback');
  assert.equal(els.order.attrs['data-state'], 'fallback');
  assert.equal(classes.has('hide-menu-prices'), false);
});

// --- browser check 21 Oct: the real Buy Button draws products after createComponent returns ---

function fakeSection(counts) {
  let n = 0;
  return { querySelectorAll: (sel) => { assert.equal(sel, '.shopify-buy__product'); return { length: counts[Math.min(n++, counts.length - 1)] }; } };
}

test('waitForProducts resolves once Shopify has drawn the products', async () => {
  const count = await o.waitForProducts(fakeSection([0, 0, 0, 9]), { failed: false }, 5);
  assert.equal(count, 9);
});

test('waitForProducts stops quietly after the fallback', async () => {
  const guard = { failed: false };
  const p = o.waitForProducts(fakeSection([0]), guard, 5);
  guard.failed = true;
  assert.equal(await p, 0);
});
