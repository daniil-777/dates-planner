/**
 * A small, deliberately incomplete Markdown reader for the Statement of Us.
 *
 * The statement is written by an LLM (or by the deterministic template provider) and
 * arrives as Markdown on `Statement.contentMarkdown`. No Markdown library is installed
 * and none is going to be: the surface the statement actually uses is headings, bold,
 * italic, inline code, lists, pipe tables, block quotes, rules and paragraphs.
 *
 * The output is a typed syntax tree, never a string of HTML. That is the security
 * property that matters — `Markdown.tsx` renders the tree as React elements, so every
 * piece of model output ends up as a text node and `<script>` in a statement is five
 * visible characters rather than a script tag. There is no `dangerouslySetInnerHTML`
 * anywhere in this feature, and the parser never has to be trusted to escape anything.
 *
 * Anything it does not recognise degrades to a paragraph of text rather than
 * disappearing, which is the right failure mode for a document someone wants to read.
 */

export type MdAlign = 'left' | 'center' | 'right'

export type MdInline =
  | { kind: 'text'; value: string }
  | { kind: 'strong'; children: MdInline[] }
  | { kind: 'em'; children: MdInline[] }
  | { kind: 'code'; value: string }
  | { kind: 'link'; href: string; children: MdInline[] }

export interface MdListItem {
  blocks: MdBlock[]
}

