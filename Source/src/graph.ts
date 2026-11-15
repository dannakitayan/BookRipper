import type { Edge, Node } from '@xyflow/react'
import type { EdgeData, Finding, QueryData, SynopsisData } from './types'
import { isPropagated } from './types'

export type QueryNode = Node<QueryData, 'query'>
export type SynopsisNode = Node<SynopsisData, 'synopsis'>
export type AnyNode = QueryNode | SynopsisNode
export type AnyEdge = Edge<EdgeData>

export const isQuery = (n: AnyNode): n is QueryNode => n.type === 'query'
export const isSynopsis = (n: AnyNode): n is SynopsisNode => n.type === 'synopsis'

/** Стрелки, влияющие на промпт; подшивка в конспект к ним не относится. */
const isPromptEdge = (e: AnyEdge) => e.data?.kind !== 'cite'

function parentsOf(edges: AnyEdge[], id: string): string[] {
  return edges.filter((e) => isPromptEdge(e) && e.target === id).map((e) => e.source)
}

/**
 * Стрелки рисуются от руки, поэтому цикл создать легко.
 * Сбор контекста предков по циклу ушёл бы в бесконечность — проверяем до добавления ребра.
 */
export function wouldCreateCycle(edges: AnyEdge[], source: string, target: string): boolean {
  if (source === target) return true
  const seen = new Set<string>()
  const stack = [source]
  while (stack.length) {
    const id = stack.pop()!
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...parentsOf(edges, id))
  }
  return false
}

/** Все предки узла, от ближайших к дальним. */
export function ancestorsOf(edges: AnyEdge[], id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  let frontier = parentsOf(edges, id)
  while (frontier.length) {
    const next: string[] = []
    for (const p of frontier) {
      if (seen.has(p)) continue
      seen.add(p)
      out.push(p)
      next.push(...parentsOf(edges, p))
    }
    frontier = next
  }
  return out
}

export interface InheritedItem {
  fromBlock: string
  kind: NonNullable<EdgeData['kind']>
  finding: Finding
}

/** Находки блока: у запроса они лежат внутри заметок, у конспекта их нет. */
export function findingsOf(node: AnyNode): Finding[] {
  return isQuery(node) ? node.data.notes.flatMap((n) => n.findings) : []
}

/** Выписки, одобренные человеком — только они идут дальше по стрелкам и в конспект. */
export function acceptedFindingsOf(node: AnyNode): Finding[] {
  return findingsOf(node).filter((f) => isPropagated(f.status))
}

/**
 * То, что реально уедет в промпт дочерней заметки.
 * Главная ценность прототипа — видеть это глазами до подключения модели.
 */
export function inheritedContext(nodes: AnyNode[], edges: AnyEdge[], id: string): InheritedItem[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const kindFor = (ancestor: string): NonNullable<EdgeData['kind']> => {
    // Тип берём с ребра, если предок соединён напрямую; для дальних предков — «контекст».
    const direct = edges.find((e) => isPromptEdge(e) && e.source === ancestor && e.target === id)
    return direct?.data?.kind ?? 'context'
  }
  const items: InheritedItem[] = []
  for (const ancestorId of ancestorsOf(edges, id)) {
    const node = byId.get(ancestorId)
    if (!node) continue
    for (const f of acceptedFindingsOf(node)) {
      items.push({ fromBlock: node.data.title, kind: kindFor(ancestorId), finding: f })
    }
  }
  return items
}

/** Термины из принятых выписок — ими расширяется поисковый запрос дочерней заметки. */
export function inheritedTerms(items: InheritedItem[]): string[] {
  const terms = new Set<string>()
  for (const { finding } of items) {
    for (const m of finding.excerpt.matchAll(/\*\*(.+?)\*\*/g)) terms.add(m[1])
  }
  return [...terms]
}

/** Книги предков, соединённых стрелкой «narrow scope» — именно к ним сузится поиск. */
export function inheritedScopeDocIds(items: InheritedItem[]): number[] {
  const ids = new Set<number>()
  for (const { kind, finding } of items) {
    if (kind === 'narrow' && finding.docId != null) ids.add(finding.docId)
  }
  return [...ids]
}

export interface Citation {
  edgeId: string
  query: QueryNode
  order: number
}

/** Запросы, подшитые к конспекту, в заданном пользователем порядке. */
export function citationsOf(nodes: AnyNode[], edges: AnyEdge[], synopsisId: string): Citation[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return edges
    .filter((e) => e.data?.kind === 'cite' && e.target === synopsisId)
    .map((e) => {
      const node = byId.get(e.source)
      return node && isQuery(node) ? { edgeId: e.id, query: node, order: e.data?.order ?? 0 } : null
    })
    .filter((c): c is Citation => c !== null)
    .sort((a, b) => a.order - b.order)
}

/** К какому конспекту подшит запрос; запрос может питать несколько листов. */
export function synopsesOf(edges: AnyEdge[], queryId: string): string[] {
  return edges.filter((e) => e.data?.kind === 'cite' && e.source === queryId).map((e) => e.target)
}

export interface NumberedCitation {
  /** Номер в конспекте: именно он попадает в текст маркером [n]. */
  n: number
  queryId: string
  queryTitle: string
  finding: Finding
}

/**
 * Сквозная нумерация выписок конспекта: по порядку подшитых запросов,
 * внутри запроса — по порядку принятых выписок. Один источник правды
 * и для маркеров в тексте, и для списка в Markdown.
 */
export function citationList(
  nodes: AnyNode[],
  edges: AnyEdge[],
  synopsisId: string,
): NumberedCitation[] {
  const out: NumberedCitation[] = []
  for (const c of citationsOf(nodes, edges, synopsisId)) {
    for (const finding of acceptedFindingsOf(c.query)) {
      out.push({
        n: out.length + 1,
        queryId: c.query.id,
        queryTitle: c.query.data.title,
        finding,
      })
    }
  }
  return out
}

/** Разбивка по «ярусам» для простой автораскладки без внешних зависимостей. */
export function layered(nodes: AnyNode[], edges: AnyEdge[]): AnyNode[] {
  const depth = new Map<string, number>()
  const resolve = (id: string, guard: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!
    if (guard.has(id)) return 0
    guard.add(id)
    const ps = parentsOf(edges, id)
    const d = ps.length ? Math.max(...ps.map((p) => resolve(p, guard))) + 1 : 0
    depth.set(id, d)
    return d
  }
  for (const n of nodes) resolve(n.id, new Set())

  // Конспекты уводим в отдельную колонку справа: они собирают, а не порождают.
  const queryDepths = nodes.filter(isQuery).map((n) => depth.get(n.id) ?? 0)
  const synopsisColumn = (queryDepths.length ? Math.max(...queryDepths) : 0) + 1

  const perColumn = new Map<number, number>()
  return nodes.map((n) => {
    const d = isSynopsis(n) ? synopsisColumn : (depth.get(n.id) ?? 0)
    const row = perColumn.get(d) ?? 0
    perColumn.set(d, row + 1)
    return { ...n, position: { x: d * 440, y: row * 400 } }
  })
}
