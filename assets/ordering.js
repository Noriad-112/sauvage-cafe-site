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
  var ALLOWED_PRODUCT_GIDS = Object.freeze([
    'gid://shopify/Product/10776275517786', // Arepa
    'gid://shopify/Product/10406885884250', // Granola Bowl
    'gid://shopify/Product/10374553862490', // Chilaquiles
    'gid://shopify/Product/10469224448346', // Breakfast Burrito
    'gid://shopify/Product/10374589415770', // Huevos Rancheros
    'gid://shopify/Product/10374530597210', // Eggs Your Way
  ]);
  var MAX_ALLOWED_PRODUCT_COUNT = ALLOWED_PRODUCT_GIDS.length;
  var ADD_FAILURE_COPY = 'Is een gerecht niet beschikbaar of lukt het toevoegen niet? Bestel dan beneden in de keuken. · If an item is unavailable or won’t add, please order downstairs in the kitchen.';

  // A browser UI guard, using Amsterdam wall time rather than the device's timezone.
  // Unknown/invalid clocks or missing Intl support fail closed. No exception-day policy is implied.
  function kitchenOpen(date, formatter) {
    try {
      if (!(date instanceof Date) || !isFinite(date.getTime())) return false;
      var fmt = formatter || new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Amsterdam', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      });
      var parts = Object.create(null);
      fmt.formatToParts(date).forEach(function (part) {
        if (part.type !== 'literal') {
          if (Object.prototype.hasOwnProperty.call(parts, part.type)) throw new Error('Ambiguous time');
          parts[part.type] = part.value;
        }
      });
      if (!/^(Wed|Thu|Fri|Sat|Sun)$/.test(parts.weekday || '')) return false;
      if (!/^\d{2}$/.test(parts.hour || '') || !/^\d{2}$/.test(parts.minute || '')) return false;
      var hour = Number(parts.hour);
      var minute = Number(parts.minute);
      if (hour > 23 || minute > 59) return false;
      return hour * 60 + minute >= 540 && hour * 60 + minute < 900;
    } catch (_) { return false; }
  }

  function watchHours(win, doc, check) {
    var timer = win.setInterval(function () { check(); }, 1000);
    win.addEventListener('focus', check);
    doc.addEventListener('visibilitychange', check);
    return function () {
      win.clearInterval(timer);
      win.removeEventListener('focus', check);
      doc.removeEventListener('visibilitychange', check);
    };
  }

  function allowedProductModels(models) {
    if (!Array.isArray(models) || models.length < 1 || models.length > MAX_ALLOWED_PRODUCT_COUNT) return false;
    var seen = Object.create(null);
    return models.every(function (model) {
      var id = model && model.id;
      if (ALLOWED_PRODUCT_GIDS.indexOf(id) < 0 || seen[id]) return false;
      seen[id] = true;
      return true;
    });
  }

  function variantQuantity(model, variantId) {
    return ((model && model.lineItems) || []).reduce(function (total, item) {
      return total + (item && item.variant && item.variant.id === variantId ? Number(item.quantity) || 0 : 0);
    }, 0);
  }

  // The inspected CDN maps Cart warnings (including stock warnings) into userErrors.
  function addConfirmed(before, model, variantId, quantity) {
    if (!model || !Array.isArray(model.lineItems)) return false;
    if (['userErrors', 'errors', 'warnings'].some(function (key) {
      return model[key] && (!Array.isArray(model[key]) || model[key].length > 0);
    })) return false;
    return variantQuantity(model, variantId) >= before + quantity;
  }

  // Supported function-valued buttonDestination receives the Product component. Await its cart's
  // addVariantToCart promise; do not infer an Add from afterRender (which also runs on deliberate removal).
  function createProductAdd(deps) {
    return function (product) {
      if (!deps.isOpen()) return Promise.resolve('closed');
      if (deps.guard.failed) return Promise.resolve('blocked');
      if (deps.isBusy()) return Promise.resolve('busy');
      var cart = product && product.cart;
      var variant = product && product.selectedVariant;
      var quantity = Number(product && product.selectedQuantity);
      if (!allowedProductModels([product && product.model]) || !variant || variant.available === false || !isKey(variant.id) ||
          !Number.isInteger(quantity) || quantity < 1 || !cart || typeof cart.addVariantToCart !== 'function') {
        deps.feedback(true);
        return Promise.resolve('failed');
      }
      var before = variantQuantity(cart.model, variant.id);
      deps.setBusy(true);
      return Promise.resolve().then(function () {
        if (!deps.isOpen() || deps.guard.failed) return 'closed';
        return cart.addVariantToCart(variant, quantity).then(function (model) {
          if (!deps.isOpen() || deps.guard.failed) return 'closed';
          var ok = addConfirmed(before, model, variant.id, quantity);
          deps.feedback(!ok);
          deps.sync(cart);
          return ok ? 'added' : 'failed';
        });
      }).catch(function () {
        if (!deps.guard.failed) deps.feedback(true);
        return 'failed';
      }).then(function (result) {
        deps.setBusy(false);
        return result;
      });
    };
  }

  function hasValidProductAllowlist() {
    if (ALLOWED_PRODUCT_GIDS.length !== 6) return false;
    var seen = Object.create(null);
    return ALLOWED_PRODUCT_GIDS.every(function (gid) {
      if (!/^gid:\/\/shopify\/Product\/[0-9]+$/.test(gid) || seen[gid]) return false;
      seen[gid] = true;
      return true;
    });
  }

  function isKey(v) {
    return typeof v === 'string' && v.trim() !== '';
  }

  // areaKey is the cart attribute that carries the seating area, frozen with Ronin. Without it the shop counts as
  // not configured, so it never shows a cart that can't check out.
  function isConfigured(cfg) {
    return hasValidProductAllowlist() && !!cfg && ['domain', 'storefrontAccessToken', 'areaKey'].every(function (k) {
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
    return '€' + (Math.round(n * 100) / 100).toFixed(2).replace('.', ',');
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
      if (deps.isOpen && !deps.isOpen()) return Promise.resolve('closed');
      var cart = deps.getCart();
      if (deps.guard.failed || !cart) return Promise.resolve('blocked');
      if (inFlight) return Promise.resolve('busy');
      if (deps.isBusy && deps.isBusy()) return Promise.resolve('busy');
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
        if (deps.isOpen && !deps.isOpen()) return 'closed';
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
  function shopOptions(doc, sync, onArea, onAdd) {
    var tpl = doc.getElementById('order-area-tpl');
    var events = {};
    events['click [data-area]'] = onArea;
    return {
      productSet: {
        iframe: false,
        contents: { products: true, pagination: false },
        events: { afterInit: function (component) {
          if (!allowedProductModels(component.model && component.model.products)) {
            throw new Error('Unexpected Shopify product identity');
          }
        } }
      },
      product: {
        iframe: false,
        layout: 'horizontal',
        buttonDestination: onAdd,
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

  function productSetSpec(doc, node, sync, onArea, onAdd) {
    return {
      // Full GIDs must use storefrontId. The SDK adds its own GID prefix to id.
      storefrontId: ALLOWED_PRODUCT_GIDS.slice(),
      node: node,
      moneyFormat: MONEY_FORMAT,
      options: shopOptions(doc, sync, onArea, onAdd)
    };
  }

  function buildShop(win, doc, section, cfg, guard, isOpen) {
    var area = null;
    var cart = null;
    var busy = false;
    var addFailed = false;
    function feedback(failed) {
      addFailed = failed;
      var messages = doc.querySelectorAll('[data-order-add-error]');
      for (var i = 0; i < messages.length; i++) {
        messages[i].textContent = ADD_FAILURE_COPY;
        messages[i].hidden = !failed;
      }
    }
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
      feedback(addFailed);
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
      isBusy: function () { return busy; },
      isOpen: isOpen,
      guard: guard
    });
    var onAdd = createProductAdd({
      isOpen: isOpen,
      guard: guard,
      isBusy: function () { return busy; },
      setBusy: function (b) { busy = b; paintArea(); },
      feedback: feedback,
      sync: sync
    });
    doc.addEventListener('click', function (evt) {
      checkoutCapture(evt, { guard: guard, attempt: attempt });
    }, true);

    var client = win.ShopifyBuy.buildClient({ domain: cfg.domain, storefrontAccessToken: cfg.storefrontAccessToken });
    return win.ShopifyBuy.UI.onReady(client).then(function (ui) {
      // onReady can resume after closing while a background-tab hours timer is throttled.
      if (!isOpen() || guard.failed) return;
      return Promise.resolve(ui.createComponent('productSet', productSetSpec(
        doc,
        section.querySelector('[data-order-products]'),
        sync,
        onArea,
        onAdd
      ))).then(function () {
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
  // for at least one and no more than the six explicitly allowlisted products. A missing/unpublished GID can
  // leave a valid smaller menu; zero or expanded results stay in loading and reach the existing timeout fallback.
  function waitForProducts(section, guard, everyMs) {
    return new Promise(function (resolve) {
      (function check() {
        if (guard.failed) return resolve(0);
        var count = section.querySelectorAll('.shopify-buy__product').length;
        if (count > 0 && count <= MAX_ALLOWED_PRODUCT_COUNT) return resolve(count);
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

  // Preserve the cart model; hide this page's ordering UI without issuing a cleanup mutation.
  function showClosed(doc, section) {
    section.setAttribute('data-state', 'closed');
    renderBar(doc, { count: 0, total: 0 });
    doc.body.classList.toggle('hide-menu-prices', false);
    doc.body.classList.toggle('ordering-closed', true);
  }

  function init(win, doc, deps) {
    deps = deps || {};
    var load = deps.loadScript || function (src) { return loadScript(doc, src); };
    var wait = deps.wait || timeout;
    var build = deps.buildShop || buildShop;
    var now = deps.now || function () { return new Date(); };

    var addHelpNodes = doc.querySelectorAll && doc.querySelectorAll('[data-order-add-help]');
    if (addHelpNodes) {
      for (var i = 0; i < addHelpNodes.length; i++) addHelpNodes[i].textContent = ADD_FAILURE_COPY;
    }

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

    var template = doc.getElementById('order-area-tpl');
    if (!addHelpNodes || !addHelpNodes.length || !template ||
        !/data-order-add-error(?:\s|=|>)/.test(template.innerHTML) || !doc.getElementById('order-hours-message')) {
      showFallback(doc, section);
      return Promise.resolve('fallback');
    }

    var guard = { failed: false, closed: false };
    var stopWatch = function () {};
    var closeSignal;
    var closed = new Promise(function (resolve) { closeSignal = resolve; });
    function isOpen() {
      if (guard.closed) return false;
      var open = false;
      try { open = kitchenOpen(now()); } catch (_) { /* A clock failure is closed. */ }
      if (open) return true;
      guard.closed = true;
      guard.failed = true;
      stopWatch();
      showClosed(doc, section);
      closeSignal(0);
      return false;
    }
    if (!isOpen()) return Promise.resolve('closed');
    stopWatch = (deps.watchHours || function (check) { return watchHours(win, doc, check); })(isOpen);
    section.setAttribute('data-state', 'loading');
    var shop = load(SDK_URL).then(function () {
      if (!isOpen()) throw new Error('Kitchen ordering is closed');
      if (guard.failed) throw new Error('Shopify arrived after the timeout; ignored');
      return build(win, doc, section, cfg, guard, isOpen);
    });

    return Promise.race([shop, wait(LOAD_TIMEOUT_MS), closed])
      .then(function (count) {
        if (!isOpen()) return 'closed';
        if (!Number.isInteger(count) || count < 1 || count > MAX_ALLOWED_PRODUCT_COUNT) throw new Error('The Shopify menu did not show an allowed product set');
        section.setAttribute('data-state', 'ready');
        if (shouldHidePrices(win, 'ready')) doc.body.classList.toggle('hide-menu-prices', true);
        return 'ready';
      })
      .catch(function (err) {
        stopWatch();
        guard.failed = true;
        if (guard.closed) showClosed(doc, section);
        else showFallback(doc, section);
        // If the build still finishes later, wipe whatever it rendered again.
        shop.then(function () {
          if (guard.closed) showClosed(doc, section);
          else showFallback(doc, section);
        }, function () {});
        if (win.SAUVAGE_ORDERING === 'preview' && win.console) win.console.error('[ordering]', err);
        return guard.closed ? 'closed' : 'fallback';
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
    ALLOWED_PRODUCT_GIDS: ALLOWED_PRODUCT_GIDS,
    MAX_ALLOWED_PRODUCT_COUNT: MAX_ALLOWED_PRODUCT_COUNT,
    ADD_FAILURE_COPY: ADD_FAILURE_COPY,
    hasValidProductAllowlist: hasValidProductAllowlist,
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
    shopOptions: shopOptions,
    productSetSpec: productSetSpec,
    kitchenOpen: kitchenOpen,
    watchHours: watchHours,
    allowedProductModels: allowedProductModels,
    addConfirmed: addConfirmed,
    createProductAdd: createProductAdd,
    buildShop: buildShop,
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
