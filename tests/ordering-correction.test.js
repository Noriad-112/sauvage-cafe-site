const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const o = require('../assets/ordering.js');

const OPEN = new Date('2026-10-23T10:00:00Z');
const CLOSED = new Date('2026-10-23T13:00:00Z'); // 15:00 Amsterdam (summer time)
const CFG = { domain: 'example.myshopify.com', storefrontAccessToken: 'synthetic', areaKey: 'Area' };
const MODEL = o.ALLOWED_PRODUCT_GIDS.map((id) => ({ id }));
const VID = 'gid://shopify/ProductVariant/1';
const line = (id, quantity) => ({ variant: { id, price: '5.00' }, quantity });
const never = () => new Promise(() => {});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function dom() {
  const classes = new Set();
  const listeners = {};
  const products = { innerHTML: '' };
  const help = { textContent: '' };
  const error = { hidden: true, textContent: '' };
  const section = {
    hidden: true, attrs: {}, count: 0,
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelector: () => products,
    querySelectorAll: () => Array(section.count).fill({}),
  };
  const els = {
    order: section,
    'order-bar': { hidden: true },
    'order-bar-sum': { textContent: '' },
    'order-bar-btn': { addEventListener() {} },
    'order-hours-message': {},
    'order-area-tpl': { innerHTML: '<p class="order-area-err" data-order-add-error role="alert" hidden></p>' },
  };
  const doc = {
    getElementById: (id) => els[id] || null,
    querySelectorAll: (selector) => selector === '[data-order-add-help]' ? [help] : selector === '[data-order-add-error]' ? [error] : [],
    addEventListener: (name, fn) => { listeners[name] = fn; },
    removeEventListener: (name) => { delete listeners[name]; },
    body: { classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) } },
  };
  const win = { SAUVAGE_ORDERING: 'on', SAUVAGE_SHOPIFY: CFG, location: { search: '' }, console: { error() {} } };
  return { doc, win, section, els, help, error, classes, listeners };
}

function init(d, deps) {
  return o.init(d.win, d.doc, {
    now: () => OPEN, watchHours: () => () => {}, loadScript: () => Promise.resolve(), wait: never,
    buildShop: () => Promise.resolve(6), ...deps,
  });
}

test('Amsterdam schedule includes Wed–Sun 09:00 and excludes 15:00, Mon and Tue', () => {
  for (const [at, expected] of [
    ['2026-10-21T06:59:59Z', false], ['2026-10-21T07:00:00Z', true],
    ['2026-10-23T12:59:59Z', true], ['2026-10-23T13:00:00Z', false],
    ['2026-10-24T07:00:00Z', true], ['2026-10-25T07:59:59Z', false],
    ['2026-10-25T08:00:00Z', true], ['2026-10-25T13:59:59Z', true],
    ['2026-10-25T14:00:00Z', false], ['2026-10-26T10:00:00Z', false],
    ['2026-10-27T10:00:00Z', false], ['2026-10-28T08:00:00Z', true],
    ['2026-03-29T06:59:59Z', false], ['2026-03-29T07:00:00Z', true],
  ]) assert.equal(o.kitchenOpen(new Date(at)), expected, at);
});

test('invalid clock, unsupported Intl, malformed or ambiguous time parts fail closed', () => {
  assert.equal(o.kitchenOpen(new Date('invalid')), false);
  for (const parts of [[], [{ type: 'hour', value: '09' }],
    [{ type: 'weekday', value: 'Wed' }, { type: 'hour', value: '24' }, { type: 'minute', value: '00' }],
    [{ type: 'weekday', value: 'Wed' }, { type: 'hour', value: '09' }, { type: 'minute', value: '60' }],
    [{ type: 'weekday', value: 'Wed' }, { type: 'hour', value: '09' }, { type: 'hour', value: '10' }, { type: 'minute', value: '00' }],
  ]) assert.equal(o.kitchenOpen(OPEN, { formatToParts: () => parts }), false);
  assert.equal(o.kitchenOpen(OPEN, { formatToParts() { throw new Error('unsupported'); } }), false);
});

