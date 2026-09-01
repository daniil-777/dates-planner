import { isRecord, type LlmProvider, type LlmRequest, type StatementFacts } from './types'

/**
 * The deterministic "Statement of Us" writer — last in the selection order and
 * the reason the feature works with no credentials at all.
 *
 * It is not a stub. Given the same facts it always produces the same markdown,
 * it never throws, and it is written to be read out loud: prose first, one small
 * table as a garnish, and the six sections the product asks for.
 */

/** Display names per CONTRACTS.md §1.1 — the stored codes stay ASCII. */
const CATEGORY_LABELS: Record<string, string> = {
  Groceries: 'Groceries',
  Dining: 'Dining',
  Cafes: 'Cafés',
  Transport: 'Transport',
  Travel: 'Travel',
  Gifts: 'Gifts',
  Home: 'Home',
  Health: 'Health',
  Entertainment: 'Entertainment',
  Subscriptions: 'Subscriptions',
}

/** One line of commentary per cost centre, so the overview reads, not tabulates. */
const CATEGORY_NOTES: Record<string, string> = {
  Groceries:
    'the unglamorous backbone of the operation, and the source of most of our best evenings',
  Dining: 'our largest discretionary line and the one with the least buyer’s remorse',
  Cafes: 'small tickets, high frequency — the most loyal recurring charge in the portfolio',
  Transport: 'the cost of getting to each other, which we have never once disputed',
  Travel: 'capital expenditure on memories, depreciated over a lifetime',
  Gifts: 'no measurable ROI, the highest satisfaction score in the book',
  Home: 'investment in the joint venture’s physical premises',
  Health: 'preventive maintenance on the only assets that matter',
  Entertainment: 'content acquisition, mostly consumed on the same sofa',
  Subscriptions: 'recurring revenue, unfortunately for other people',
}

const MOMENT_LABELS: Record<string, string> = {
  everyday: 'everyday life',
  date_night: 'date nights',
  trip: 'trips',
  gift: 'gifts',
}

const QUARTER_PERIODS: Record<number, string> = {
  1: 'January to March',
  2: 'April to June',
  3: 'July to September',
  4: 'October to December',
}

/** Used when a quarter carries no highlight; indexed by quarter, never random. */
const QUARTER_FALLBACKS: Record<number, string> = {
  1: 'a quiet opening quarter, spent mostly indoors and mostly together.',
  2: 'the weather improved and so did our willingness to leave the flat.',
  3: 'peak season for the joint venture: long evenings, short receipts.',
  4: 'the close of the year, conducted largely under a blanket.',
}

const OPENERS = [
  'The books for {fy} are closed. Everything reconciles — more or less — and so do we.',
  'We are pleased to present the Statement of Us for {fy}, prepared on the going-concern basis, because we are very much going.',
  'For {fy} we report steady, unspectacular, thoroughly enjoyable growth across a portfolio nobody outside the household is allowed to audit.',
  'The results for {fy} are in. Management has reviewed them, approved them, and is not taking questions.',
]

const OUTLOOK_RISKS = [
  'The principal risk to this outlook is that we keep doing all of it on purpose.',
  'The only downside risk identified is the calendar, and we intend to manage it aggressively.',
  'No material risks were identified. One immaterial risk — that we book the good table too late — remains under review.',
  'Risk appetite: moderate on spreadsheets, unlimited elsewhere.',
]

export function createTemplateProvider(): LlmProvider {
  return {
    name: 'template',
    async generate(req: LlmRequest): Promise<string> {
      const facts = extractFacts(req.prompt)
      return facts === null ? renderMinimalStatement() : renderStatementFromFacts(facts)
    },
  }
}

/**
 * Renders the full statement. Exported separately from the provider so that
 * `srv/lib/statement.ts` can call it directly for `renderTemplateStatement()`
 * without pretending to be an LLM request.
 */
