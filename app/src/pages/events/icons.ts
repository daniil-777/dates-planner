/**
 * Every SAP icon the Events pages name, registered once.
 *
 * `@ui5/webcomponents-icons` is tree-shaken per icon: an unregistered name renders as an
 * empty box and logs a warning on every paint, so the page imports what it draws rather
 * than pulling in the whole collection.
 */

// Page chrome.
import '@ui5/webcomponents-icons/dist/add.js'
import '@ui5/webcomponents-icons/dist/add-photo.js'
import '@ui5/webcomponents-icons/dist/calendar.js'
import '@ui5/webcomponents-icons/dist/delete.js'
import '@ui5/webcomponents-icons/dist/edit.js'
import '@ui5/webcomponents-icons/dist/hint.js'
import '@ui5/webcomponents-icons/dist/map-3.js'
import '@ui5/webcomponents-icons/dist/nav-back.js'

// Photographs (CONTRACTS.md §11.1) — the gallery, and the lightbox's own controls.
import '@ui5/webcomponents-icons/dist/camera.js'
import '@ui5/webcomponents-icons/dist/decline.js'
import '@ui5/webcomponents-icons/dist/navigation-left-arrow.js'
import '@ui5/webcomponents-icons/dist/navigation-right-arrow.js'
import '@ui5/webcomponents-icons/dist/write-new.js'

// Surprises (CONTRACTS.md §11.3): `hide` badges one, `show` reveals it.
import '@ui5/webcomponents-icons/dist/hide.js'
import '@ui5/webcomponents-icons/dist/show.js'

// Category icons from db/data/twowaymatch-Categories.csv, after `resolveIcon` aliasing —
// the postings list on an event detail draws whichever of them turns up.
import '@ui5/webcomponents-icons/dist/cart.js'
import '@ui5/webcomponents-icons/dist/meal.js'
import '@ui5/webcomponents-icons/dist/nutrition-activity.js'
import '@ui5/webcomponents-icons/dist/bus-public-transport.js'
import '@ui5/webcomponents-icons/dist/flight.js'
import '@ui5/webcomponents-icons/dist/present.js'
import '@ui5/webcomponents-icons/dist/home.js'
import '@ui5/webcomponents-icons/dist/electrocardiogram.js'
import '@ui5/webcomponents-icons/dist/video.js'
import '@ui5/webcomponents-icons/dist/refresh.js'
import '@ui5/webcomponents-icons/dist/receipt.js'