test('closed init never loads SDK, even with the preview parameter or invalid clock', async () => {
  for (const now of [() => CLOSED, () => new Date('invalid'), () => { throw new Error('clock'); }]) {
    const d = dom(); let loads = 0;
    d.win.SAUVAGE_ORDERING = 'preview'; d.win.location.search = '?preview=order';
    assert.equal(await init(d, { now, loadScript() { loads++; return Promise.resolve(); } }), 'closed');
    assert.equal(loads, 0);
    assert.equal(d.section.attrs['data-state'], 'closed');
  }
});

test('missing menu help, cart error markup or schedule message fails closed before SDK', async () => {
  for (const missing of ['helper', 'template', 'schedule']) {
    const d = dom(); let loads = 0;
    if (missing === 'helper') d.doc.querySelectorAll = () => [];
    if (missing === 'template') d.els['order-area-tpl'].innerHTML = '<fieldset></fieldset>';
    if (missing === 'schedule') delete d.els['order-hours-message'];
    assert.equal(await init(d, { loadScript() { loads++; return Promise.resolve(); } }), 'fallback');
    assert.equal(loads, 0);
  }
});

test('held-open page closes, hides cart/bar and restores static prices without a cart mutation', async () => {
  const d = dom(); let now = OPEN; let check; let stopped = 0;
  d.win.SAUVAGE_HIDE_MENU_PRICES = true;
  assert.equal(await init(d, { now: () => now, watchHours(fn) { check = fn; return () => stopped++; } }), 'ready');
  assert.ok(d.classes.has('hide-menu-prices'));
  now = CLOSED; check();
  assert.equal(d.section.attrs['data-state'], 'closed');
  assert.equal(d.els['order-bar'].hidden, true);
  assert.ok(d.classes.has('ordering-closed'));
  assert.equal(d.classes.has('hide-menu-prices'), false);
  assert.equal(stopped, 1);
});

test('closing during SDK loading wins the race and prevents a late build', async () => {
  const d = dom(); const load = deferred(); let now = OPEN; let check; let builds = 0;
  const pending = init(d, {
    now: () => now, watchHours(fn) { check = fn; return () => {}; },
    loadScript: () => load.promise, buildShop: () => { builds++; return Promise.resolve(6); },
  });
  now = CLOSED; check();
  assert.equal(await pending, 'closed');
  load.resolve(); await tick();
  assert.equal(builds, 0);
  assert.equal(d.section.attrs['data-state'], 'closed');
});

test('full init rechecks closing time after delayed UI.onReady before creating any component', async () => {
  const d = dom(); const ready = deferred(); let now = OPEN; let onReadyCalls = 0; let components = 0;
  d.win.ShopifyBuy = {
    buildClient: () => ({}),
    UI: { onReady() { onReadyCalls++; return ready.promise; } },
  };
  const pending = init(d, { now: () => now, buildShop: o.buildShop });
  await tick();
  assert.equal(onReadyCalls, 1);
  // The background-tab interval has not fired. Readiness resumes exactly at closing time.
  now = CLOSED;
  ready.resolve({ createComponent() { components++; d.section.count = 6; return Promise.resolve(); } });
  assert.equal(await pending, 'closed');
  assert.equal(components, 0);
  assert.equal(d.section.attrs['data-state'], 'closed');
  assert.ok(d.classes.has('ordering-closed'));
  assert.equal(d.els['order-bar'].hidden, true);
});

test('hours watcher checks interval, focus and visibility and removes its listeners', () => {
  const d = dom(); let interval; let calls = 0; let cleared = false;
  d.win.setInterval = (fn, ms) => { interval = fn; assert.equal(ms, 1000); return 5; };
  d.win.clearInterval = (id) => { assert.equal(id, 5); cleared = true; };
  d.win.addEventListener = (name, fn) => { d.listeners[name] = fn; };
  d.win.removeEventListener = (name) => { delete d.listeners[name]; };
  const stop = o.watchHours(d.win, d.doc, () => calls++);
  interval(); d.listeners.focus(); d.listeners.visibilitychange();
  assert.equal(calls, 3); stop();
  assert.equal(cleared, true);
  assert.equal(d.listeners.focus, undefined);
  assert.equal(d.listeners.visibilitychange, undefined);
});

