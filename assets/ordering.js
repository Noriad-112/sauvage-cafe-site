/*
 * Sauvage Cafe: QR table ordering via the Shopify Buy Button. Food is brought to the guest.
 * Switch (window.SAUVAGE_ORDERING), Shopify config (window.SAUVAGE_SHOPIFY) and
 * window.SAUVAGE_HIDE_MENU_PRICES live in index.html. Also loads in Node for tests.
 */
(function (root) {
  'use strict';

  var SDK_URL = 'https://sdks.shopifycdn.com/buy-button/latest/buy-button-storefront.min.js';
  var LOAD_TIMEOUT_MS = 8000;

  function isConfigured(cfg) {
    return !!cfg && ['domain', 'storefrontAccessToken', 'collectionId'].every(function (k) {
      return typeof cfg[k] === 'string' && cfg[k].trim() !== '';
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

  function buildShop() {
    return Promise.reject(new Error('buildShop not implemented'));
  }

  // Final for this page view: clears anything Shopify rendered and hides the bar.
  function showFallback(doc, section) {
    section.setAttribute('data-state', 'fallback');
    var products = section.querySelector('[data-order-products]');
    if (products) products.innerHTML = '';
    renderBar(doc, { count: 0, total: 0 });
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
      .then(function () {
        section.setAttribute('data-state', 'ready');
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

  var api = {
    SDK_URL: SDK_URL,
    LOAD_TIMEOUT_MS: LOAD_TIMEOUT_MS,
    isConfigured: isConfigured,
    decideView: decideView,
    cartSummary: cartSummary,
    formatSummary: formatSummary,
    renderBar: renderBar,
    init: init
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SauvageOrdering = api;
    init(root, root.document);
  }
})(this);
