/**
 * The Statement of Us renderer.
 *
 * The document under test is model output: a real statement from the template provider has
 * headings, emphasis, a bullet list and a quarter table, and a statement from an LLM can
 * contain anything at all. Both cases are covered here — the shape of a real statement, and
 * the hostile one, where the only acceptable outcome is that the angle brackets are
 * characters on the page and nothing has been added to the DOM.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownView } from './statement/MarkdownView'
import { inlineText, outline, parseMarkdown, slug } from './statement/markdown'
import { StatementPage } from './StatementPage'

/** Close to what `renderTemplateStatement` writes, trimmed to one of each construct. */
const SAMPLE = `# Statement of Us — FY2026

*Joint Venture "Ada, Grace & Noemi", audited internal figures, all amounts in CHF.*

## Executive Summary

The joint venture closed FY2026 with a total recognised spend of **CHF 2'290.30** across
19 posted expenses. Two _trips_ were undertaken.

## Highlights

- 14 date nights, the longest streak being 6 weeks
- 2 trips, the longer one to Lisboa
- 3 gifts exchanged, none of them recorded against anybody
  - one of them arrived late
- 0 reversals

## Quarters

| Quarter | Total | Highlight |
| ------- | ----: | :-------- |
| Q1 | CHF 412.55 | Blaue Ente |
| Q2 | CHF 998.75 | Lisboa |
| Q3 | CHF 879.00 | — |

## Notes

1. All amounts are gross.
2. Document #1 carries CHF 0.00 and is never reversed.

> Approved unanimously, as every year.

---

Prepared by the ledger.
`

describe('parseMarkdown', () => {
  it('reads the blocks of a real statement in order', () => {
    const blocks = parseMarkdown(SAMPLE)
    const kinds = blocks.map(block => block.kind)

    expect(kinds).toContain('heading')
    expect(kinds).toContain('paragraph')
    expect(kinds).toContain('list')
    expect(kinds).toContain('table')
    expect(kinds).toContain('quote')
    expect(kinds).toContain('rule')

    const first = blocks[0]
    expect(first.kind).toBe('heading')
    if (first.kind === 'heading') {
      expect(first.level).toBe(1)
      expect(inlineText(first.children)).toBe('Statement of Us — FY2026')
    }
  })

  it('lists the level-2 sections for the anchor bar', () => {
    expect(outline(parseMarkdown(SAMPLE))).toEqual([
      'Executive Summary',
      'Highlights',
      'Quarters',
      'Notes',
    ])
  })

  it('keeps table alignment from the delimiter row', () => {
    const table = parseMarkdown(SAMPLE).find(block => block.kind === 'table')
    expect(table).toBeDefined()
    if (table?.kind !== 'table') return
    expect(table.header.map(inlineText)).toEqual(['Quarter', 'Total', 'Highlight'])
    expect(table.align).toEqual([null, 'right', 'left'])
    expect(table.rows).toHaveLength(3)
    expect(table.rows[1].map(inlineText)).toEqual(['Q2', 'CHF 998.75', 'Lisboa'])
  })

  it('nests a sub-list inside its item', () => {
    const list = parseMarkdown(SAMPLE).find(block => block.kind === 'list')
    if (list?.kind !== 'list') throw new Error('no list parsed')
    expect(list.ordered).toBe(false)
    expect(list.items).toHaveLength(4)
    const withChild = list.items[2].blocks
    expect(withChild.some(block => block.kind === 'list')).toBe(true)
  })

  it('does not treat an underscore inside a word as emphasis', () => {
    const blocks = parseMarkdown('merchant_norm is derived, never sent by the caller.')
    expect(blocks[0].kind).toBe('paragraph')
    if (blocks[0].kind !== 'paragraph') return
    expect(inlineText(blocks[0].children)).toBe(
      'merchant_norm is derived, never sent by the caller.',
    )
    expect(blocks[0].children.every(node => node.kind === 'text')).toBe(true)
  })

  it('makes a stable anchor id per section', () => {
    expect(slug('Executive Summary')).toBe('s-executive-summary')
    expect(slug('Cafés & Co.')).toBe('s-cafes-co')
  })
})

