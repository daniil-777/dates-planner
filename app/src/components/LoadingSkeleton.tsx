export interface LoadingSkeletonProps {
  /** How many placeholder rows to draw. Match it to what the list usually holds. */
  rows?: number
  /** `list` for line items, `card` for tiles, `text` for a block of prose. */
  variant?: 'list' | 'card' | 'text'
  className?: string
}

/**
 * The shape of the answer, before the answer arrives.
 *
 * A skeleton rather than a spinner because every list in this app has a known shape, and
 * showing that shape keeps the layout from jumping when the data lands. `aria-busy` and the
 * visually-hidden label mean a screen reader hears "Loading" instead of a wall of nothing.
 */
export function LoadingSkeleton({ rows = 3, variant = 'list', className }: LoadingSkeletonProps) {
  const count = Math.max(1, Math.min(Math.floor(rows), 24))
  const classes = ['twm-skeleton', `twm-skeleton--${variant}`]
  if (className) classes.push(className)

  return (
    <div
      className={classes.join(' ')}
      aria-busy="true"
      aria-live="polite"
      data-testid="loading-skeleton"
    >
      <span className="twm-visually-hidden">Loading</span>
      {Array.from({ length: count }, (_unused, index) => (
        <div className="twm-skeleton__row" key={index}>
          <span className="twm-skeleton__block twm-skeleton__block--lead" />
          <span className="twm-skeleton__lines">
            <span className="twm-skeleton__block twm-skeleton__block--title" />
            <span className="twm-skeleton__block twm-skeleton__block--sub" />
          </span>
          <span className="twm-skeleton__block twm-skeleton__block--trail" />
        </div>
      ))}
    </div>
  )
}

export default LoadingSkeleton
