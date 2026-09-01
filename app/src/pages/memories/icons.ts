/**
 * Icon registration.
 *
 * SAP icons are loaded per name at runtime; a name that was never imported
 * renders as an empty square. Collecting the whole Memories set in one module
 * keeps that failure mode impossible — every icon this feature can show is
 * registered the moment the page module is evaluated.
 */

import '@ui5/webcomponents-icons/dist/accept.js'
import '@ui5/webcomponents-icons/dist/add-photo.js'
import '@ui5/webcomponents-icons/dist/add.js'
import '@ui5/webcomponents-icons/dist/appointment.js'
import '@ui5/webcomponents-icons/dist/bell.js'
import '@ui5/webcomponents-icons/dist/decline.js'
import '@ui5/webcomponents-icons/dist/delete.js'
import '@ui5/webcomponents-icons/dist/edit.js'
import '@ui5/webcomponents-icons/dist/favorite.js'
import '@ui5/webcomponents-icons/dist/flight.js'
import '@ui5/webcomponents-icons/dist/heart.js'
import '@ui5/webcomponents-icons/dist/history.js'
import '@ui5/webcomponents-icons/dist/journey-arrive.js'
import '@ui5/webcomponents-icons/dist/list.js'
import '@ui5/webcomponents-icons/dist/locate-me.js'
import '@ui5/webcomponents-icons/dist/map-3.js'
import '@ui5/webcomponents-icons/dist/present.js'
import '@ui5/webcomponents-icons/dist/pushpin-off.js'
import '@ui5/webcomponents-icons/dist/pushpin-on.js'
import '@ui5/webcomponents-icons/dist/write-new.js'
