// Модель данных прототипа. Намеренно графовая: канвас — лишь одно из её представлений.
//
// Метафора читального зала:
//   блок-запрос   — поручение библиотекарю и принесённые им выписки; он же блок-ссылка,
//                   поэтому подшивается к конспекту напрямую
//   блок-конспект — лист, который пишет сам читатель

/** Локатор полиморфен: у PDF/DJVU есть настоящие страницы, у EPUB/FB2 — нет. */
export type Locator =
  | { kind: 'page'; page: number }
  | { kind: 'section'; section: string; paragraph: number }
  | { kind: 'url'; url: string; anchor?: string }

export type SourceLang = 'en' | 'ja'

/** Решение модели не финально: находку принимает или отклоняет человек. */
export type FindingStatus = 'pending' | 'accepted' | 'rejected' | 'pinned'

export interface Finding {
  id: string
  /** Книга-источник в индексе; используется стрелкой «narrow scope» для сужения поиска. */
  docId?: number
  sourceTitle: string
  sourceLang: SourceLang
  locator: Locator
  excerpt: string
  /** Почему модель сочла фрагмент релевантным. */
  why: string
  status: FindingStatus
}

/** Состояние заметки как сохранённого запроса. */
export type NoteState = 'empty' | 'running' | 'fresh' | 'stale' | 'nothing'

export interface Note {
  id: string
  question: string
  state: NoteState
  summary?: string
  findings: Finding[]
}

export interface QueryData extends Record<string, unknown> {
  title: string
  notes: Note[]
  collapsed: boolean
}

export interface SynopsisData extends Record<string, unknown> {
  title: string
  text: string
  collapsed: boolean
}

export type NodeKind = 'query' | 'synopsis'

/**
 * Что передаётся по стрелке.
 *  context / narrow — между блоками-запросами, влияют на промпт
 *  cite             — подшивка блока-запроса к конспекту
 */
export type EdgeKind = 'context' | 'narrow' | 'cite'

export interface EdgeData extends Record<string, unknown> {
  kind: EdgeKind
  /** Порядок ссылки внутри конспекта; только для cite. */
  order?: number
}

export const EDGE_LABEL: Record<EdgeKind, string> = {
  context: 'context',
  narrow: 'narrow scope',
  cite: 'cite',
}

/**
 * Порты именованные и с двух сторон: конспект нередко стоит слева от запросов,
 * и без второго порта стрелка идёт петлёй через весь канвас.
 */
export const HANDLE = {
  queryIn: 'q-in',
  queryOut: 'q-out',
  queryOutLeft: 'q-out-l',
  synopsisInLeft: 's-in-l',
  synopsisInRight: 's-in-r',
} as const

/** Старые файлы проектов и ручные правки могут не содержать портов — подставляем. */
export function defaultHandles(kind: EdgeKind): { sourceHandle: string; targetHandle: string } {
  return kind === 'cite'
    ? { sourceHandle: HANDLE.queryOut, targetHandle: HANDLE.synopsisInLeft }
    : { sourceHandle: HANDLE.queryOut, targetHandle: HANDLE.queryIn }
}

export function formatLocator(l: Locator): string {
  switch (l.kind) {
    case 'page':
      return `p. ${l.page}`
    case 'section':
      return `${l.section} · ¶${l.paragraph}`
    case 'url':
      return l.anchor ? `${l.url}#${l.anchor}` : l.url
  }
}

export const STATUS_META: Record<FindingStatus, { icon: string; label: string }> = {
  pending: { icon: '•', label: 'unreviewed' },
  accepted: { icon: '✓', label: 'accepted' },
  rejected: { icon: '✗', label: 'dismissed' },
  pinned: { icon: '📌', label: 'pinned' },
}

/** По стрелкам вниз уходят только находки, одобренные человеком. */
export function isPropagated(s: FindingStatus): boolean {
  return s === 'accepted' || s === 'pinned'
}
