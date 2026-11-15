import {
  acceptedFindingsOf,
  citationsOf,
  inheritedContext,
  inheritedTerms,
  isSynopsis,
  type AnyEdge,
  type AnyNode,
} from './graph'
import type { SourceInfo } from './api'
import { EDGE_LABEL, formatLocator } from './types'

export default function Inspector({
  nodes,
  edges,
  selectedId,
  sources,
  onRenameSource,
}: {
  nodes: AnyNode[]
  edges: AnyEdge[]
  selectedId: string | null
  sources: SourceInfo[]
  onRenameSource: (id: number, title: string) => void
}) {
  const selected = nodes.find((n) => n.id === selectedId) ?? null
  const inherited = selected ? inheritedContext(nodes, edges, selected.id) : []
  const terms = inheritedTerms(inherited)
  const narrowed = inherited.some((i) => i.kind === 'narrow')
  const cites = selected && isSynopsis(selected) ? citationsOf(nodes, edges, selected.id) : []

  const name = selected ? selected.data.title || 'Untitled' : null

  return (
    <aside className="inspector">
      <section className="panel">
        <h2>Project sources</h2>
        {!sources.length && (
          <p className="panel__hint">
            Nothing indexed yet. Put books into Books/ and index them into this project.
          </p>
        )}
        <ul className="sources">
          {sources.map((s) => (
            <li key={s.id}>
              <span className={`lang lang--${s.lang}`}>{s.lang}</span>
              <button
                className="sources__title sources__rename"
                title={`${s.title}

click to rename`}
                onClick={() => {
                  const next = window.prompt('Source title', s.title)?.trim()
                  if (next && next !== s.title) onRenameSource(s.id, next)
                }}
              >
                {s.title}
              </button>
              <span className="sources__fmt">
                {s.format}
                {s.pages ? ` · ${s.pages} p.` : ''} · {s.chunks} ch.
                {s.needs_ocr ? ' · scan' : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Selected block</h2>
        {!selected && <p className="panel__hint">Pick a block on the canvas.</p>}

        {selected && (
          <>
            <h3 className="panel__name">{name}</h3>

            {isSynopsis(selected) && (
              <>
                <p className="panel__hint">Cited references: {cites.length}</p>
                <ol className="inherited">
                  {cites.map((c) => (
                    <li key={c.edgeId}>
                      <div className="inherited__head">
                        <span className="inherited__from">{c.query.data.title}</span>
                      </div>
                      {acceptedFindingsOf(c.query).map((f) => (
                        <div key={f.id} className="inherited__src">
                          {f.sourceTitle} · {formatLocator(f.locator)}
                        </div>
                      ))}
                      {!acceptedFindingsOf(c.query).length && (
                        <div className="inherited__src inherited__src--muted">
                          no accepted findings
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </>
            )}

            {!isSynopsis(selected) && (
              <>
                <p className="panel__hint">
                  Inherited via arrows: {inherited.length} accepted findings
                  {narrowed && ' · scope narrowed by ancestors'}
                </p>

                {!!terms.length && (
                  <div className="terms">
                    <span className="terms__label">Query is expanded with terms:</span>
                    {terms.map((t) => (
                      <code key={t}>{t}</code>
                    ))}
                  </div>
                )}

                <ul className="inherited">
                  {inherited.map(({ fromBlock, kind, finding }) => (
                    <li key={finding.id}>
                      <div className="inherited__head">
                        <span className={`tag tag--${kind}`}>{EDGE_LABEL[kind]}</span>
                        <span className="inherited__from">{fromBlock}</span>
                      </div>
                      <div className="inherited__src">
                        {finding.sourceTitle} · {formatLocator(finding.locator)}
                      </div>
                    </li>
                  ))}
                </ul>

                {!inherited.length && (
                  <p className="panel__hint">
                    No ancestors, or their findings are not accepted yet — nothing goes into the
                    prompt.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </section>

    </aside>
  )
}