test('checkout checks hours before attributes and again after an in-flight attribute save', async () => {
  for (const closeDuringSave of [false, true]) {
    const save = deferred(); let now = closeDuringSave ? OPEN : CLOSED; let saves = 0; let opened = 0;
    const model = { id: 'synthetic-cart', lineItems: [line(VID, 1)], customAttributes: [] };
    const cart = { model, props: { client: { checkout: { updateAttributes() { saves++; return save.promise; } } } }, onCheckout() { opened++; } };
    const attempt = o.createCheckout({
      getCart: () => cart, getArea: () => 'Upstairs', areaKey: 'Area', guard: { failed: false },
      isOpen: () => o.kitchenOpen(now), show() {}, setBusy() {}, timeoutMs: 50,
    });
    const pending = attempt();
    if (closeDuringSave) {
      now = CLOSED;
      save.resolve({ ...model, customAttributes: [{ key: 'Area', value: 'Upstairs' }] });
    }
    assert.equal(await pending, 'closed');
    assert.equal(saves, closeDuringSave ? 1 : 0);
    assert.equal(opened, 0);
  }
});

test('ProductSet lifecycle rejects same-count substitution, duplicates and malformed IDs', () => {
  const opts = o.shopOptions({ getElementById: () => null }, () => {}, () => {}, () => {});
  for (const models of [
    [...MODEL.slice(0, 5), { id: 'gid://shopify/Product/99999999999999' }],
    [...MODEL.slice(0, 5), MODEL[0]], [{ title: 'Arepa' }], [],
  ]) assert.throws(() => opts.productSet.events.afterInit({ model: { products: models } }), /identity/);
  for (const models of [MODEL, MODEL.slice(1)]) {
    assert.doesNotThrow(() => opts.productSet.events.afterInit({ model: { products: models } }));
  }
});

// A source-inspected SDK-shaped boundary: ProductSet afterInit sees model.products; custom
// buttonDestination receives Product; cart.addVariantToCart updates model, renders, then resolves.
async function sdkBoundary(models = MODEL) {
  const d = dom(); let spec; let now = OPEN;
  const cart = { model: { id: 'synthetic-cart', lineItems: [line('other-variant', 2)] } };
  const ui = {
    components: { cart: [cart] }, openCart() {},
    createComponent(type, config) {
      assert.equal(type, 'productSet'); spec = config;
      assert.equal(config.id, undefined);
      assert.deepEqual(config.storefrontId, o.ALLOWED_PRODUCT_GIDS);
      config.options.productSet.events.afterInit({ model: { products: models } });
      d.section.count = models.length;
      config.options.cart.events.afterRender(cart);
      return Promise.resolve({ model: { products: models } });
    },
  };
  d.win.ShopifyBuy = { buildClient: () => ({}), UI: { onReady: () => Promise.resolve(ui) } };
  const result = await init(d, { buildShop: o.buildShop, now: () => now });
  return { ...d, cart, spec, result, close() { now = CLOSED; } };
}

test('SDK-shaped integration wires full-GID storefrontId and accepts five approved models', async () => {
  const d = await sdkBoundary(MODEL.slice(1));
  assert.equal(d.result, 'ready');
  assert.equal(typeof d.spec.options.product.buttonDestination, 'function');
  assert.equal(d.spec.options.productSet.contents.pagination, false);
});

test('SDK-shaped integration rejects a foreign same-count model before rendering', async () => {
  const d = await sdkBoundary([...MODEL.slice(0, 5), { id: 'gid://shopify/Product/99999999999999' }]);
  assert.equal(d.result, 'fallback');
  assert.equal(d.section.count, 0);
});

test('post-add qty0/warning alerts visibly while retaining valid existing items; normal removal is silent', async () => {
  const d = await sdkBoundary(); let addCalls = 0;
  const good = d.cart.model.lineItems[0];
  d.cart.addVariantToCart = async () => {
    addCalls++;
    d.cart.model = { id: 'synthetic-cart', lineItems: [good, line(VID, 0)], userErrors: [{ code: 'NOT_ENOUGH_IN_STOCK' }] };
    d.spec.options.cart.events.afterRender(d.cart);
    return d.cart.model;
  };
  const product = { model: MODEL[0], selectedVariant: { id: VID }, selectedQuantity: 1, cart: d.cart };
  assert.equal(await d.spec.options.product.buttonDestination(product), 'failed');
  assert.equal(addCalls, 1);
  assert.equal(d.error.hidden, false);
  assert.equal(d.error.textContent, o.ADD_FAILURE_COPY);
  assert.equal(d.cart.model.lineItems[0], good);
  assert.equal(d.els['order-bar'].hidden, false);
  d.cart.addVariantToCart = async () => {
    d.cart.model = { id: 'synthetic-cart', lineItems: [good, line(VID, 1)], userErrors: [] };
    d.spec.options.cart.events.afterRender(d.cart);
    return d.cart.model;
  };
  assert.equal(await d.spec.options.product.buttonDestination(product), 'added');
  assert.equal(d.error.hidden, true);
  // A deliberate removal calls the normal cart render path, not our Add callback.
  d.cart.model = { id: 'synthetic-cart', lineItems: [good] };
  d.spec.options.cart.events.afterRender(d.cart);
  assert.equal(d.error.hidden, true);
});

