/**
 * The product's own mark, inlined.
 *
 * These are the two tick paths of `app/public/favicon.svg`, byte-identical in geometry —
 * the magenta one behind, the Horizon-blue one in front, half a stroke apart: two people,
 * two postings, one match. The plate the favicon draws behind them is dropped, because on
 * the login card the ticks sit on the card itself and a white rectangle would look like a
 * hole punched in the dark theme.
 *
 * It is inlined rather than fetched so the first screen never waits on a network round trip
 * (and still renders offline, which is the whole point of a PWA shell).
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="72 118 368 300"
      role="img"
      aria-label="Two-Way Match"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={54}
    >
      <path d="M104 268 L196 356 L376 152" stroke="#F31DED" opacity="0.55" />
      <path d="M136 300 L228 388 L408 184" stroke="#0070F2" />
    </svg>
  )
}

export default BrandMark
