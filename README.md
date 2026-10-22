# sauvage-cafe-site
Sauvage Cafe website

## QR food ordering

Guests scan the café QR code, which opens the homepage, order food, pick where they're sitting (Upstairs, Entrance or Outside), and pay on Shopify checkout. The food is brought to them. Products, prices, cart and checkout are Shopify's (Buy Button); staff see paid orders, with the area, in Shopify Admin.

- **Switch:** `window.SAUVAGE_ORDERING` in `index.html`: `"off"` (hidden), `"preview"` (only at `/?preview=order`), `"on"` (everyone).
- **Config:** `window.SAUVAGE_SHOPIFY`. Keep it **empty in the repo**. Every branch gets a public Cloudflare preview, so real values there could take real orders. Never put Admin or private keys here.
- **Seating area:** sent as one cart attribute named by `areaKey` (proposed: `Area`), value `Upstairs`, `Entrance` or `Outside`. Other cart attributes are kept. Checkout opens only after Shopify returns the same cart with that attribute; otherwise the guest sees an error and can try again. While `areaKey` is empty, ordering counts as not configured. Ronin freezes the exact key and checks it shows on the staff order view.
- **Menu prices:** `window.SAUVAGE_HIDE_MENU_PRICES = true` hides the static food prices, but only when the Shopify list has loaded. Set it only after the live food list is confirmed.
- **Rollback:** in Cloudflare Pages → `sauvage-cafe-site` → Deployments, click **Rollback** on the last good deployment. Switching to `"off"` in a new PR also hides the feature, but it isn't the emergency route.
- **If Shopify fails or takes more than 8 seconds,** guests see "Table ordering is paused for a moment. Please order downstairs in the kitchen." (Dorian's final text, 22 Oct 2026). A late Shopify script never revives the cart.
- **Privacy:** while ordering is shown, the Shopify Buy Button sends usage analytics to Shopify.
- **Code:** `assets/ordering.js`. Tests: `node --test` (Node 18+, no install needed).
