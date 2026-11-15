import type { Finding, Locator } from './types'

/**
 * Клиент бэкенда. Бэкенд слушает IPv4 намеренно — на Windows имя localhost
 * сперва резолвится в ::1, и каждый запрос платит за откат.
 */
export const API_BASE = import.meta.env.VITE_API ?? 'http://127.0.0.1:8008'

export interface ProjectInfo {
  name: string
  path: string
  chunks: number
  blocks: number
  sources: SourceInfo[]
  updated_at: string | null
}

export interface SourceInfo {
  id: number
  title: string
  lang: 'en' | 'ja'
  format: string
  pages: number | null
  needs_ocr: boolean
  chunks: number
  warnings: string[]
}

export interface Health {
  ok: boolean
  ollama: string
  ollama_reachable: boolean
  ollama_error: string | null
  models: string[]
  embed_model: string
  embed_ready: boolean
  filter_model: string
  synth_model: string
  books_dir: string
}

export interface AskEvent {
  stage:
    | 'expanding'
    | 'expanded'
    | 'retrieved'
    | 'filtered'
    | 'filter_failed'
    | 'kept'
    | 'deepening'
    | 'summarising'
    | 'finished'
    | 'error'
  queries?: string[]
  candidates?: number
  done?: number
  total?: number
  kept?: number
  summary?: string
  findings?: ApiFinding[]
  error?: string
}

export interface ApiFinding {
  chunk_id: number
  docId: number
  sourceTitle: string
  sourceLang: 'en' | 'ja'
  locator: Locator
  excerpt: string
  why: string
  kind: 'text' | 'code'
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}`)
  return (await res.json()) as T
}

export interface LibraryFile {
  path: string
  name: string
  format: string
  size: number
}

export interface IndexEvent {
  stage: string
  file?: string
  title?: string
  chunks?: number
  lang?: string
  skipped?: boolean
  error?: string
  results?: Record<string, unknown>[]
  documents?: number
  total_chunks?: number
}

export interface CrawlEvent {
  stage: 'fetching' | 'saved' | 'skipped' | 'failed' | 'finished' | 'done' | 'error'
  url?: string
  file?: string
  title?: string
  error?: string
  pages?: number
  saved?: number
  files?: string[]
}

export const api = {
  health: () => json<Health>('/health'),

  updateSettings: (filterModel: string, synthModel: string) =>
    json<{ filter_model: string; synth_model: string }>('/settings', {
      method: 'PUT',
      body: JSON.stringify({ filter_model: filterModel, synth_model: synthModel }),
    }),

  library: () =>
    json<{ books_dir: string; files: LibraryFile[] }>('/library').then((d) => d.files),

  async crawl(
    url: string,
    opts: { maxPages?: number; sameDomain?: boolean },
    onEvent: (e: CrawlEvent) => void,
  ): Promise<CrawlEvent | null> {
    const res = await fetch(`${API_BASE}/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        max_pages: opts.maxPages ?? 40,
        same_domain: opts.sameDomain ?? true,
      }),
    })
    if (!res.ok || !res.body) throw new Error(`crawl → ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let last: CrawlEvent | null = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line) as CrawlEvent
        last = event
        onEvent(event)
      }
    }
    return last
  },

  async indexProject(
    project: string,
    files: string[],
    onEvent: (e: IndexEvent) => void,
  ): Promise<IndexEvent | null> {
    const res = await fetch(
      `${API_BASE}/projects/${encodeURIComponent(project)}/index`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files, force: false }),
      },
    )
    if (!res.ok || !res.body) throw new Error(`index → ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let last: IndexEvent | null = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line) as IndexEvent
        last = event
        onEvent(event)
      }
    }
    return last
  },

  deleteSource: (project: string, id: number) =>
    json<{ deleted: number }>(
      `/projects/${encodeURIComponent(project)}/sources/${id}`,
      { method: 'DELETE' },
    ),

  projects: () => json<{ projects: ProjectInfo[] }>('/projects').then((d) => d.projects),

  createProject: (name: string) =>
    json<ProjectInfo>('/projects', { method: 'POST', body: JSON.stringify({ name }) }),

  deleteProject: (name: string) =>
    json<{ deleted: string }>(`/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  readCanvas: (project: string) =>
    json<{ nodes?: unknown[]; edges?: unknown[] }>(`/projects/${encodeURIComponent(project)}/canvas`),

  writeCanvas: (project: string, canvas: unknown) =>
    json<{ saved: boolean }>(`/projects/${encodeURIComponent(project)}/canvas`, {
      method: 'PUT',
      body: JSON.stringify(canvas),
    }),

  renameSource: (project: string, id: number, title: string) =>
    json<{ id: number; title: string }>(
      `/projects/${encodeURIComponent(project)}/sources/${id}`,
      { method: 'PATCH', body: JSON.stringify({ title }) },
    ),

  /** Поток событий: цикл идёт десятки секунд, и прогресс важнее ожидания. */
  async ask(
    project: string,
    question: string,
    opts: {
      contextTerms?: string[]
      candidates?: number
      keep?: number
      summary?: boolean
      deeper?: boolean
      excludeIds?: number[]
      scopeDocIds?: number[]
    },
    onEvent: (e: AskEvent) => void,
  ): Promise<AskEvent | null> {
    const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        context_terms: opts.contextTerms ?? [],
        candidates: opts.candidates ?? 24,
        keep: opts.keep ?? 8,
        summary: opts.summary ?? true,
        deeper: opts.deeper ?? false,
        exclude_ids: opts.excludeIds ?? [],
        scope_doc_ids: opts.scopeDocIds ?? [],
      }),
    })
    if (!res.ok || !res.body) throw new Error(`ask → ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let last: AskEvent | null = null

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line) as AskEvent
        last = event
        onEvent(event)
      }
    }
    return last
  },
}

/** Находка бэкенда в форме канваса. Статус всегда «не размечено»: решает человек. */
export function toFinding(f: ApiFinding): Finding {
  return {
    id: `f-${f.chunk_id}`,
    docId: f.docId,
    sourceTitle: f.sourceTitle,
    sourceLang: f.sourceLang,
    locator: f.locator,
    excerpt: f.excerpt,
    why: f.why,
    status: 'pending',
  }
}