test('add confirmation checks target variant increment, zero quantity and normalized SDK warnings', () => {
  for (const model of [
    { lineItems: [line('other-variant', 9)] },
    { lineItems: [line(VID, 0)] },
    { lineItems: [line(VID, 2)] }, // already had two; no increment
    { lineItems: [line(VID, 3)], userErrors: [{ code: 'NOT_ENOUGH_IN_STOCK' }] },
    { lineItems: [line(VID, 3)], warnings: [{ code: 'MERCHANDISE_OUT_OF_STOCK' }] },
    { lineItems: [line(VID, 3)], errors: [{ message: 'error' }] },
    { lineItems: [line(VID, 3)], errors: { message: 'unknown error shape' } },
  ]) assert.equal(o.addConfirmed(2, model, VID, 1), false);
  assert.equal(o.addConfirmed(2, { lineItems: [line(VID, 3)], userErrors: [] }, VID, 1), true);
});

test('Add rejection, synchronous SDK throw, unavailable or foreign product report failure without clearing cart', async () => {
  for (const mode of ['reject', 'throw', 'foreign', 'unavailable']) {
    const d = await sdkBoundary(); let calls = 0;
    const original = d.cart.model;
    d.cart.addVariantToCart = () => { calls++; if (mode === 'throw') throw new Error('SDK'); return Promise.reject(new Error('SDK')); };
    const product = { model: mode === 'foreign' ? { id: 'gid://shopify/Product/99999999999999' } : MODEL[0], selectedVariant: { id: VID, available: mode !== 'unavailable' }, selectedQuantity: 1, cart: d.cart };
    assert.equal(await d.spec.options.product.buttonDestination(product), 'failed');
    assert.equal(calls, mode === 'foreign' || mode === 'unavailable' ? 0 : 1);
    assert.equal(d.error.hidden, false);
    assert.equal(d.cart.model, original);
  }
});

test('Add is serialized and does not send a request after kitchen closes', async () => {
  const d = await sdkBoundary(); const add = deferred(); let calls = 0;
  d.cart.addVariantToCart = () => { calls++; return add.promise; };
  const product = { model: MODEL[0], selectedVariant: { id: VID }, selectedQuantity: 1, cart: d.cart };
  const first = d.spec.options.product.buttonDestination(product); await tick();
  assert.equal(await d.spec.options.product.buttonDestination(product), 'busy');
  assert.equal(calls, 1);
  add.resolve({ lineItems: [line(VID, 1)] });
  assert.equal(await first, 'added');
  d.close();
  assert.equal(await d.spec.options.product.buttonDestination(product), 'closed');
  assert.equal(calls, 1);
});

test('self-contained HTML includes all feedback targets and ordering switch is off', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(/window\.SAUVAGE_ORDERING = "off"/.test(html));
  assert.ok(/data-order-add-help role="status" aria-live="polite"/.test(html));
  const template = html.match(/<template id="order-area-tpl">([\s\S]*?)<\/template>/);
  assert.ok(template && /data-order-add-error role="alert" hidden/.test(template[1]));
  assert.ok(/id="order-hours-message" role="status"/.test(html));
  assert.ok(html.includes('.order-section[data-state="closed"] .order-products,'));
  assert.ok(html.includes('body.ordering-closed .shopify-buy-cart-wrapper { display: none !important; }'));
  assert.equal(o.ADD_FAILURE_COPY, 'Is een gerecht niet beschikbaar of lukt het toevoegen niet? Bestel dan beneden in de keuken. · If an item is unavailable or won’t add, please order downstairs in the kitchen.');
});
