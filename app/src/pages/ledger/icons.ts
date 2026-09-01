/**
 * Runtime icon registration for the Ledger.
 *
 * `main.tsx` registers the whole SAP-icons collection lazily; these side-effect imports
 * make the handful this page draws available synchronously (and in unit tests, which do
 * not load `main.tsx`). Names are resolved through `resolveIcon` in `@/theme`, which owns
 * the aliases for the four CSV icon names the collection does not ship.
 */

// Category icons from db/data/twowaymatch-Categories.csv, after aliasing.
import '@ui5/webcomponents-icons/dist/cart.js'
import '@ui5/webcomponents-icons/dist/meal.js'
import '@ui5/webcomponents-icons/dist/nutrition-activity.js'
import '@ui5/webcomponents-icons/dist/bus-public-transport.js'
import '@ui5/webcomponents-icons/dist/flight.js'
import '@ui5/webcomponents-icons/dist/present.js'
import '@ui5/webcomponents-icons/dist/home.js'
import '@ui5/webcomponents-icons/dist/heart.js'
import '@ui5/webcomponents-icons/dist/video.js'
import '@ui5/webcomponents-icons/dist/synchronize.js'
import '@ui5/webcomponents-icons/dist/receipt.js'

// Ledger chrome.
import '@ui5/webcomponents-icons/dist/slim-arrow-left.js'
import '@ui5/webcomponents-icons/dist/slim-arrow-right.js'
import '@ui5/webcomponents-icons/dist/money-bills.js'
import '@ui5/webcomponents-icons/dist/payment-approval.js'
import '@ui5/webcomponents-icons/dist/filter.js'
import '@ui5/webcomponents-icons/dist/delete.js'
import '@ui5/webcomponents-icons/dist/edit.js'
import '@ui5/webcomponents-icons/dist/share.js'
import '@ui5/webcomponents-icons/dist/accept.js'
import '@ui5/webcomponents-icons/dist/sys-enter-2.js'