describe('MarkdownView', () => {
  it('renders headings, emphasis, lists and a table', () => {
    const { container } = render(<MarkdownView source={SAMPLE} />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Statement of Us — FY2026')
    expect(screen.getByRole('heading', { level: 2, name: 'Quarters' })).toBeInTheDocument()
    expect(container.querySelector('h2')?.id).toBe('s-executive-summary')

    expect(screen.getByText("CHF 2'290.30").tagName).toBe('STRONG')
    expect(screen.getByText('trips').tagName).toBe('EM')

    const bullets = container.querySelectorAll('ul > li')
    expect(bullets.length).toBeGreaterThanOrEqual(4)
    expect(bullets[0]).toHaveTextContent('14 date nights, the longest streak being 6 weeks')

    const ordered = container.querySelector('ol')
    expect(ordered).not.toBeNull()
    expect(within(ordered as HTMLElement).getAllByRole('listitem')).toHaveLength(2)

    const table = screen.getByRole('table')
    const headers = within(table).getAllByRole('columnheader')
    expect(headers.map(cell => cell.textContent)).toEqual(['Quarter', 'Total', 'Highlight'])
    expect(within(table).getAllByRole('row')).toHaveLength(4)
    expect(within(table).getByText('CHF 998.75')).toHaveStyle({ textAlign: 'right' })

    expect(container.querySelector('blockquote')).toHaveTextContent(
      'Approved unanimously, as every year.',
    )
    expect(container.querySelector('hr')).not.toBeNull()
  })

  it('scrolls a wide table instead of the page', () => {
    const { container } = render(<MarkdownView source={SAMPLE} />)
    const table = screen.getByRole('table')
    expect(table.parentElement).toHaveClass('twm-md-tablewrap')
    expect(container.querySelectorAll('.twm-md-tablewrap')).toHaveLength(1)
  })

  it('escapes an injection attempt instead of executing it', () => {
    const hostile = [
      '## Injected',
      '',
      '<script>window.__pwned = true</script>',
      '',
      '<img src=x onerror="window.__pwned = true">',
      '',
      '<iframe src="https://evil.example"></iframe>',
      '',
      '[click me](javascript:window.__pwned=true)',
      '',
      '| Cell |',
      '| --- |',
      '| <b onmouseover="window.__pwned=true">bold?</b> |',
    ].join('\n')

    const { container } = render(<MarkdownView source={hostile} />)

    // Nothing from the document became an element.
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
    expect(container.innerHTML).not.toContain('javascript:')

    // All of it is still readable as text, escaped by React on the way out.
    expect(screen.getByText('<script>window.__pwned = true</script>')).toBeInTheDocument()
    expect(screen.getByText('<img src=x onerror="window.__pwned = true">')).toBeInTheDocument()
    expect(container.textContent).toContain('click me')
    expect(container.textContent).toContain('bold?')
    expect(container.innerHTML).toContain('&lt;script&gt;')

    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it('keeps a safe link but drops an unsafe target', () => {
    const { container } = render(
      <MarkdownView source={'See [the runbook](https://example.com/runbook) for the rest.'} />,
    )
    const link = container.querySelector('a')
    expect(link).not.toBeNull()
    expect(link).toHaveAttribute('href', 'https://example.com/runbook')
    expect(link?.getAttribute('rel')).toContain('noopener')
  })

  it('renders an empty document without throwing', () => {
    const { container } = render(<MarkdownView source="" />)
    expect(container.querySelector('.twm-md')).not.toBeNull()
    expect(container.textContent).toBe('')
  })
})

/* ------------------------------------------------------------------ *
 *  The page around the renderer
 * ------------------------------------------------------------------ */

const THIS_YEAR = new Date().getFullYear()

const generate = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null }

const STATEMENT = {
  ID: '1691aaff-fe89-45c3-97a4-435d17bcfaa6',
  year: THIS_YEAR,
  contentMarkdown: SAMPLE,
  generatedAt: '2026-09-01T10:47:13.211Z',
  engine: 'template',
}

/** Three of them, so nothing in the page can quietly assume a couple (CONTRACTS.md §10). */
const PEOPLE = [
  { ID: 'a-1', name: 'Ada', colour: '#0070F2', isDefault: true },
  { ID: 'b-2', name: 'Grace', colour: '#F31DED', isDefault: true },
  { ID: 'c-3', name: 'Noemi', colour: '#049F9A', isDefault: false },
]

const stored: { statements: unknown[] } = { statements: [STATEMENT] }

vi.mock('@/api/hooks', () => ({
  useStatements: () => ({
    data: stored.statements,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  usePeople: () => ({ data: PEOPLE, isPending: false, isError: false, error: null }),
  useHealth: () => ({ data: { status: 'ok', docai: 'mock', llm: 'template' } }),
  useGenerateStatement: () => generate,
}))

describe('StatementPage', () => {
  it('renders the stored statement with its footer, engine and anchors', () => {
    stored.statements = [STATEMENT]
    const { container } = render(<StatementPage />)

    expect(screen.getByText('Statement of Us')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Prepared for Ada, Grace & Noemi · Two-Way Match · unaudited, wholly reliable',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Engine: deterministic template')).toBeInTheDocument()
    expect(screen.getByText('Document 1691AAFF')).toBeInTheDocument()

    // The anchor bar is built from the statement's own level-2 headings.
    expect(screen.getAllByText('Executive Summary').length).toBeGreaterThanOrEqual(2)
    expect(container.querySelector('.twm-statement-anchors')).not.toBeNull()

    // The print stylesheet is scoped to a class this page owns while it is mounted.
    expect(document.body.classList.contains('twm-printing-statement')).toBe(true)
    expect(screen.getByText('Regenerate')).toBeInTheDocument()
  })

  it('offers to generate the year that has no statement yet', () => {
    stored.statements = []
    const { container } = render(<StatementPage />)

    // `EmptyState` hands its title to IllustratedMessage as an attribute, not a text node.
    const illustration = container.querySelector('ui5-illustrated-message')
    expect(illustration?.getAttribute('title-text')).toBe(`No statement for FY${THIS_YEAR} yet`)

    const callToAction = illustration?.querySelector('ui5-button')
    expect(callToAction).not.toBeNull()
    fireEvent.click(callToAction as HTMLElement)
    expect(generate.mutate).toHaveBeenCalledWith(THIS_YEAR)
  })
})
