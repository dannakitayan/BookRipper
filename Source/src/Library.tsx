import { useCallback, useEffect, useState } from 'react'
import { api, type CrawlEvent, type IndexEvent, type LibraryFile, type SourceInfo } from './api'

export default function Library({
  project,
  sources,
  onDone,
}: {
  project: string
  sources: SourceInfo[]
  onDone: () => void
}) {
  const [files, setFiles] = useState<LibraryFile[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [indexing, setIndexing] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const [crawlUrl, setCrawlUrl] = useState('')
  const [crawlMaxPages, setCrawlMaxPages] = useState(40)
  const [crawling, setCrawling] = useState(false)
  const [crawlLog, setCrawlLog] = useState<string[]>([])

  const refreshFiles = useCallback(() => {
    api.library().then(setFiles).catch(() => setError('Cannot reach the backend.'))
  }, [])

  useEffect(() => {
    refreshFiles()
  }, [refreshFiles])

  const indexedTitles = new Set(sources.map((s) => s.title))

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const selectAll = () => setSelected(new Set(files.map((f) => f.path)))
  const selectNone = () => setSelected(new Set())

  const runIndex = async () => {
    if (!selected.size) return
    setIndexing(true)
    setLog([])
    setError(null)
    try {
      await api.indexProject(project, [...selected], (e: IndexEvent) => {
        if (e.stage === 'parsing') {
          setLog((l) => [...l, `Parsing ${e.file ?? ''}…`])
        } else if (e.stage === 'chunked') {
          setLog((l) => [...l, `  ${e.chunks} chunks (${e.lang})`])
        } else if (e.stage === 'embedding') {
          setLog((l) => [...l, `  Embedding ${e.file}…`])
        } else if (e.stage === 'done') {
          setLog((l) => [...l, `  Done: ${e.file} (${e.chunks} chunks)`])
        } else if (e.stage === 'skipped') {
          setLog((l) => [...l, `Skipped ${e.file} (already indexed)`])
        } else if (e.stage === 'failed') {
          setLog((l) => [...l, `Failed: ${e.file} — ${e.error}`])
        } else if (e.stage === 'finished') {
          setLog((l) => [...l, `Done — ${e.total_chunks ?? 0} total chunks in the index.`])
        }
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Indexing failed')
    } finally {
      setIndexing(false)
    }
  }

  const runCrawl = async () => {
    const url = crawlUrl.trim()
    if (!url) return
    setCrawling(true)
    setCrawlLog([])
    try {
      await api.crawl(url, { maxPages: crawlMaxPages }, (e: CrawlEvent) => {
        if (e.stage === 'fetching') {
          setCrawlLog((l) => [...l, `Fetching ${e.url}…`])
        } else if (e.stage === 'saved') {
          setCrawlLog((l) => [...l, `  Saved: ${e.title ?? e.url}`])
        } else if (e.stage === 'skipped') {
          setCrawlLog((l) => [...l, `  Skipped ${e.url} — no extractable content`])
        } else if (e.stage === 'failed') {
          setCrawlLog((l) => [...l, `  Failed ${e.url} — ${e.error}`])
        } else if (e.stage === 'finished') {
          setCrawlLog((l) => [...l, `Crawled ${e.pages} pages, saved ${e.saved}.`])
        } else if (e.stage === 'done') {
          setCrawlLog((l) => [...l, `Added ${e.files?.length ?? 0} files to Books/Web/.`])
          refreshFiles()
        } else if (e.stage === 'error') {
          setCrawlLog((l) => [...l, `Error: ${e.error}`])
        }
      })
    } catch (err) {
      setCrawlLog((l) => [...l, err instanceof Error ? err.message : 'Crawl failed'])
    } finally {
      setCrawling(false)
    }
  }

  const fmtSize = (b: number) =>
    b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`

  return (
    <div className="library-overlay" onClick={onDone}>
      <div className="library" onClick={(e) => e.stopPropagation()}>
        <div className="library__head">
          <h2>Library — {project}</h2>
          <button className="library__close" onClick={onDone}>×</button>
        </div>

        {error && <p className="library__error">{error}</p>}

        <div className="library__section">
          <h3>Indexed sources</h3>
          {sources.length === 0 && <p className="library__hint">Nothing indexed yet.</p>}
          <ul className="library__sources">
            {sources.map((s) => (
              <li key={s.id}>
                <span className={`lang lang--${s.lang}`}>{s.lang}</span>
                <span className="library__src-title">{s.title}</span>
                <span className="library__src-meta">
                  {s.format} · {s.chunks} chunks{s.pages ? ` · ${s.pages} p.` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="library__section">
          <h3>Crawl a documentation site</h3>
          <div className="library__crawl">
            <input
              className="library__crawl-url"
              type="text"
              placeholder="https://docs.example.com/guide/"
              value={crawlUrl}
              onChange={(e) => setCrawlUrl(e.target.value)}
              disabled={crawling}
            />
            <input
              className="library__crawl-pages"
              type="number"
              min={1}
              max={200}
              value={crawlMaxPages}
              onChange={(e) => setCrawlMaxPages(Number(e.target.value) || 1)}
              disabled={crawling}
              title="max pages"
            />
            <button onClick={runCrawl} disabled={crawling || !crawlUrl.trim()}>
              {crawling ? 'Crawling…' : 'Crawl'}
            </button>
          </div>
          {crawlLog.length > 0 && (
            <pre className="library__log-inline">{crawlLog.join('\n')}</pre>
          )}
        </div>

        <div className="library__section">
          <h3>
            Books in Books/ folder
            <span className="library__count">{files.length} files</span>
          </h3>
          <div className="library__toolbar">
            <button onClick={selectAll} disabled={indexing}>select all</button>
            <button onClick={selectNone} disabled={indexing}>select none</button>
            <button
              className="library__index-btn"
              onClick={runIndex}
              disabled={indexing || !selected.size}
            >
              {indexing ? 'Indexing…' : `Index ${selected.size} selected`}
            </button>
          </div>
          <ul className="library__files">
            {files.map((f) => (
              <li key={f.path} className={selected.has(f.path) ? 'selected' : ''}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(f.path)}
                    onChange={() => toggle(f.path)}
                    disabled={indexing}
                  />
                  <span className="library__file-name">{f.name}</span>
                  <span className="library__file-meta">
                    {f.format} · {fmtSize(f.size)}
                  </span>
                </label>
              </li>
            ))}
            {files.length === 0 && (
              <li className="library__hint">
                No books found. Place EPUB, FB2, PDF, or DJVU files into the Books/ folder.
              </li>
            )}
          </ul>
        </div>

        {log.length > 0 && (
          <div className="library__log">
            <h3>Indexing log</h3>
            <pre>{log.join('\n')}</pre>
          </div>
        )}
      </div>
    </div>
  )
}