export function renderStatementFromFacts(facts: StatementFacts): string {
  const f = normaliseFacts(facts)
  const seed = seedOf(f)
  const blocks = [
    header(f),
    section('Executive Summary', executiveSummary(f, seed)),
    section('Key Achievements', keyAchievements(f)),
    section('Investment Overview', investmentOverview(f)),
    section('Highlights by Quarter', highlightsByQuarter(f)),
    section('Outlook', outlook(f, seed)),
    section('Closing note', closingNote(f)),
    footer(),
  ]
  return `${blocks.join('\n\n')}\n`
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function header(f: StatementFacts): string {
  const title = f.year > 0 ? `Statement of Us — FY${f.year}` : 'Statement of Us'
  const period = f.year > 0 ? `1 January – 31 December ${f.year}` : 'the year under review'
  return [
    `# ${title}`,
    '',
    `**Reporting entity** · ${reportingEntity(f)}  `,
    `**Reporting period** · ${period}  `,
    `**Functional currency** · ${f.currency}  `,
    `**Basis of preparation** · every receipt we remembered to photograph  `,
    '**Auditor’s opinion** · unqualified, affectionate',
    '',
    '---',
  ].join('\n')
}

function executiveSummary(f: StatementFacts, seed: number): string {
  const opener = pick(OPENERS, seed, 0).replace('{fy}', f.year > 0 ? `FY${f.year}` : 'the period')
  const paragraphs: string[] = []

  if (f.counts.expenses === 0) {
    paragraphs.push(
      `${opener} The ledger for this period is empty, which we are choosing to read as evidence of a year lived entirely off the books.`,
    )
    paragraphs.push(
      `${headcountSentence(f)} No transactions were posted, no positions were reconciled, and nothing at all went wrong.`,
    )
    return paragraphs.join('\n\n')
  }

  const merchantCount = f.topMerchants.length
  const categoryCount = Object.keys(f.totals.byCategory).length
  paragraphs.push(
    `${opener} Total shared investment for the period came to **${money(f.totals.overall, f.currency)}** across ` +
      `${plural(f.counts.expenses, 'posting', 'postings')}` +
      (categoryCount > 0 ? ` and ${plural(categoryCount, 'cost centre', 'cost centres')}` : '') +
      `. ${headcountSentence(f)} No reorganisation was proposed, and none was required.`,
  )

  const contributions = contributionSentence(f, 'summary')
  if (contributions !== null) paragraphs.push(contributions)

  const activity = activitySentence(f)
  if (activity !== null) paragraphs.push(activity)

  if (merchantCount > 0) {
    const top = f.topMerchants[0]
    paragraphs.push(
      `Our single largest counterparty was **${top.merchant}**, which received ${money(top.total, f.currency)} across ` +
        `${plural(top.visits, 'visit', 'visits')}. We have no plans to renegotiate.`,
    )
  }

  return paragraphs.join('\n\n')
}

function keyAchievements(f: StatementFacts): string {
  const bullets: string[] = []

  if (f.counts.dateNights > 0) {
    const spend = f.totals.byMoment['date_night']
    const perNight =
      typeof spend === 'number' && spend > 0 && f.counts.dateNights > 1
        ? `, at an average of ${money(spend / f.counts.dateNights, f.currency)} each, which is a bargain by any valuation method`
        : ''
    bullets.push(
      `**${plural(f.counts.dateNights, 'date night', 'date nights')} delivered**, on time and in full${perNight}.`,
    )
  }

  if (f.longestDateNightStreakWeeks >= 2) {
    bullets.push(
      `**${indefiniteArticle(f.longestDateNightStreakWeeks)} ${f.longestDateNightStreakWeeks}-week unbroken run of date nights.** ` +
        'Our longest sustained delivery streak of the year: ' +
        'no week skipped, no retrospective needed.',
    )
  }

  if (f.counts.trips > 0) {
    // The places are named in the Executive Summary, which always runs when
    // there is a trip to report; listing them again here reads as a copy-paste.
    const overBudget =
      f.counts.trips === 1
        ? 'It was over budget in the ways that count.'
        : 'Every one of them over budget in the ways that count.'
    bullets.push(`**${plural(f.counts.trips, 'trip', 'trips')} completed.** ${overBudget}`)
  }

  if (f.counts.gifts > 0) {
    bullets.push(
      `**${plural(f.counts.gifts, 'gift', 'gifts')} exchanged.** No measurable return, the highest satisfaction ` +
        'score in the book, and no record kept of who carried the bag home.',
    )
  }

  const topEvent = f.events[0]
  if (topEvent !== undefined) {
    bullets.push(
      `**${topEvent.name} came to ${money(topEvent.total, f.currency)}**, booked against ` +
        `${plural(topEvent.participantCount, 'person', 'people')}${perHeadNote(topEvent, f.currency)}. ` +
        'Filed under the best money we spent all year.',
    )
  }

  const topCategory = rankedEntries(f.totals.byCategory)[0]
  if (topCategory !== undefined) {
    bullets.push(
      `**${categoryLabel(topCategory.key)} led the portfolio** at ${money(topCategory.value, f.currency)}` +
        `${share(topCategory.value, f.totals.overall)} — ${categoryNote(topCategory.key)}.`,
    )
  }

  const loyal = f.topMerchants.find(m => m.visits >= 3)
  if (loyal !== undefined) {
    bullets.push(
      `**${loyal.merchant} saw us ${plural(loyal.visits, 'time', 'times')}.** At this point they are less a vendor and ` +
        'more a strategic partner.',
    )
  }

  const bookends = bookendSentence(f)
  if (bookends !== null) bullets.push(bookends)

  if (bullets.length === 0) {
    bullets.push(
      '**The year was completed in full.** Nothing was posted, nothing was filed, and everybody is ' +
        'still here — which was the only mandatory deliverable.',
    )
  }

  return bullets.map(b => `- ${b}`).join('\n')
}

function investmentOverview(f: StatementFacts): string {
  const parts: string[] = []
  const ranked = rankedEntries(f.totals.byCategory)

  if (ranked.length === 0) {
    parts.push(
      `No spend was allocated to a cost centre this period, so the investment overview is short: ` +
        `${money(f.totals.overall, f.currency)}, unclassified, entirely defensible.`,
    )
    return parts.join('\n\n')
  }

  const leader = ranked[0]
  parts.push(
    `Of the ${money(f.totals.overall, f.currency)} invested this year, **${categoryLabel(leader.key)}** absorbed the largest ` +
      `share at ${money(leader.value, f.currency)}${share(leader.value, f.totals.overall)} — ${categoryNote(leader.key)}. ` +
      'The remainder is distributed below, in descending order of enthusiasm.',
  )

  const rows = ranked.slice(0, 8).map(entry => {
    const pct = f.totals.overall > 0 ? `${percent(entry.value, f.totals.overall)}` : '—'
    return `| ${categoryLabel(entry.key)} | ${money(entry.value, f.currency)} | ${pct} |`
  })
  if (ranked.length > 8) {
    const rest = ranked.slice(8).reduce((sum, entry) => sum + entry.value, 0)
    rows.push(
      `| Other (${ranked.length - 8}) | ${money(rest, f.currency)} | ${percent(rest, f.totals.overall)} |`,
    )
  }
  parts.push(['| Cost centre | Amount | Share |', '| --- | ---: | ---: |', ...rows].join('\n'))

  const funding = contributionSentence(f, 'overview')
  if (funding !== null) parts.push(funding)

  if (f.events.length > 0) {
    const named = f.events
      .slice(0, 4)
      .map(
        e =>
          `${e.name} (${money(e.total, f.currency)}, ${plural(e.participantCount, 'person', 'people')})`,
      )
    parts.push(
      `Grouped by occasion rather than by month, the year booked ${joinWithAnd(named)}. ` +
        'Each of those is a line in the ledger and a week we would take again.',
    )
  }

  const moments = rankedEntries(f.totals.byMoment)
  if (moments.length > 0) {
    const described = moments
      .slice(0, 4)
      .map(entry => `${money(entry.value, f.currency)} on ${momentLabel(entry.key)}`)
    // Only claim the everyday line when the year actually has one.
    const everydayNote = moments.some(entry => entry.key === 'everyday')
      ? ' We consider the everyday line the most important one on the page — it is the part nobody photographs.'
      : ''
    parts.push(`Broken out by occasion, the year reads: ${joinWithAnd(described)}.${everydayNote}`)
  }

  if (f.topMerchants.length > 1) {
    const named = f.topMerchants
      .slice(0, 3)
      .map(
        m =>
          `${m.merchant} (${money(m.total, f.currency)}, ${plural(m.visits, 'visit', 'visits')})`,
      )
    parts.push(`Top counterparties by spend: ${joinWithAnd(named)}.`)
  }

  return parts.join('\n\n')
}

function highlightsByQuarter(f: StatementFacts): string {
  const quarters = [...f.quarters].sort((left, right) => left.quarter - right.quarter)
  if (quarters.length === 0) {
    return (
      'Quarterly detail was not available for this period. We are told the year happened in roughly four parts, ' +
      'and we enjoyed all of them.'
    )
  }

  const lines = quarters.map(q => {
    const highlight =
      q.highlight !== null && q.highlight.trim().length > 0
        ? q.highlight.trim()
        : (QUARTER_FALLBACKS[q.quarter] ?? 'a quarter that went by without a formal review.')
    const period = QUARTER_PERIODS[q.quarter] ?? 'three months'
    return `**Q${q.quarter} · ${money(q.total, f.currency)}** — ${period}. ${asSentence(highlight)}`
  })

  const best = quarters.reduce((top, q) => (q.total > top.total ? q : top), quarters[0])
  if (best.total > 0) {
    lines.push(
      `Q${best.quarter} was our strongest quarter by volume at ${money(best.total, f.currency)}. ` +
        'No explanation has been requested and none will be offered.',
    )
  }

  return lines.join('\n\n')
}

function outlook(f: StatementFacts, seed: number): string {
  const nextYear = f.year > 0 ? f.year + 1 : null
  const guidance: string[] = []

  if (f.counts.dateNights > 0) {
    guidance.push(`at least ${f.counts.dateNights + 1} date nights`)
  } else {
    guidance.push('a date night (formally scheduled, informally extended)')
  }
  if (f.counts.trips > 0) {
    guidance.push(`${f.counts.trips + 1} trips (at least one of them unannounced)`)
  } else {
    guidance.push('one trip to a destination still under pleasant negotiation')
  }
  guidance.push('continued heavy investment in the everyday line')

  const parts: string[] = []
  parts.push(
    `Management is guiding${nextYear === null ? '' : ` FY${nextYear}`} to ${joinWithAnd(guidance)}. ` +
      'These targets are non-binding, generously interpreted, and have never once been missed for a reason that mattered.',
  )
  parts.push(
    'This section contains forward-looking statements: promises about restaurants, plans involving trains, and at least one ' +
      `sentence about ${nextYear === null ? 'next summer' : `summer ${nextYear}`} that will be revised. ` +
      pick(OUTLOOK_RISKS, seed, 1),
  )

  return parts.join('\n\n')
}

function closingNote(f: StatementFacts): string {
  const scale =
    f.counts.expenses > 0
      ? `${plural(f.counts.expenses, 'line item', 'line items')}`
      : 'no line items at all'
  return [
    `Every figure above came out of ${scale}, which is a ridiculous way to describe a year and the only one we had to hand. ` +
      'The receipts record where we were. They do not record the part that mattered, so we will state it here for the file:',
    `${reportingEntity(f)}, still matched line for line, ${f.year > 0 ? `at the close of FY${f.year}` : 'at the close of the period'}.`,
    'Approved by the CEO of the household. Countersigned by every other CEO of the household.',
  ].join('\n\n')
}

function footer(): string {
  return '---\n\n*Two-Way Match · Statement of Us · prepared by the finance function (us) · unaudited, wholly reliable.*'
}

/** The short form used when the prompt carried no parseable facts at all. */
function renderMinimalStatement(): string {
  return [
    '# Statement of Us',
    '',
    '## Executive Summary',
    '',
    'No aggregated figures reached the generator, so this is the short form. The joint venture continued to operate ' +
      'throughout the period. Headcount: unchanged. Sentiment: strong.',
    '',
    '## Key Achievements',
    '',
    '- **The year was completed in full**, on time, with everyone present at close.',
    '- **No material disagreements** were escalated to the board, because the board is us.',
    '',
    '## Investment Overview',
    '',
    'Figures unavailable for this period. On the evidence of every other period, they were spent well.',
    '',
    '## Highlights by Quarter',
    '',
    'Quarterly detail unavailable. The year is understood to have proceeded in the usual four parts.',
    '',
    '## Outlook',
    '',
    'Guidance for the coming year: more of it, together. Forward-looking statements above are non-binding and ' +
      'entirely sincere.',
    '',
    '## Closing note',
    '',
    'The ledger was quiet this time. That is not the same as nothing happening.',
    '',
    '---',
    '',
    '*Two-Way Match · Statement of Us · unaudited, wholly reliable.*',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Sentence builders
// ---------------------------------------------------------------------------

/** "Ada and Bruno", "Ada, Bruno and Noemi", or the fallback when nobody is named. */
function reportingEntity(f: StatementFacts): string {
  return f.people.length > 0 ? joinWithAnd(f.people) : 'the household'
}

/** Headcount is whatever the roster says it is; two is not a special number here. */
function headcountSentence(f: StatementFacts): string {
  return f.people.length > 0
    ? `Headcount remained stable at ${f.people.length}.`
    : 'Headcount remained stable.'
}

/** The per-head figure on an event, as context — never as an amount anyone owes. */
function perHeadNote(event: StatementFacts['events'][number], currency: string): string {
  if (event.participantCount <= 1 || event.total <= 0) return ''
  return `, or ${money(event.total / event.participantCount, currency)} each`
}

/**
 * Who paid for the year, largest contribution first. Null when nothing was paid.
 *
 * This is the one place a report about shared money is tempted to become a
 * report about debt, so it says only what left whose account (CONTRACTS.md §9).
 * Two variants because the Executive Summary and the Investment Overview both
 * want this figure, and printing one sentence twice in the same document is the
 * fastest way to make a warm report read like a mail merge.
 */
function contributionSentence(f: StatementFacts, variant: 'summary' | 'overview'): string | null {
  const ranked = rankedEntries(f.totals.byPerson).filter(entry => entry.value > 0)
  if (ranked.length === 0) return null
  const total = ranked.reduce((sum, entry) => sum + entry.value, 0)
  if (total <= 0) return null

  const named = ranked.map(
    entry => `${entry.key} ${money(entry.value, f.currency)} (${percent(entry.value, total)})`,
  )

  if (variant === 'overview') {
    return (
      `Contributions to that figure: ${joinWithAnd(named)}. Nobody has ever asked for this ` +
      'breakdown, which is the healthiest possible audit finding.'
    )
  }
  return (
    `The money left the following accounts: ${joinWithAnd(named)}. We do not keep score. ` +
    'We keep a ledger, which is different and much worse.'
  )
}

/**
 * The one-sentence "what actually happened" line for the summary.
 *
 * Deliberately silent about the date-night streak: Key Achievements carries a
 * bullet for it under exactly the same condition, and stating it twice two
 * paragraphs apart makes a warm report read like a mail merge.
 */
function activitySentence(f: StatementFacts): string | null {
  const items: string[] = []
  if (f.counts.dateNights > 0) items.push(plural(f.counts.dateNights, 'date night', 'date nights'))
  if (f.counts.trips > 0) items.push(plural(f.counts.trips, 'trip', 'trips'))
  if (f.counts.gifts > 0) items.push(plural(f.counts.gifts, 'gift', 'gifts'))
  if (items.length === 0) return null

  const places =
    f.placesVisited.length > 0
      ? ` Operations were carried out in ${joinWithAnd(withOverflow(f.placesVisited, 4, 'elsewhere'))}.`
      : ''

  return `The period contained ${joinWithAnd(items)}.${places}`
}

/** Null when the year has no memories recorded to bookend it with. */
function bookendSentence(f: StatementFacts): string | null {
  const first = f.firstMemory
  const last = f.lastMemory
  if (first === null && last === null) return null
  // Same title *and* same date means the year recorded exactly one memory; two
  // memories that happen to share a title still deserve the two-sided sentence.
  if (first !== null && last !== null && (first.title !== last.title || first.date !== last.date)) {
    return (
      `**The year opened with “${first.title}” (${first.date}) and closed with “${last.title}” (${last.date}).** ` +
      'Everything in between is filed under evidence.'
    )
  }
  const only = first ?? last
  if (only === null) return null
  return `**One memory was formally recorded: “${only.title}” (${only.date}).** A small sample, well chosen.`
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`
}

function categoryLabel(code: string): string {
  return CATEGORY_LABELS[code] ?? code
}

function categoryNote(code: string): string {
  return CATEGORY_NOTES[code] ?? 'a line we have never felt the need to justify'
}

function momentLabel(code: string): string {
  return MOMENT_LABELS[code] ?? code.replace(/_/g, ' ')
}

/**
 * Swiss-style money formatting done by hand rather than through `Intl`: the
 * template provider must be byte-identical across machines, and ICU data is not
 * guaranteed to be.
 */
function money(amount: number, currency: string): string {
  const safe = Number.isFinite(amount) ? amount : 0
  const rounded = Math.round(Math.abs(safe) * 100 + 1e-9) / 100
  const [whole, fraction] = rounded.toFixed(2).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, "'")
  return `${safe < 0 ? '-' : ''}${currency} ${grouped}.${fraction}`
}

function percent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return '0%'
  return `${Math.round((part / whole) * 100)}%`
}

function share(part: number, whole: number): string {
  return whole > 0 ? ` (${percent(part, whole)} of the year)` : ''
}

/** "An 11-week run", not "A 11-week run" — the only numbers in range that take *an*. */
function indefiniteArticle(count: number): string {
  const leading = String(count)
  return leading.startsWith('8') || leading.startsWith('11') || leading.startsWith('18')
    ? 'An'
    : 'A'
}

/** Highlights arrive as sentence fragments; they still have to start a sentence. */
function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0].toUpperCase()}${text.slice(1)}`
}

/**
 * A highlight may be a bare fragment ("Lisbon") or a full sentence; either way it
 * is printed mid-paragraph, so it has to end like one.
 */
function asSentence(text: string): string {
  const trimmed = capitalise(text.trim())
  if (trimmed.length === 0) return trimmed
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/** "a, b, c and elsewhere" — the overflow word joins the list instead of trailing it. */
function withOverflow(items: readonly string[], max: number, overflow: string): string[] {
  return items.length > max ? [...items.slice(0, max), overflow] : [...items]
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function joinWithAnd(items: readonly string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Sorted by value descending, then key ascending, so output never depends on insertion order. */
function rankedEntries(record: Record<string, number>): Array<{ key: string; value: number }> {
  return Object.entries(record)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value !== 0)
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => right.value - left.value || (left.key < right.key ? -1 : 1))
}

/**
 * FNV-1a over a few stable facts. Picking phrasing from a seed gives different
 * years a different voice while keeping any single year reproducible.
 */
function seedOf(f: StatementFacts): number {
  const basis = `${f.year}|${f.counts.expenses}|${Math.round(f.totals.overall * 100)}|${f.people.join('|')}`
  let hash = 2166136261
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function pick(variants: readonly string[], seed: number, salt: number): string {
  return variants[(seed + salt) % variants.length]
}

// ---------------------------------------------------------------------------
// Reading StatementFacts back out of a prompt
// ---------------------------------------------------------------------------

/**
 * Finds the facts JSON inside the prompt the statement generator built.
 *
 * The prompt is prose with a JSON block somewhere in it, so this scans for
 * top-level balanced objects (string- and escape-aware) and then, if none of
 * them is itself the facts, looks one level into their values. Anything that
 * fails to parse is skipped rather than thrown.
 */
function extractFacts(prompt: string): StatementFacts | null {
  const strict = firstFactsIn(balancedObjects(prompt, true))
  if (strict !== null) return strict
  // A single unpaired quote in the surrounding prose ("6\" of snow") makes the
  // string-aware scan swallow the JSON block, so try once more on braces alone.
  return firstFactsIn(balancedObjects(prompt, false))
}

function firstFactsIn(candidates: readonly string[]): StatementFacts | null {
  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const found = findFacts(parsed, 0)
    if (found !== null) return found
  }
  return null
}

/** Yields every top-level `{...}` in the text, optionally ignoring braces in strings. */
function balancedObjects(text: string, quoteAware: boolean): string[] {
  const found: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (quoteAware && char === '"') {
      inString = true
    } else if (char === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (char === '}') {
      if (depth > 0) {
        depth -= 1
        if (depth === 0 && start >= 0) {
          found.push(text.slice(start, i + 1))
          start = -1
        }
      }
    }
  }
  return found
}

/** Depth-limited search for the object that looks like StatementFacts. */
function findFacts(value: unknown, depth: number): StatementFacts | null {
  if (!isRecord(value) || depth > 3) return null
  if (looksLikeFacts(value)) return normaliseFacts(value)
  for (const nested of Object.values(value)) {
    const found = findFacts(nested, depth + 1)
    if (found !== null) return found
  }
  return null
}

/** Two of the five signature keys is enough to be confident, and cheap to check. */
function looksLikeFacts(record: Record<string, unknown>): boolean {
  let hits = 0
  if (typeof record.year === 'number') hits += 1
  if (isRecord(record.totals)) hits += 1
  if (isRecord(record.counts)) hits += 1
  if (Array.isArray(record.people)) hits += 1
  if (Array.isArray(record.quarters)) hits += 1
  return hits >= 2
}

/**
 * Fills in every field so the renderer can read facts without a single optional
 * check. Accepts a partially-populated object, which is what makes the whole
 * template path unable to throw.
 */
function normaliseFacts(value: unknown): StatementFacts {
  const record = isRecord(value) ? value : {}
  const totals = isRecord(record.totals) ? record.totals : {}
  const counts = isRecord(record.counts) ? record.counts : {}

  return {
    year: num(record.year, 0),
    people: strings(record.people),
    currency: str(record.currency, 'CHF'),
    totals: {
      overall: num(totals.overall, 0),
      byCategory: numberMap(totals.byCategory),
      byPerson: numberMap(totals.byPerson),
      byMoment: numberMap(totals.byMoment),
    },
    counts: {
      expenses: num(counts.expenses, 0),
      dateNights: num(counts.dateNights, 0),
      trips: num(counts.trips, 0),
      gifts: num(counts.gifts, 0),
    },
    events: events(record.events),
    topMerchants: merchants(record.topMerchants),
    longestDateNightStreakWeeks: num(record.longestDateNightStreakWeeks, 0),
    placesVisited: strings(record.placesVisited),
    firstMemory: memory(record.firstMemory),
    lastMemory: memory(record.lastMemory),
    quarters: quarterList(record.quarters),
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function numberMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isRecord(value)) return out
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry
  }
  return out
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  )
}

/** Largest first, matching the order `aggregateYear()` produces. */
function events(value: unknown): StatementFacts['events'] {
  if (!Array.isArray(value)) return []
  const out: StatementFacts['events'] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const name = str(entry.name, '')
    if (name.length === 0) continue
    out.push({
      name,
      total: num(entry.total, 0),
      participantCount: num(entry.participantCount, 0),
    })
  }
  return out.sort((left, right) => right.total - left.total || (left.name < right.name ? -1 : 1))
}

function merchants(value: unknown): StatementFacts['topMerchants'] {
  if (!Array.isArray(value)) return []
  const out: StatementFacts['topMerchants'] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const merchant = str(entry.merchant, '')
    if (merchant.length === 0) continue
    out.push({ merchant, total: num(entry.total, 0), visits: num(entry.visits, 0) })
  }
  return out
}

function memory(value: unknown): { title: string; date: string } | null {
  if (!isRecord(value)) return null
  const title = str(value.title, '')
  if (title.length === 0) return null
  return { title, date: str(value.date, '') }
}

function quarterList(value: unknown): StatementFacts['quarters'] {
  if (!Array.isArray(value)) return []
  const out: StatementFacts['quarters'] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const q = num(entry.quarter, 0)
    if (q !== 1 && q !== 2 && q !== 3 && q !== 4) continue
    const highlight = typeof entry.highlight === 'string' ? entry.highlight : null
    out.push({ quarter: q, total: num(entry.total, 0), highlight })
  }
  return out
}
