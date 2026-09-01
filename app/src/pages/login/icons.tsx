/**
 * The four glyphs the login card needs, inlined.
 *
 * The SAP icon font is loaded by `main.tsx` for the app — but the login screen can be the
 * very first paint, so it draws its own strokes rather than waiting for a font. They are
 * `currentColor` throughout, which is what lets the same markup sit on a light card, a dark
 * card and inside the red error box without a second definition.
 */
interface GlyphProps {
  size?: number
}

/** Shown on the toggle while the password is hidden: "reveal it". */
export function EyeIcon({ size = 20 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  )
}

/** Shown while the password is visible: "hide it again". */
export function EyeOffIcon({ size = 20 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 4l16 16" />
      <path d="M9.6 6.1A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17.7 17.7 0 0 1-3.6 4.3" />
      <path d="M6.2 8A17.6 17.6 0 0 0 2 12s3.6 6.5 10 6.5c1.2 0 2.3-.2 3.3-.6" />
      <path d="M10.1 10.2a2.8 2.8 0 0 0 3.8 3.9" />
    </svg>
  )
}

/** The 7-day session note. */
export function ShieldIcon({ size = 14 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2.8 20 6v6c0 4.4-3.3 7.9-8 9.2C7.3 19.9 4 16.4 4 12V6l8-3.2Z" />
      <path d="M9 12.2 11.2 14.4 15.4 10" />
    </svg>
  )
}

/** The inline error. */
export function AlertIcon({ size = 16 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.2" />
      <path d="M12 16.4h.01" />
    </svg>
  )
}
