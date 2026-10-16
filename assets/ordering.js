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

  var api = {
    SDK_URL: SDK_URL,
    LOAD_TIMEOUT_MS: LOAD_TIMEOUT_MS,
    isConfigured: isConfigured,
    decideView: decideView,
    cartSummary: cartSummary,
    formatSummary: formatSummary
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SauvageOrdering = api;
  }
})(this);
