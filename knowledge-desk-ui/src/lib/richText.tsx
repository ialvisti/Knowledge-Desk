import type { ReactNode } from 'react'

// El modelo responde en texto con marcas ligeras de markdown: encabezados,
// párrafos, negritas y listas anidadas. Casi nunca deja una línea en blanco
// entre el encabezado y su lista, así que la clasificación es por línea y no
// por bloque. Se interpretan construyendo nodos de React, nunca inyectando HTML.

const BULLET = /^[-*•]\s+/
const ORDERED = /^\d+[.)]\s+/
const HEADING = /^#{1,6}\s+/

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /\*\*(.+?)\*\*/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    nodes.push(<strong key={`${keyPrefix}-b${match.index}`}>{match[1]}</strong>)
    last = match.index + match[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes.length ? nodes : [text]
}

interface Entry {
  indent: number
  ordered: boolean
  text: string
}

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; entries: Entry[] }

function parse(text: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  let entries: Entry[] = []

  const closeParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
    paragraph = []
  }
  const closeList = () => {
    if (entries.length) blocks.push({ kind: 'list', entries })
    entries = []
  }

  for (const raw of text.split('\n')) {
    const content = raw.trim()
    if (!content) { closeParagraph(); closeList(); continue }
    const indent = raw.length - raw.trimStart().length

    if (HEADING.test(content)) {
      closeParagraph()
      closeList()
      blocks.push({ kind: 'heading', text: content.replace(HEADING, '') })
      continue
    }

    const bullet = BULLET.test(content)
    const ordered = !bullet && ORDERED.test(content)
    if (bullet || ordered) {
      closeParagraph()
      entries.push({ indent, ordered, text: content.replace(bullet ? BULLET : ORDERED, '') })
      continue
    }

    // Una línea sangrada bajo una viñeta la continúa; una sin sangrar cierra la
    // lista y empieza un párrafo nuevo.
    if (entries.length && indent > 0) {
      entries[entries.length - 1].text += ` ${content}`
      continue
    }
    closeList()
    paragraph.push(content)
  }
  closeParagraph()
  closeList()
  return blocks
}

interface Node {
  text: string
  ordered: boolean
  children: Node[]
}

function nest(entries: Entry[]): Node[] {
  const roots: Node[] = []
  const open: { indent: number; node: Node }[] = []
  for (const entry of entries) {
    const node: Node = { text: entry.text, ordered: entry.ordered, children: [] }
    while (open.length && open[open.length - 1].indent >= entry.indent) open.pop()
    if (open.length) open[open.length - 1].node.children.push(node)
    else roots.push(node)
    open.push({ indent: entry.indent, node })
  }
  return roots
}

function List({ nodes, keyPrefix }: { nodes: Node[]; keyPrefix: string }) {
  const ordered = nodes[0].ordered
  const className = `rich-list${ordered ? ' rich-list-ordered' : ''}`
  const items = nodes.map((node, index) => <li key={`${keyPrefix}-${index}`}>
    {inline(node.text, `${keyPrefix}-${index}`)}
    {node.children.length > 0 && <List nodes={node.children} keyPrefix={`${keyPrefix}-${index}`} />}
  </li>)
  return ordered ? <ol className={className}>{items}</ol> : <ul className={className}>{items}</ul>
}

export function RichText({ text, className = 'answer-prose' }: { text: string; className?: string }) {
  const blocks = parse(text)
  return <div className={className}>
    {blocks.map((block, index) => {
      const key = `block-${index}`
      if (block.kind === 'heading') return <p className="rich-heading" key={key}>{inline(block.text, key)}</p>
      if (block.kind === 'list') return <List nodes={nest(block.entries)} keyPrefix={key} key={key} />
      return <p key={key}>{inline(block.text, key)}</p>
    })}
  </div>
}
