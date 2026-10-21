/*
 * Sauvage Cafe: QR table ordering via the Shopify Buy Button. Food is brought to the guest.
 * Switch (window.SAUVAGE_ORDERING), Shopify config (window.SAUVAGE_SHOPIFY) and
 * window.SAUVAGE_HIDE_MENU_PRICES live in index.html. Also loads in Node for tests.
 */
(function (root) {
  'use strict';

  var SDK_URL = 'https://sdks.shopifycdn.com/buy-button/latest/buy-button-storefront.min.js';
  var LOAD_TIMEOUT_MS = 8000;
  var SAVE_TIMEOUT_MS = 10000;

  function isKey(v) {
    return typeof v === 'string' && v.trim() !== '';
  }

  // areaKey is the cart attribute that carries the seating area, frozen with Ronin. Without it the shop counts as
  // not configured, so it never shows a cart that can't check out.
  function isConfigured(cfg) {
    return !!cfg && ['domain', 'storefrontAccessToken', 'collectionId', 'areaKey'].every(function (k) {
      return isKey(cfg[k]);
    });
  }

  function decideView(setting, search, cfg) {
    var param = new URLSearchParams(search || '').get('preview');
    var previewing = !!param && param.toLowerCase() === 'order';
    var visible = setting === 'on' || (setting === 'preview' && previewing);
    if (!visible) return 'hidden';
    if (!isConfigured(cfg)) return setting === 'on' ? 'fallback' : 'not-configured';
    return 'load';
  }

  function lineItemPrice(item) {
    var p = item && item.variant && item.variant.price;
    if (p && typeof p === 'object') p = p.amount;
    var n = Number(p);
    return isFinite(n) ? n : 0;
  }

  function cartSummary(lineItems) {
    return (lineItems || []).reduce(function (acc, item) {
      var q = Number(item && item.quantity) || 0;
      acc.count += q;
      acc.total += q * lineItemPrice(item);
      return acc;
    }, { count: 0, total: 0 });
  }

  function formatEuro(n) {
    var r = Math.round(n * 100) / 100;
    return '€' + (r % 1 === 0 ? String(r) : r.toFixed(2).replace('.', ','));
  }

  function formatSummary(s) {
    if (!s.count) return '';
    return '· ' + s.count + (s.count === 1 ? ' item' : ' items') + ' · ' + formatEuro(s.total);
  }

  function renderBar(doc, summary) {
    var bar = doc.getElementById('order-bar');
    if (!bar) return;
    var on = summary.count > 0;
    bar.hidden = !on;
    doc.getElementById('order-bar-sum').textContent = formatSummary(summary);
    doc.body.classList.toggle('has-order-bar', on);
  }

  function loadScript(doc, src) {
    return new Promise(function (resolve, reject) {
      var s = doc.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      doc.head.appendChild(s);
    });
  }

  function timeout(ms) {
    return new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('Shopify did not respond within ' + ms + 'ms')); }, ms);
    });
  }

  function hasAttr(attrs, key, value) {
    return (attrs || []).some(function (a) { return a && a.key === key && a.value === value; });
  }

  // Writes the seating area as one cart attribute and resolves only once Shopify returns this same cart with it.
  // Other attributes on the cart are kept. A thrown SDK error, a missing or wrong answer, or no answer within
  // timeoutMs all reject, so checkout stays blocked rather than sending an order without an area.
  function sendArea(cart, area, key, timeoutMs) {
    if (!isArea(area)) return Promise.reject(new Error('Unknown area: ' + area));
    if (!isKey(key)) return Promise.reject(new Error('No area key configured'));
    var id = cart.model.id;
    var attrs = (cart.model.customAttributes || []).filter(function (a) {
      return a && a.key !== key;
    }).map(function (a) {
      return { key: a.key, value: a.value };
    });
    attrs.push({ key: key, value: area });
    var timer;
    var save = new Promise(function (resolve) {
      resolve(cart.props.client.checkout.updateAttributes(id, { customAttributes: attrs }));
    });
    var limit = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error('Shopify did not confirm the area within ' + timeoutMs + 'ms')); }, timeoutMs);
    });
    return Promise.race([save, limit]).then(function (model) {
      clearTimeout(timer);
      if (!model || model.id !== id || !hasAttr(model.customAttributes, key, area)) {
        throw new Error('Shopify did not confirm the area on this cart');
      }
      cart.model = model;
    });
  }

  // One checkout attempt at a time: area first, then Shopify's checkout. While a save is in flight setBusy(true)
  // freezes the area buttons and Checkout, and repeat clicks are swallowed. After the save, cart and area are
  // checked again before the handoff. show(kind) puts a message in the cart: null | 'no-area' | 'changed' | 'failed'.
  function createCheckout(deps) {
    var inFlight = false;
    function blocker(cart) {
      return checkoutBlocker(deps.getArea(), cartSummary(cart && cart.model && cart.model.lineItems));
    }
    return function attempt() {
      var cart = deps.getCart();
      if (deps.guard.failed || !cart) return Promise.resolve('blocked');
      if (inFlight) return Promise.resolve('busy');
      var first = blocker(cart);
      if (first === 'empty') return Promise.resolve('empty');
      if (first === 'no-area') {
        deps.show('no-area');
        return Promise.resolve('no-area');
      }
      var area = deps.getArea();
      inFlight = true;
      deps.setBusy(true);
      deps.show(null);
      return sendArea(cart, area, deps.areaKey, deps.timeoutMs || SAVE_TIMEOUT_MS).then(function () {
        if (deps.guard.failed || deps.getCart() !== cart) return 'blocked';
        if (deps.getArea() !== area) {
          deps.show('changed');
          return 'changed';
        }
        if (blocker(cart) === 'empty') return 'empty';
        cart.onCheckout();
        return 'checkout';
      }).catch(function (err) {
        if (typeof console !== 'undefined') console.error('[ordering]', err);
        if (!deps.guard.failed) deps.show('failed');
        return 'error';
      }).then(function (result) {
        inFlight = false;
        deps.setBusy(false);
        return result;
      });
    };
  }

  var CHECKOUT_SELECTOR = '.shopify-buy__btn--cart-checkout';

  // Document capture-phase click handler: it runs before any Shopify handler and always stops the click,
  // so Shopify's own checkout can only be opened through the checkout attempt, whatever the SDK version binds.
  function checkoutCapture(evt, ctx) {
    if (!evt.target || !evt.target.closest || !evt.target.closest(CHECKOUT_SELECTOR)) return Promise.resolve(null);
    evt.preventDefault();
    evt.stopImmediatePropagation();
    evt.stopPropagation();
    if (ctx.guard.failed) return Promise.resolve('blocked');
    return ctx.attempt();
  }

  var MONEY_FORMAT = '%E2%82%AC%7B%7Bamount_with_comma_separator%7D%7D'; // €{{amount_with_comma_separator}}
  function shopOptions(doc, sync, onArea) {
    var tpl = doc.getElementById('order-area-tpl');
    var events = {};
    events['click [data-area]'] = onArea;
    return {
      productSet: { iframe: false },
      product: {
        iframe: false,
        layout: 'horizontal',
        buttonDestination: 'cart',
        contents: { img: false, title: true, price: true, options: true, quantity: false, button: true, description: false },
        text: { button: 'Add', outOfStock: 'Uitverkocht · Sold out', unavailable: 'Niet beschikbaar · Unavailable' }
      },
      cart: {
        iframe: false,
        popup: false,
        templates: { area: tpl ? tpl.innerHTML : '' },
        contents: { title: true, area: true, lineItems: true, footer: true, note: false, discounts: false },
        order: ['title', 'area', 'lineItems', 'footer'],
        text: { title: 'Your order', total: 'Total', button: 'Checkout', empty: 'Your order is empty.', notice: "We brengen je eten naar je toe · We'll bring your food to you" },
        events: { afterRender: sync },
        DOMEvents: events
      },
      toggle: { iframe: false }
    };
  }

  function buildShop(win, doc, section, cfg, guard) {
    var area = null;
    var cart = null;
    var busy = false;
    // Also re-applied after every Shopify re-render, which rebuilds the cart's buttons.
    function paintArea() {
      var buttons = doc.querySelectorAll('[data-area], ' + CHECKOUT_SELECTOR);
      for (var i = 0; i < buttons.length; i++) {
        var value = buttons[i].getAttribute('data-area');
        if (value) buttons[i].setAttribute('aria-pressed', String(value === area));
        buttons[i].disabled = busy;
        buttons[i].setAttribute('aria-busy', String(busy));
      }
    }
    function show(kind) {
      var msgs = doc.querySelectorAll('.shopify-buy__cart [data-order-msg]');
      for (var i = 0; i < msgs.length; i++) msgs[i].hidden = msgs[i].getAttribute('data-order-msg') !== kind;
    }
    function sync(c) {
      if (guard.failed) return;
      if (c) cart = c;
      paintArea();
      renderBar(doc, cartSummary(cart && cart.model && cart.model.lineItems));
    }
    function onArea(evt, target) {
      if (guard.failed || busy) return;
      var picked = target && target.getAttribute('data-area');
      if (!isArea(picked)) return;
      area = picked;
      paintArea();
      show(null);
    }
    var attempt = createCheckout({
      getCart: function () { return cart; },
      getArea: function () { return area; },
      areaKey: cfg.areaKey,
      show: show,
      setBusy: function (b) { busy = b; paintArea(); },
      guard: guard
    });
    doc.addEventListener('click', function (evt) {
      checkoutCapture(evt, { guard: guard, attempt: attempt });
    }, true);

    var client = win.ShopifyBuy.buildClient({ domain: cfg.domain, storefrontAccessToken: cfg.storefrontAccessToken });
    return win.ShopifyBuy.UI.onReady(client).then(function (ui) {
      if (guard.failed) return;
      return Promise.resolve(ui.createComponent('collection', {
        id: cfg.collectionId,
        node: section.querySelector('[data-order-products]'),
        moneyFormat: MONEY_FORMAT,
        options: shopOptions(doc, sync, onArea)
      })).then(function () {
        return waitForProducts(section, guard);
      }).then(function (count) {
        if (guard.failed) return;
        // stopPropagation: Shopify closes the cart on any click outside it, and this button is outside it.
        doc.getElementById('order-bar-btn').addEventListener('click', function (evt) {
          evt.stopPropagation();
          if (!guard.failed) ui.openCart();
        });
        if (ui.components && ui.components.cart && ui.components.cart[0]) sync(ui.components.cart[0]);
        return count;
      });
    });
  }

  // createComponent returns before Shopify has drawn the products (about 0.4 s later on the demo shop), so wait
  // for them. An empty collection never resolves and ends in the load timeout's fallback.
  function waitForProducts(section, guard, everyMs) {
    return new Promise(function (resolve) {
      (function check() {
        if (guard.failed) return resolve(0);
        var count = section.querySelectorAll('.shopify-buy__product').length;
        if (count) return resolve(count);
        setTimeout(check, everyMs || 100);
      })();
    });
  }

  // Final for this page view: clears anything Shopify rendered and hides the bar.
  function showFallback(doc, section) {
    section.setAttribute('data-state', 'fallback');
    var products = section.querySelector('[data-order-products]');
    if (products) products.innerHTML = '';
    renderBar(doc, { count: 0, total: 0 });
    doc.body.classList.toggle('ordering-failed', true);
  }

  function init(win, doc, deps) {
    deps = deps || {};
    var load = deps.loadScript || function (src) { return loadScript(doc, src); };
    var wait = deps.wait || timeout;
    var build = deps.buildShop || buildShop;

    var section = doc.getElementById('order');
    if (!section) return Promise.resolve('missing');

    var cfg = win.SAUVAGE_SHOPIFY;
    var view = decideView(win.SAUVAGE_ORDERING, win.location.search, cfg);
    if (view === 'hidden') return Promise.resolve('hidden');

    section.hidden = false;
    if (view !== 'load') {
      section.setAttribute('data-state', view);
      return Promise.resolve(view);
    }

    section.setAttribute('data-state', 'loading');
    var guard = { failed: false };
    var shop = load(SDK_URL).then(function () {
      if (guard.failed) throw new Error('Shopify arrived after the timeout; ignored');
      return build(win, doc, section, cfg, guard);
    });

    return Promise.race([shop, wait(LOAD_TIMEOUT_MS)])
      .then(function (count) {
        if (count === 0) throw new Error('The Shopify collection showed no products');
        section.setAttribute('data-state', 'ready');
        if (shouldHidePrices(win, 'ready')) doc.body.classList.toggle('hide-menu-prices', true);
        return 'ready';
      })
      .catch(function (err) {
        guard.failed = true;
        showFallback(doc, section);
        // If the build still finishes later, wipe whatever it rendered again.
        shop.then(function () { showFallback(doc, section); }, function () {});
        if (win.SAUVAGE_ORDERING === 'preview' && win.console) win.console.error('[ordering]', err);
        return 'fallback';
      });
  }

  var AREAS = [
    { value: 'Upstairs', nl: 'Boven' },
    { value: 'Entrance', nl: 'Ingang' },
    { value: 'Outside', nl: 'Buiten' }
  ];

  function isArea(v) {
    return AREAS.some(function (a) { return a.value === v; });
  }

  function checkoutBlocker(area, summary) {
    if (!summary || !summary.count) return 'empty';
    if (!isArea(area)) return 'no-area';
    return null;
  }

  function shouldHidePrices(win, state) {
    return win.SAUVAGE_HIDE_MENU_PRICES === true && state === 'ready';
  }

  var api = {
    SDK_URL: SDK_URL,
    LOAD_TIMEOUT_MS: LOAD_TIMEOUT_MS,
    isConfigured: isConfigured,
    decideView: decideView,
    cartSummary: cartSummary,
    formatSummary: formatSummary,
    renderBar: renderBar,
    init: init,
    AREAS: AREAS,
    isArea: isArea,
    checkoutBlocker: checkoutBlocker,
    shouldHidePrices: shouldHidePrices,
    sendArea: sendArea,
    createCheckout: createCheckout,
    waitForProducts: waitForProducts,
    CHECKOUT_SELECTOR: CHECKOUT_SELECTOR,
    checkoutCapture: checkoutCapture
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SauvageOrdering = api;
    init(root, root.document);
  }
})(this);
