import type { AnyEdge, AnyNode } from './graph'
import type { Finding } from './types'

// Фиктивные данные: ни бэкенда, ни Ollama, ни парсеров.
// Текст демонстрационный — интерфейс английский, книги в проекте en + ja.

let seq = 0
const nid = (p: string) => `${p}-${++seq}`

function f(
  sourceTitle: Finding['sourceTitle'],
  sourceLang: Finding['sourceLang'],
  locator: Finding['locator'],
  excerpt: string,
  why: string,
  status: Finding['status'] = 'pending',
): Finding {
  return { id: nid('f'), sourceTitle, sourceLang, locator, excerpt, why, status }
}

export const initialNodes: AnyNode[] = [
  {
    id: 'b-root',
    type: 'query',
    position: { x: 0, y: 0 },
    data: {
      title: 'Memory model and visibility',
      collapsed: false,
      notes: [
        {
          id: nid('n'),
          question: 'How do these books define the happens-before relation?',
          state: 'fresh',
          summary:
            'Three sources agree on the partial-order definition but disagree on whether releasing '
            + 'a lock counts as a synchronization point in the single-threaded case.',
          findings: [
            f(
              'Java Concurrency in Practice',
              'en',
              { kind: 'page', page: 341 },
              'The **happens-before** relation is a partial order: if A happens-before B, then the '
                + 'effects of A are visible to B. Unlocking a monitor happens-before every subsequent lock.',
              'States the term directly, matching the wording of the question.',
              'accepted',
            ),
            f(
              'C++ Concurrency in Action',
              'en',
              { kind: 'section', section: 'ch. 5 · Memory model basics', paragraph: 12 },
              'Rather than a single global order, the standard defines **synchronizes-with** and builds '
                + 'inter-thread happens-before on top of it.',
              'An alternative framing via synchronizes-with — it differs from the previous source.',
              'accepted',
            ),
            f(
              'プログラマのための並行処理入門',
              'ja',
              { kind: 'page', page: 88 },
              '**可視性**の保証は、スレッド間の順序関係が確立された場合にのみ成立する。',
              'The Japanese source introduces a visibility guarantee separately from ordering.',
              'pinned',
            ),
            f(
              'Java Concurrency in Practice',
              'en',
              { kind: 'page', page: 29 },
              'Thread confinement is one way to avoid the need for synchronization altogether.',
              'Mentions synchronization but answers a different question.',
              'rejected',
            ),
          ],
        },
      ],
    },
  },
  {
    id: 'b-atomics',
    type: 'query',
    position: { x: 440, y: 0 },
    data: {
      title: 'Atomic operations',
      collapsed: false,
      notes: [
        {
          id: nid('n'),
          question: 'How does acquire/release differ from seq_cst in practice?',
          state: 'stale',
          findings: [
            f(
              'C++ Concurrency in Action',
              'en',
              { kind: 'section', section: 'ch. 5 · Ordering', paragraph: 47 },
              '**memory_order_acquire** and release pair up to give you the guarantees you need without '
                + 'the full cost of sequential consistency.',
              'Compares both orderings by cost — exactly what the question asks.',
              'accepted',
            ),
            f(
              'Rust Atomics and Locks',
              'en',
              { kind: 'url', url: 'marabos.nl/atomics/memory-ordering.html', anchor: 'release-and-acquire' },
              'Release and acquire ordering are used in pairs to form a **happens-before** relationship '
                + 'between threads.',
              'Ties the orderings to the inherited term happens-before.',
              'pending',
            ),
          ],
        },
        {
          id: nid('n'),
          question: 'Where do the Japanese sources describe the reordering ban?',
          state: 'empty',
          findings: [],
        },
      ],
    },
  },
  {
    id: 's-main',
    type: 'synopsis',
    position: { x: 920, y: 120 },
    data: {
      title: 'What I understood about visibility',
      collapsed: false,
      text:
        'The authors describe the same thing from two sides: the English ones through ordering of '
        + 'operations, the Japanese one through a visibility guarantee.\n\n'
        + 'To check: do these framings agree on the double-checked locking example?',
    },
  },
]

export const initialEdges: AnyEdge[] = [
  { id: 'e-root-atomics', source: 'b-root', target: 'b-atomics', data: { kind: 'context' } },
  // Блок-запрос он же блок-ссылка: подшивается к конспекту напрямую.
  { id: 'e-root-main', source: 'b-root', target: 's-main', data: { kind: 'cite', order: 0 } },
  { id: 'e-atomics-main', source: 'b-atomics', target: 's-main', data: { kind: 'cite', order: 1 } },
]

export const PROJECT_SOURCES = [
  { title: 'Java Concurrency in Practice', lang: 'en' as const, format: 'PDF', locators: 'pages' },
  { title: 'C++ Concurrency in Action', lang: 'en' as const, format: 'EPUB', locators: 'sections' },
  { title: 'Rust Atomics and Locks', lang: 'en' as const, format: 'site', locators: 'URL' },
  { title: 'プログラマのための並行処理入門', lang: 'ja' as const, format: 'PDF', locators: 'pages' },
]
