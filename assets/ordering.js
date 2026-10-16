/*
 * Sauvage Cafe: QR table ordering via the Shopify Buy Button. Food is brought to the guest.
 * Switch (window.SAUVAGE_ORDERING), Shopify config (window.SAUVAGE_SHOPIFY) and
 * window.SAUVAGE_HIDE_MENU_PRICES live in index.html. Also loads in Node for tests.
 */
(function (root) {
  'use strict';

  var SDK_URL = 'https://sdks.shopifycdn.com/buy-button/latest/buy-button-storefront.min.js';
  var LOAD_TIMEOUT_MS = 8000;

  var AREA_TRANSPORTS = ['attribute', 'note'];

  // A shop without an agreed area transport counts as not configured: it never shows a cart that can't check out.
  function isConfigured(cfg) {
    return !!cfg && ['domain', 'storefrontAccessToken', 'collectionId'].every(function (k) {
      return typeof cfg[k] === 'string' && cfg[k].trim() !== '';
    }) && AREA_TRANSPORTS.indexOf(cfg.areaTransport) !== -1;
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

  // How the seating area travels inside the Shopify order. Chosen with Ronin via SAUVAGE_SHOPIFY.areaTransport;
  // anything else rejects, so checkout stays blocked rather than sending an order without an area.
  function sendArea(cart, area, transport) {
    if (!isArea(area)) return Promise.reject(new Error('Unknown area: ' + area));
    var input;
    if (transport === 'attribute') input = { customAttributes: [{ key: 'Area', value: area }] };
    else if (transport === 'note') input = { note: 'Area: ' + area };
    else return Promise.reject(new Error('No area transport configured: ' + transport));
    return cart.props.client.checkout.updateAttributes(cart.model.id, input).then(function (model) {
      if (model) cart.model = model;
    });
  }

  // Area first, then Shopify's checkout. show(kind) puts a message in the cart: null | 'no-area' | 'failed'.
  function checkoutFlow(cart, area, transport, show) {
    var blocker = checkoutBlocker(area, cartSummary(cart.model && cart.model.lineItems));
    if (blocker === 'empty') return Promise.resolve('empty');
    if (blocker === 'no-area') {
      show('no-area');
      return Promise.resolve('no-area');
    }
    show(null);
    return sendArea(cart, area, transport).then(function () {
      cart.onCheckout();
      return 'checkout';
    }, function (err) {
      if (typeof console !== 'undefined') console.error('[ordering]', err);
      show('failed');
      return 'error';
    });
  }

  var CHECKOUT_SELECTOR = '.shopify-buy__btn--cart-checkout';

  // Document capture-phase click handler: it runs before any Shopify handler and always stops the click,
  // so Shopify's own checkout can only be opened through checkoutFlow, whatever the SDK version binds.
  function checkoutCapture(evt, ctx) {
    if (!evt.target || !evt.target.closest || !evt.target.closest(CHECKOUT_SELECTOR)) return Promise.resolve(null);
    evt.preventDefault();
    evt.stopImmediatePropagation();
    evt.stopPropagation();
    if (ctx.guard.failed || !ctx.cart) return Promise.resolve('blocked');
    return checkoutFlow(ctx.cart, ctx.area, ctx.transport, ctx.show);
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
    function paintArea() {
      var buttons = doc.querySelectorAll('[data-area]');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-area') === area));
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
      if (guard.failed) return;
      var picked = target && target.getAttribute('data-area');
      if (!isArea(picked)) return;
      area = picked;
      paintArea();
      show(null);
    }
    doc.addEventListener('click', function (evt) {
      checkoutCapture(evt, { cart: cart, area: area, transport: cfg.areaTransport, guard: guard, show: show });
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
        if (guard.failed) return;
        var count = section.querySelectorAll('.shopify-buy__product').length;
        if (!count) throw new Error('The Shopify collection showed no products');
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
    checkoutFlow: checkoutFlow,
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
