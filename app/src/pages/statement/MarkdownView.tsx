/**
 * Renders the syntax tree from `markdown.ts` as React elements.
 *
 * Every leaf is a string child of a React element, so React escapes it. There is no
 * `dangerouslySetInnerHTML` in this file and there must never be one: the input is model
 * output, and this is the only thing standing between a statement and the DOM.
 */
import { useMemo } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { inlineText, parseMarkdown, slug, type MdBlock, type MdInline } from './markdown'

export interface MarkdownViewProps {
  source: string
  /** Extra class on the wrapper, for print scoping. */
  className?: string
}

export function MarkdownView({ source, className }: MarkdownViewProps): ReactElement {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className={className === undefined ? 'twm-md' : `twm-md ${className}`}>
      <Blocks blocks={blocks} />
    </div>
  )
}

function Blocks({ blocks }: { blocks: MdBlock[] }): ReactElement {
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </>
  )
}

function Block({ block }: { block: MdBlock }): ReactElement {
  switch (block.kind) {
    case 'heading':
      return (
        <Heading level={block.level} id={slug(inlineText(block.children))}>
          <Inlines nodes={block.children} />
        </Heading>
      )

    case 'paragraph':
      return (
        <p className="twm-md-p">
          <Inlines nodes={block.children} />
        </p>
      )

    case 'rule':
      return <hr className="twm-md-hr" />

    case 'code':
      return (
        <pre className="twm-md-pre" data-lang={block.lang ?? undefined}>
          <code>{block.value}</code>
        </pre>
      )

    case 'quote':
      return (
        <blockquote className="twm-md-quote">
          <Blocks blocks={block.blocks} />
        </blockquote>
      )

    case 'list': {
      const items = block.items.map((item, index) => (
        <li className="twm-md-li" key={index}>
          <ListItemBody blocks={item.blocks} />
        </li>
      ))
      return block.ordered ? (
        <ol className="twm-md-ol" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="twm-md-ul">{items}</ul>
      )
    }

    case 'table':
      return (
        <div className="twm-md-tablewrap" role="region" aria-label="Table" tabIndex={0}>
          <table className="twm-md-table">
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} style={{ textAlign: block.align[index] ?? undefined }}>
                    <Inlines nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} style={{ textAlign: block.align[index] ?? undefined }}>
                      <Inlines nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

/** A single-paragraph item renders tight — no `<p>` inside the `<li>`. */
function ListItemBody({ blocks }: { blocks: MdBlock[] }): ReactElement {
  if (blocks.length === 1 && blocks[0].kind === 'paragraph') {
    return <Inlines nodes={blocks[0].children} />
  }
  return <Blocks blocks={blocks} />
}

interface HeadingProps {
  level: number
  id: string
  children: ReactNode
}

function Heading({ level, id, children }: HeadingProps): ReactElement {
  const className = `twm-md-h twm-md-h${level}`
  switch (level) {
    case 1:
      return (
        <h1 className={className} id={id}>
          {children}
        </h1>
      )
    case 2:
      return (
        <h2 className={className} id={id}>
          {children}
        </h2>
      )
    case 3:
      return (
        <h3 className={className} id={id}>
          {children}
        </h3>
      )
    case 4:
      return (
        <h4 className={className} id={id}>
          {children}
        </h4>
      )
    case 5:
      return (
        <h5 className={className} id={id}>
          {children}
        </h5>
      )
    default:
      return (
        <h6 className={className} id={id}>
          {children}
        </h6>
      )
  }
}

function Inlines({ nodes }: { nodes: MdInline[] }): ReactElement {
  return (
    <>
      {nodes.map((node, index) => (
        <Inline key={index} node={node} />
      ))}
    </>
  )
}

function Inline({ node }: { node: MdInline }): ReactElement {
  switch (node.kind) {
    case 'text':
      return <>{node.value}</>
    case 'strong':
      return (
        <strong className="twm-md-strong">
          <Inlines nodes={node.children} />
        </strong>
      )
    case 'em':
      return (
        <em className="twm-md-em">
          <Inlines nodes={node.children} />
        </em>
      )
    case 'code':
      return <code className="twm-md-code">{node.value}</code>
    case 'link':
      return (
        <a className="twm-md-link" href={node.href} target="_blank" rel="noreferrer noopener">
          <Inlines nodes={node.children} />
        </a>
      )
  }
}
