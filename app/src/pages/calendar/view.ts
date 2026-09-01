/**
 * Which view the calendar opens in, remembered per device.
 *
 * A 7-column grid on a 360 px phone gives each day about 45 px — enough for a number
 * and two dots, and not enough to read a trip's name. So there is a list, and the
 * choice between the two is a preference rather than a breakpoint: somebody who
 * prefers the list on a desktop should get the list on a desktop.
 *
 * The default is the grid. `localStorage` is wrapped because it throws outright in a
 * Safari private window, and a calendar that will not render because it could not
 * remember a toggle is a worse calendar than one that forgets.
 */

export type CalendarView = 'grid' | 'list'

export const VIEW_STORAGE_KEY = 'twm.calendar.view'

export const DEFAULT_VIEW: CalendarView = 'grid'

export function readView(): CalendarView {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : DEFAULT_VIEW
  } catch {
    return DEFAULT_VIEW
  }
}

export function writeView(view: CalendarView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view)
  } catch {
    // Storage is unavailable; the toggle still works, it just will not be remembered.
  }
}
