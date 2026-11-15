import { citationList, isQuery, isSynopsis, type AnyEdge, type AnyNode } from './graph'
import { formatLocator } from './types'

/**
 * Выгрузка исследования наружу: JSON нужен программе, Markdown — человеку.
 * Нумерация та же, что у маркеров [n] в тексте конспекта.
 */
export function toMarkdown(nodes: AnyNode[], edges: AnyEdge[]): string {
  const lines: string[] = []
  const synopses = nodes.filter(isSynopsis)

  for (const s of synopses) {
    lines.push(`# ${s.data.title || 'Untitled'}`, '')
    if (s.data.text.trim()) lines.push(s.data.text.trim(), '')

    const cites = citationList(nodes, edges, s.id)
    if (cites.length) {
      lines.push('## Sources', '')
      let lastQuery = ''
      for (const c of cites) {
        if (c.queryTitle !== lastQuery) {
          lines.push(`*from “${c.queryTitle}”*`, '')
          lastQuery = c.queryTitle
        }
        const loc = formatLocator(c.finding.locator)
        // Жирные **термины** внутри выписки — наша разметка, в цитате она ни к чему.
        const excerpt = c.finding.excerpt.replace(/\*\*(.+?)\*\*/g, '$1')
        lines.push(`${c.n}. **${c.finding.sourceTitle}** · ${loc}`, `   > ${excerpt}`, '')
      }
    } else {
      lines.push('*No references cited yet.*', '')
    }
  }

  // Запросы, не подшитые никуда: иначе их работа пропадёт из выгрузки.
  const cited = new Set(edges.filter((e) => e.data?.kind === 'cite').map((e) => e.source))
  const unfiled = nodes.filter((n) => isQuery(n) && !cited.has(n.id))
  if (unfiled.length) {
    lines.push('---', '', '## Unfiled references', '')
    for (const n of unfiled) {
      if (!isQuery(n)) continue
      lines.push(`### ${n.data.title || 'Untitled'}`, '')
      for (const note of n.data.notes) {
        lines.push(`- **${note.question || 'no question'}** — ${note.state}`)
        for (const f of note.findings) {
          if (f.status === 'rejected') continue
          lines.push(`  - ${f.sourceTitle} · ${formatLocator(f.locator)}`)
        }
      }
      lines.push('')
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
