import type { CSSProperties } from 'react'
import { DEFAULT_CURRENCY, formatMoney } from '../theme'

export interface MoneyTextProps {
  amount: number
  currency?: string
  bold?: boolean
  /**
   * `signed` tints the value: green when it is a credit, red when it is a debt. Left
   * `neutral` by default, because most amounts in the ledger are simply amounts.
   */
  tone?: 'neutral' | 'signed' | 'subtle'
  /** Larger type for the one number a screen is actually about. */
  size?: 'S' | 'M' | 'L'
  className?: string
  style?: CSSProperties
}

const SIZE_CLASS: Record<'S' | 'M' | 'L', string> = {
  S: 'twm-money--s',
  M: '',
  L: 'twm-money--l',
}

/**
 * The only sanctioned way to put money on screen.
 *
 * Swiss format, tabular figures so columns of amounts line up, and the sign kept in front
 * of the currency exactly as the backend's statement renderer writes it. `formatMoney` in
 * `theme.ts` is the single implementation; this component only decides how it looks.
 */
export function MoneyText({
  amount,
  currency = DEFAULT_CURRENCY,
  bold = false,
  tone = 'neutral',
  size = 'M',
  className,
  style,
}: MoneyTextProps) {
  const classes = ['twm-money']
  if (bold) classes.push('twm-money--bold')
  if (tone === 'signed') classes.push(amount < 0 ? 'twm-money--negative' : 'twm-money--positive')
  if (tone === 'subtle') classes.push('twm-money--subtle')
  const sizeClass = SIZE_CLASS[size]
  if (sizeClass) classes.push(sizeClass)
  if (className) classes.push(className)

  return (
    <span className={classes.join(' ')} style={style} data-testid="money">
      {formatMoney(amount, currency)}
    </span>
  )
}

export default MoneyText