export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { kind: 'paragraph'; children: MdInline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { kind: 'table'; header: MdInline[][]; align: (MdAlign | null)[]; rows: MdInline[][][] }
  | { kind: 'quote'; blocks: MdBlock[] }
  | { kind: 'code'; value: string; lang: string | null }
  | { kind: 'rule' }

/** Nesting deeper than this is a malformed document, not a document with opinions. */
const MAX_DEPTH = 6

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const RULE = /^ {0,3}(?:-[ \t]*){3,}$|^ {0,3}(?:\*[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$/
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[ \t]*$/
const QUOTE = /^ {0,3}> ?(.*)$/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const ORDERED_MARKER = /^\d/
/** Escapable ASCII punctuation, the CommonMark set. */
const PUNCTUATION = /[\\`*_{}[\]()#+\-.!|>~]/
/** Link schemes that cannot execute anything when clicked. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s<>"']+$/i

/**
 * Parse a Markdown document into blocks.
 *
 * Line endings are normalised, tabs in leading position count as two spaces (statements
 * are machine-written and never mix them meaningfully), and unrecognised syntax is text.
 */
export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n')
  return parseBlocks(lines, 0)
}

function parseBlocks(lines: string[], depth: number): MdBlock[] {
  const blocks: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      const body: string[] = []
      i += 1
      while (i < lines.length && !isClosingFence(lines[i], marker)) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push({ kind: 'code', value: body.join('\n'), lang: fence[2] === '' ? null : fence[2] })
      continue
    }

    // A rule has to be tested before the list, or `- - -` becomes three bullets.
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      i += 1
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const level = Math.min(6, Math.max(1, heading[1].length)) as 1 | 2 | 3 | 4 | 5 | 6
      blocks.push({ kind: 'heading', level, children: parseInline(heading[2]) })
      i += 1
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && lines[i].trim() !== '') {
        const quoted = QUOTE.exec(lines[i])
        // Lazy continuation: a plain line inside a quote block stays in the quote.
        body.push(quoted ? quoted[1] : lines[i].trim())
        i += 1
      }
      blocks.push({
        kind: 'quote',
        blocks: depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [textParagraph(body)],
      })
      continue
    }

    const table = tryTable(lines, i)
    if (table) {
      blocks.push(table.block)
      i = table.next
      continue
    }

    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, i, depth)
      blocks.push(list.block)
      i = list.next
      continue
    }

    const paragraph: string[] = []
    while (i < lines.length && !isBlockStart(lines, i)) {
      if (paragraph.length > 0 && SETEXT.test(lines[i])) break
      paragraph.push(lines[i].trim())
      i += 1
    }
    if (paragraph.length === 0) {
      // Defensive: never loop without consuming a line.
      paragraph.push(lines[i].trim())
      i += 1
    }

    // `Heading` over `======` (or `------`) is a heading, not a paragraph and a rule.
    const underline = i < lines.length ? SETEXT.exec(lines[i]) : null
    if (underline) {
      i += 1
      blocks.push({
        kind: 'heading',
        level: underline[1].startsWith('=') ? 1 : 2,
        children: parseInline(paragraph.join(' ')),
      })
      continue
    }

    blocks.push(textParagraph(paragraph))
  }

  return blocks
}

function textParagraph(lines: string[]): MdBlock {
  return { kind: 'paragraph', children: parseInline(lines.join(' ').trim()) }
}

function isClosingFence(line: string, marker: string): boolean {
  const closing = FENCE.exec(line)
  return closing !== null && closing[1][0] === marker[0] && closing[1].length >= marker.length
}

/** True when the line at `index` opens a block that a paragraph must not swallow. */
function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index]
  if (line.trim() === '') return true
  if (HEADING.test(line) || RULE.test(line) || FENCE.test(line) || QUOTE.test(line)) return true
  if (LIST_ITEM.test(line)) return true
  return tryTable(lines, index) !== null
}

/* ------------------------------------------------------------------ *
 *  Lists
 * ------------------------------------------------------------------ */

function parseList(
  lines: string[],
  start: number,
  depth: number,
): { block: MdBlock; next: number } {
  const first = LIST_ITEM.exec(lines[start])
  /* c8 ignore next */
  if (!first) return { block: textParagraph([lines[start]]), next: start + 1 }

  const ordered = ORDERED_MARKER.test(first[2])
  const baseIndent = first[1].length
  const start1 = ordered ? Number.parseInt(first[2], 10) : 1
  const items: MdListItem[] = []
  let current: string[] | null = null
  let contentIndent = 0
  let i = start

  const closeItem = (): void => {
    if (current === null) return
    const body = trimBlank(current)
    items.push({
      blocks:
        depth < MAX_DEPTH
          ? parseBlocks(body, depth + 1)
          : [{ kind: 'paragraph', children: parseInline(body.join(' ')) }],
    })
    current = null
  }

  while (i < lines.length) {
    const line = lines[i]
    const item = LIST_ITEM.exec(line)

    if (item && item[1].length <= baseIndent + 1) {
      // A switch between bullets and numbers ends this list and starts another.
      if (ORDERED_MARKER.test(item[2]) !== ordered) break
      closeItem()
      contentIndent = item[1].length + item[2].length + 1
      current = [item[3]]
      i += 1
      continue
    }

    if (line.trim() === '') {
      const next = lines[i + 1] ?? ''
      if (!continuesList(next, baseIndent, ordered)) break
      if (current !== null) current.push('')
      i += 1
      continue
    }

    if (current !== null && indentOf(line) > baseIndent) {
      current.push(line.slice(Math.min(contentIndent, indentOf(line))))
      i += 1
      continue
    }

    // Lazy continuation of the item's paragraph, e.g. a wrapped line.
    if (current !== null && !isBlockStart(lines, i)) {
      current.push(line.trim())
      i += 1
      continue
    }

    break
  }

  closeItem()
  return { block: { kind: 'list', ordered, start: start1, items }, next: i }
}

function continuesList(next: string, baseIndent: number, ordered: boolean): boolean {
  if (next.trim() === '') return false
  const item = LIST_ITEM.exec(next)
  if (item && item[1].length <= baseIndent + 1) return ORDERED_MARKER.test(item[2]) === ordered
  return indentOf(next) > baseIndent
}

function indentOf(line: string): number {
  const match = /^ */.exec(line)
  return match ? match[0].length : 0
}

function trimBlank(lines: string[]): string[] {
  let from = 0
  let to = lines.length
  while (from < to && lines[from].trim() === '') from += 1
  while (to > from && lines[to - 1].trim() === '') to -= 1
  return lines.slice(from, to)
}

/* ------------------------------------------------------------------ *
 *  Tables
 * ------------------------------------------------------------------ */

/**
 * A GitHub-flavoured pipe table: a header row, an alignment row, then body rows.
 *
 * The alignment row is what makes a table a table — a line with pipes in it and no
 * `---|---` under it is just a paragraph that happens to contain pipes, and the
 * statement's prose does that often enough to be worth being strict about.
 */
function tryTable(lines: string[], start: number): { block: MdBlock; next: number } | null {
  const headerLine = lines[start]
  const alignLine = lines[start + 1]
  if (headerLine === undefined || alignLine === undefined) return null
  if (!headerLine.includes('|')) return null

  const header = splitCells(headerLine)
  const alignCells = splitCells(alignLine)
  if (alignCells.length !== header.length) return null
  if (!alignCells.every(cell => /^:?-+:?$/.test(cell))) return null

  const align: (MdAlign | null)[] = alignCells.map(cell => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })

  const rows: MdInline[][][] = []
  let i = start + 2
  while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
    const cells = splitCells(lines[i])
    // Pad or clip so every row matches the header — a ragged row still renders.
    const normalised: MdInline[][] = header.map((_, column) => parseInline(cells[column] ?? ''))
    rows.push(normalised)
    i += 1
  }

  return {
    block: { kind: 'table', header: header.map(parseInline), align, rows },
    next: i,
  }
}

function splitCells(line: string): string[] {
  const trimmed = line.trim()
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i]
    if (char === '\\' && trimmed[i + 1] === '|') {
      current += '|'
      i += 1
      continue
    }
    if (char === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += char
  }
  cells.push(current)
  if (cells.length > 1 && trimmed.startsWith('|') && cells[0].trim() === '') cells.shift()
  if (cells.length > 1 && trimmed.endsWith('|') && cells[cells.length - 1].trim() === '')
    cells.pop()
  return cells.map(cell => cell.trim())
}

/* ------------------------------------------------------------------ *
 *  Inline
 * ------------------------------------------------------------------ */

/**
 * Emphasis, code spans and links inside one block of text.
 *
 * Deliberately simple: the first matching closer wins, `_` does not open inside a word
 * (so `merchant_norm` survives), and anything unmatched stays as the literal character
 * the model wrote.
 */
export function parseInline(source: string, depth = 0): MdInline[] {
  const out: MdInline[] = []
  let buffer = ''
  let i = 0

  const flush = (): void => {
    if (buffer !== '') {
      out.push({ kind: 'text', value: buffer })
      buffer = ''
    }
  }

  while (i < source.length) {
    const char = source[i]

    if (char === '\\' && PUNCTUATION.test(source[i + 1] ?? '')) {
      buffer += source[i + 1]
      i += 2
      continue
    }

    if (char === '`') {
      const end = source.indexOf('`', i + 1)
      if (end > i) {
        flush()
        out.push({ kind: 'code', value: source.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    if ((char === '*' || char === '_') && depth < MAX_DEPTH) {
      const double = source[i + 1] === char
      const marker = double ? char + char : char
      if (canOpen(source, i, char)) {
        const end = findCloser(source, i + marker.length, marker)
        if (end > i + marker.length) {
          flush()
          out.push({
            kind: double ? 'strong' : 'em',
            children: parseInline(source.slice(i + marker.length, end), depth + 1),
          })
          i = end + marker.length
          continue
        }
      }
    }

    if (char === '[' && depth < MAX_DEPTH) {
      const link = tryLink(source, i, depth)
      if (link) {
        flush()
        out.push(link.node)
        i = link.next
        continue
      }
    }

    buffer += char
    i += 1
  }

  flush()
  return out
}

/** `_` between two word characters is part of the word, not emphasis. */
function canOpen(source: string, index: number, char: string): boolean {
  if (source[index + 1] === undefined || source[index + 1] === ' ') return false
  if (char !== '_') return true
  const before = source[index - 1] ?? ' '
  return !/[\w]/.test(before)
}

function findCloser(source: string, from: number, marker: string): number {
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '\\') {
      i += 1
      continue
    }
    if (source.startsWith(marker, i)) {
      // A closer cannot follow a space (`a * b * c` is arithmetic, not emphasis).
      if (source[i - 1] === ' ') continue
      if (marker.length === 1 && source[i + 1] === marker) continue
      return i
    }
  }
  return -1
}

function tryLink(
  source: string,
  index: number,
  depth: number,
): { node: MdInline; next: number } | null {
  const close = source.indexOf(']', index + 1)
  if (close < 0 || source[close + 1] !== '(') return null
  const end = source.indexOf(')', close + 2)
  if (end < 0) return null
  const href = source.slice(close + 2, end).trim()
  const label = source.slice(index + 1, close)
  if (!SAFE_HREF.test(href)) {
    // `javascript:` and friends are not links here; the text is kept, the target dropped.
    return { node: { kind: 'text', value: label }, next: end + 1 }
  }
  return {
    node: { kind: 'link', href, children: parseInline(label, depth + 1) },
    next: end + 1,
  }
}

/** Plain text of a tree — used for table-of-contents style summaries and tests. */
export function inlineText(nodes: MdInline[]): string {
  return nodes
    .map(node => {
      switch (node.kind) {
        case 'text':
          return node.value
        case 'code':
          return node.value
        default:
          return inlineText(node.children)
      }
    })
    .join('')
}

/** The `##` headings of a document, in order — the statement's section list. */
export function outline(blocks: MdBlock[]): string[] {
  return blocks
    .filter((block): block is Extract<MdBlock, { kind: 'heading' }> => block.kind === 'heading')
    .filter(block => block.level === 2)
    .map(block => inlineText(block.children))
}

/**
 * A DOM id for a heading, so the anchor bar can jump to a section.
 *
 * Accents are folded rather than dropped (`Cafés` and `Cafes` are the same section), and
 * anything that is not a letter or a digit becomes a hyphen.
 */
export function slug(text: string): string {
  const folded = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return folded === '' ? 'section' : `s-${folded}`
}
