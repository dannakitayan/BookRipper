import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { api, toFinding, type Health, type ProjectInfo } from './api'
import Inspector from './Inspector'
import Library from './Library'
import LabeledEdge from './LabeledEdge'
import Outline, { type CiteOps } from './Outline'
import QueryNodeView from './QueryNode'
import Settings from './Settings'
import SynopsisNodeView from './SynopsisNode'
import { ActionsContext, type Actions } from './actions'
import {
  acceptedFindingsOf,
  citationList,
  citationsOf,
  inheritedContext,
  inheritedScopeDocIds,
  inheritedTerms,
  synopsesOf,
  isQuery,
  isSynopsis,
  layered,
  wouldCreateCycle,
  type AnyEdge,
  type AnyNode,
  type QueryNode,
} from './graph'
import { useHistory, type Snapshot } from './history'
import { toMarkdown } from './markdown'
import { initialEdges, initialNodes } from './mockData'
import {
  defaultHandles,
  isPropagated,
  type EdgeKind,
  type FindingStatus,
  type Note,
  type NoteState,
} from './types'

const nodeTypes = { query: QueryNodeView, synopsis: SynopsisNodeView }
const edgeTypes = { labeled: LabeledEdge }

const EDGE_COLOR: Record<EdgeKind, string> = {
  context: '#2f81f7',
  narrow: '#d29922',
  cite: '#3fb950',
}

/** Вид ребра зависит от того, что по нему передаётся. */
function decorate(e: AnyEdge): AnyEdge {
  const kind: EdgeKind = e.data?.kind ?? 'context'
  const color = EDGE_COLOR[kind]
  const fallback = defaultHandles(kind)
  return {
    ...e,
    // Порты обязательны: без них React Flow не находит геометрию и не рисует стрелку.
    sourceHandle: e.sourceHandle ?? fallback.sourceHandle,
    targetHandle: e.targetHandle ?? fallback.targetHandle,
    type: 'labeled',
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    animated: kind === 'context',
    style: { stroke: color, strokeWidth: 2, strokeDasharray: kind === 'narrow' ? '6 4' : undefined },
  }
}

let uid = 0
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${++uid}`

const STORAGE_KEY = 'bookripper.project.v3'

interface Saved {
  nodes: AnyNode[]
  edges: AnyEdge[]
}

/** Канвас живёт в памяти вкладки, поэтому состояние переживаем в localStorage. */
function loadSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Saved>
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null
    return { nodes: parsed.nodes, edges: parsed.edges }
  } catch {
    return null
  }
}

const restored = loadSaved()

export default function App() {
  const [nodes, setNodes] = useState<AnyNode[]>(restored?.nodes ?? initialNodes)
  const [edges, setEdges] = useState<AnyEdge[]>((restored?.edges ?? initialEdges).map(decorate))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [legendOpen, setLegendOpen] = useState(true)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [project, setProject] = useState<string | null>(
    () => localStorage.getItem('bookripper.project.name'),
  )
  const [health, setHealth] = useState<Health | null>(null)
  const [progress, setProgress] = useState<Record<string, string>>({})
  const rf = useRef<ReactFlowInstance<AnyNode, AnyEdge> | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  // Куда ставить маркер цитаты: последняя позиция курсора в каждом конспекте.
  const carets = useRef<Record<string, number>>({})
  const switching = useRef(false)

  // Сохраняем с задержкой: набор текста в конспекте иначе пишет в хранилище на каждую букву.
  useEffect(() => {
    if (switching.current) return
    const t = window.setTimeout(() => {
      if (switching.current) return
      const payload: Saved = {
        nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data }) as AnyNode),
        edges: edges.map(({ id, source, target, sourceHandle, targetHandle, data }) => ({
          id,
          source,
          target,
          sourceHandle,
          targetHandle,
          data,
        })),
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
      } catch {
        /* приватный режим или переполнение — молча работаем без сохранения */
      }
      if (project) void api.writeCanvas(project, { version: 3, ...payload }).catch(() => undefined)
    }, 500)
    return () => window.clearTimeout(t)
  }, [nodes, edges, project])

  const refreshHealth = useCallback(() => {
    void api.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  useEffect(() => {
    void api
      .projects()
      .then((list) => {
        setProjects(list)
        setProject((current) => current ?? list[0]?.name ?? null)
      })
      .catch(() => setProjects([]))
    refreshHealth()
    // Бэкенд или Ollama могут упасть/подняться между запусками заметок — проверяем периодически.
    const t = window.setInterval(refreshHealth, 15000)
    return () => window.clearInterval(t)
  }, [refreshHealth])

  // Канвас проекта лежит в его папке: Projects/<name>/project.json.
  useEffect(() => {
    if (!project) return
    localStorage.setItem('bookripper.project.name', project)
    switching.current = true
    let cancelled = false
    void api
      .readCanvas(project)
      .then((canvas) => {
        if (cancelled) return
        const loaded = (canvas.nodes ?? []) as AnyNode[]
        setNodes(loaded)
        setEdges(((canvas.edges ?? []) as AnyEdge[]).map(decorate))
        setSelectedId(null)
      })
      .catch(() => {
        if (cancelled) return
        setNodes([])
        setEdges([])
        setSelectedId(null)
      })
      .finally(() => {
        if (!cancelled) switching.current = false
      })
    return () => {
      cancelled = true
      switching.current = false
    }
  }, [project])

  const say = useCallback((m: string) => {
    setToast(m)
    window.setTimeout(() => setToast(null), 3200)
  }, [])

  const applySnapshot = useCallback((snap: Snapshot) => {
    setNodes(snap.nodes)
    setEdges(snap.edges.map(decorate))
  }, [])

  const { undo, redo, canUndo, canRedo } = useHistory(nodes, edges, applySnapshot)

  // Внутри полей ввода Ctrl+Z обязан откатывать текст, а не канвас.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const onNodesChange = useCallback(
    (changes: NodeChange<AnyNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange<AnyEdge>[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    [],
  )

  /** Тип связи выводится из сортов блоков, а не выбирается вручную. */
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return
      const src = nodes.find((n) => n.id === c.source)
      const dst = nodes.find((n) => n.id === c.target)
      if (!src || !dst) return

      if (isSynopsis(src)) {
        say('A synopsis is the reader’s own sheet: arrows do not start from it.')
        return
      }
      const kind: EdgeKind = isSynopsis(dst) ? 'cite' : 'context'

      setEdges((es) => {
        if (es.some((e) => e.source === c.source && e.target === c.target)) {
          say('That link already exists.')
          return es
        }
        if (kind !== 'cite' && wouldCreateCycle(es, c.source!, c.target!)) {
          say('That link would create a cycle — collecting ancestor context would never end.')
          return es
        }
        const order =
          kind === 'cite'
            ? es.filter((e) => e.data?.kind === 'cite' && e.target === c.target).length
            : undefined
        return [
          ...es,
          decorate({ ...c, id: newId('e'), data: { kind, ...(order !== undefined && { order }) } }),
        ]
      })
    },
    [nodes, say],
  )

  /** Клик по стрелке переключает смысл: контекст и сужение области. Подшивку не трогаем. */
  const onEdgeClick = useCallback(
    (_: unknown, edge: AnyEdge) => {
      if (edge.data?.kind === 'cite') {
        say('This is a citation into a synopsis — its type does not change.')
        return
      }
      setEdges((es) =>
        es.map((e) =>
          e.id === edge.id
            ? decorate({
                ...e,
                data: { ...e.data, kind: e.data?.kind === 'narrow' ? 'context' : 'narrow' },
              })
            : e,
        ),
      )
    },
    [say],
  )

  const onSelectionChange = useCallback(({ nodes: sel }: OnSelectionChangeParams) => {
    setSelectedId(sel.length === 1 ? sel[0].id : null)
  }, [])

  const patchNode = useCallback(
    (id: string, fn: (n: AnyNode) => AnyNode) =>
      setNodes((ns) => ns.map((n) => (n.id === id ? fn(n) : n))),
    [],
  )

  /** Правка заметок внутри блока-запроса: конспекты не трогаем. */
  const patchNotes = useCallback(
    (blockId: string, fn: (notes: Note[]) => Note[]) =>
      patchNode(blockId, (n) =>
        isQuery(n) ? { ...n, data: { ...n.data, notes: fn(n.data.notes) } } : n,
      ),
    [patchNode],
  )

  const actions = useMemo<Actions>(
    () => ({
      toggleCollapse: (id) =>
        patchNode(id, (n) => {
          if (isQuery(n)) return { ...n, data: { ...n.data, collapsed: !n.data.collapsed } }
          if (isSynopsis(n)) return { ...n, data: { ...n.data, collapsed: !n.data.collapsed } }
          return n
        }),

      renameBlock: (id, title) =>
        patchNode(id, (n) => {
          if (isQuery(n)) return { ...n, data: { ...n.data, title } }
          if (isSynopsis(n)) return { ...n, data: { ...n.data, title } }
          return n
        }),

      deleteBlock: (id) => {
        setNodes((ns) => ns.filter((n) => n.id !== id))
        // Запросы переживают свой конспект: удаляем только связи, не узлы.
        setEdges((es) => es.filter((e) => e.source !== id && e.target !== id))
      },

      editSynopsis: (id, text) =>
        patchNode(id, (n) => (isSynopsis(n) ? { ...n, data: { ...n.data, text } } : n)),

      progressByNote: progress,

      deleteEdge: (edgeId) => setEdges((es) => es.filter((e) => e.id !== edgeId)),

      rememberCaret: (synopsisId, pos) => {
        carets.current[synopsisId] = pos
      },

      /**
       * Выписка попадает в текст конспекта маркером [n].
       * Вставка — это и есть принятие: непринятую выписку заодно помечаем принятой.
       */
      insertCitation: (blockId, noteId, findingId) => {
        const targets = synopsesOf(edges, blockId)
        if (!targets.length) {
          say('Cite this reference into a synopsis first — drag an arrow to it.')
          return
        }
        const synopsisId = targets[0]

        setNodes((ns) => {
          const accepted = ns.map((n) => {
            if (n.id !== blockId || !isQuery(n)) return n
            return {
              ...n,
              data: {
                ...n.data,
                notes: n.data.notes.map((note) =>
                  note.id !== noteId
                    ? note
                    : {
                        ...note,
                        findings: note.findings.map((f) =>
                          f.id === findingId && !isPropagated(f.status)
                            ? { ...f, status: 'accepted' as const }
                            : f,
                        ),
                      },
                ),
              },
            }
          })

          const hit = citationList(accepted, edges, synopsisId).find(
            (c) => c.finding.id === findingId,
          )
          if (!hit) return accepted

          return accepted.map((n) => {
            if (n.id !== synopsisId || !isSynopsis(n)) return n
            const text = n.data.text
            const at = Math.min(carets.current[synopsisId] ?? text.length, text.length)
            const marker = `[${hit.n}]`
            return { ...n, data: { ...n.data, text: text.slice(0, at) + marker + text.slice(at) } }
          })
        })

        const title = nodes.find((n) => n.id === synopsisId)?.data.title
        say(`Citation inserted into “${title || 'Untitled'}”.`)
      },

      editQuestion: (blockId, noteId, question) =>
        patchNotes(blockId, (notes) =>
          notes.map((note) =>
            note.id === noteId
              ? { ...note, question, state: note.findings.length ? 'stale' : note.state }
              : note,
          ),
        ),

      addNote: (blockId) =>
        patchNotes(blockId, (notes) => [
          ...notes,
          { id: newId('n'), question: '', state: 'empty', findings: [] },
        ]),

      deleteNote: (blockId, noteId) =>
        patchNotes(blockId, (notes) => notes.filter((x) => x.id !== noteId)),

      runNote: (blockId, noteId) => {
        const patch = (fn: (n: Note) => Note) =>
          patchNotes(blockId, (notes) => notes.map((x) => (x.id === noteId ? fn(x) : x)))
        const mark = (state: NoteState) => patch((n) => ({ ...n, state }))

        const block = nodes.find((n) => n.id === blockId)
        const question = isQuery(block ?? ({} as AnyNode))
          ? (block as QueryNode).data.notes.find((n) => n.id === noteId)?.question ?? ''
          : ''
        if (!question.trim()) {
          say('Write the question first.')
          return
        }
        if (!project) {
          say('Pick a project first — the index lives in it.')
          return
        }
        if (!health) {
          say('Backend server is not running — open settings for how to start it.')
          return
        }
        if (!health.ollama_reachable) {
          say(`Ollama is not reachable at ${health.ollama} — open settings to check it.`)
          return
        }

        // Термины принятых выписок предков: ровно это и передаёт стрелка «контекст».
        const inherited = inheritedContext(nodes, edges, blockId)
        const contextTerms = inheritedTerms(inherited)
        // Стрелка «narrow scope» сужает поиск до книг предков, соединённых ею напрямую.
        const scopeDocIds = inheritedScopeDocIds(inherited)

        mark('running')
        setProgress((p) => ({ ...p, [noteId]: 'expanding the query…' }))

        void api
          .ask(project, question, { contextTerms, scopeDocIds }, (e) => {
            const line =
              e.stage === 'expanded'
                ? `searching: ${(e.queries ?? []).length} phrasings`
                : e.stage === 'retrieved'
                  ? `reviewing ${e.candidates} candidates…`
                  : e.stage === 'filtered'
                    ? `reviewing ${e.done}/${e.total}, kept ${e.kept}`
                    : e.stage === 'deepening'
                      ? 'few results — widening search…'
                      : e.stage === 'summarising'
                        ? 'writing the summary…'
                        : ''
            if (line) setProgress((p) => ({ ...p, [noteId]: line }))
          })
          .then((last) => {
            setProgress((p) => {
              const { [noteId]: _drop, ...rest } = p
              return rest
            })
            if (!last || last.stage === 'error') {
              mark('stale')
              say(`Search failed: ${last?.error ?? 'no response'}`)
              return
            }
            const findings = (last.findings ?? []).map(toFinding)
            patch((n) => ({
              ...n,
              findings,
              summary: last.summary || undefined,
              // Ноль находок — это «ничего не нашлось», а не «актуально».
              state: findings.length ? 'fresh' : 'nothing',
            }))
            say(
              findings.length
                ? `Found ${findings.length} excerpts out of ${last.candidates} candidates.`
                : 'Nothing in these books answers that question.',
            )
          })
          .catch((err: unknown) => {
            setProgress((p) => {
              const { [noteId]: _drop, ...rest } = p
              return rest
            })
            mark('stale')
            say(`Backend unreachable: ${err instanceof Error ? err.message : 'unknown error'}`)
          })
      },

      deeperNote: (blockId, noteId) => {
        const patch = (fn: (n: Note) => Note) =>
          patchNotes(blockId, (notes) => notes.map((x) => (x.id === noteId ? fn(x) : x)))
        const mark = (state: NoteState) => patch((n) => ({ ...n, state }))

        const block = nodes.find((n) => n.id === blockId)
        const note = isQuery(block ?? ({} as AnyNode))
          ? (block as QueryNode).data.notes.find((n) => n.id === noteId)
          : undefined
        if (!note?.question.trim()) {
          say('Write the question first.')
          return
        }
        if (!project) {
          say('Pick a project first.')
          return
        }
        if (!health) {
          say('Backend server is not running — open settings for how to start it.')
          return
        }
        if (!health.ollama_reachable) {
          say(`Ollama is not reachable at ${health.ollama} — open settings to check it.`)
          return
        }

        const inherited = inheritedContext(nodes, edges, blockId)
        const contextTerms = inheritedTerms(inherited)
        const scopeDocIds = inheritedScopeDocIds(inherited)
        const excludeIds = note.findings.map((f) => parseInt(f.id.replace('f-', ''), 10)).filter(Number.isFinite)

        mark('running')
        setProgress((p) => ({ ...p, [noteId]: 'deeper search…' }))

        void api
          .ask(project, note.question, { contextTerms, deeper: true, excludeIds, scopeDocIds }, (e) => {
            const line =
              e.stage === 'expanded'
                ? `deep: ${(e.queries ?? []).length} phrasings`
                : e.stage === 'retrieved'
                  ? `deep: reviewing ${e.candidates} candidates…`
                  : e.stage === 'filtered'
                    ? `deep: ${e.done}/${e.total}, kept ${e.kept}`
                    : e.stage === 'deepening'
                      ? 'widening search…'
                      : e.stage === 'summarising'
                        ? 'rewriting the summary…'
                        : ''
            if (line) setProgress((p) => ({ ...p, [noteId]: line }))
          })
          .then((last) => {
            setProgress((p) => {
              const { [noteId]: _drop, ...rest } = p
              return rest
            })
            if (!last || last.stage === 'error') {
              mark('stale')
              say(`Deep search failed: ${last?.error ?? 'no response'}`)
              return
            }
            const newFindings = (last.findings ?? []).map(toFinding)
            patch((n) => {
              const existingIds = new Set(n.findings.map((f) => f.id))
              const added = newFindings.filter((f) => !existingIds.has(f.id))
              return {
                ...n,
                findings: [...n.findings, ...added],
                summary: last.summary || n.summary,
                state: (n.findings.length + added.length) ? 'fresh' : 'nothing',
              }
            })
            const added = newFindings.length
            say(
              added
                ? `Deep search found ${added} more excerpts.`
                : 'Deep search found nothing new.',
            )
          })
          .catch((err: unknown) => {
            setProgress((p) => {
              const { [noteId]: _drop, ...rest } = p
              return rest
            })
            mark('stale')
            say(`Backend unreachable: ${err instanceof Error ? err.message : 'unknown error'}`)
          })
      },

      setFindingStatus: (blockId, noteId, findingId, status: FindingStatus) =>
        patchNotes(blockId, (notes) =>
          notes.map((note) =>
            note.id !== noteId
              ? note
              : {
                  ...note,
                  findings: note.findings.map((f) => (f.id === findingId ? { ...f, status } : f)),
                },
          ),
        ),
    }),
    [edges, nodes, patchNode, patchNotes, progress, project, say],
  )

  const citeOps = useMemo<CiteOps>(
    () => ({
      unpin: (edgeId) => setEdges((es) => es.filter((e) => e.id !== edgeId)),

      move: (edgeId, synopsisId) =>
        setEdges((es) => {
          const target = es.find((e) => e.id === edgeId)
          if (!target || target.target === synopsisId) return es
          const order = es.filter((e) => e.data?.kind === 'cite' && e.target === synopsisId).length
          return es.map((e) =>
            e.id === edgeId
              ? decorate({
                  ...e,
                  target: synopsisId,
                  targetHandle: undefined,
                  data: { kind: 'cite', order },
                })
              : e,
          )
        }),

      reorder: (edgeId, dir) =>
        setEdges((es) => {
          const self = es.find((e) => e.id === edgeId)
          if (!self) return es
          const siblings = es
            .filter((e) => e.data?.kind === 'cite' && e.target === self.target)
            .sort((a, b) => (a.data?.order ?? 0) - (b.data?.order ?? 0))
          const i = siblings.findIndex((e) => e.id === edgeId)
          const j = i + dir
          if (i < 0 || j < 0 || j >= siblings.length) return es
          const reordered = [...siblings]
          ;[reordered[i], reordered[j]] = [reordered[j], reordered[i]]
          const orderById = new Map(reordered.map((e, k) => [e.id, k]))
          return es.map((e) =>
            orderById.has(e.id)
              ? decorate({ ...e, data: { ...e.data, kind: 'cite', order: orderById.get(e.id)! } })
              : e,
          )
        }),
    }),
    [],
  )

  const addQuery = () =>
    setNodes((ns) => [
      ...ns,
      {
        id: newId('b'),
        type: 'query' as const,
        position: { x: 60 + ns.length * 30, y: 60 + ns.length * 24 },
        data: { title: 'New topic', collapsed: false, notes: [] },
      },
    ])

  const addSynopsis = () =>
    setNodes((ns) => [
      ...ns,
      {
        id: newId('s'),
        type: 'synopsis' as const,
        position: { x: 900, y: 60 + ns.length * 40 },
        data: { title: 'New synopsis', collapsed: false, text: '' },
      },
    ])

  const focusNode = useCallback((id: string) => {
    const inst = rf.current
    const node = inst?.getNode(id)
    if (!inst || !node) return
    const w = node.measured?.width ?? 360
    const h = node.measured?.height ?? 200
    inst.setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: 1, duration: 400 })
  }, [])

  const exportJson = () => {
    const payload = {
      version: 3,
      nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })),
      edges: edges.map(({ id, source, target, sourceHandle, targetHandle, data }) => ({
        id,
        source,
        target,
        sourceHandle,
        targetHandle,
        data,
      })),
      outline: nodes.filter(isSynopsis).map((s) => ({
        title: s.data.title,
        text: s.data.text,
        citations: citationsOf(nodes, edges, s.id).map((c) => ({
          query: c.query.data.title,
          findings: acceptedFindingsOf(c.query).map((f) => ({
            source: f.sourceTitle,
            locator: f.locator,
            excerpt: f.excerpt,
          })),
        })),
      })),
    }
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = 'project.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportMarkdown = () => {
    const url = URL.createObjectURL(
      new Blob([toMarkdown(nodes, edges)], { type: 'text/markdown;charset=utf-8' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = 'research.md'
    a.click()
    URL.revokeObjectURL(url)
  }

  /** Загрузка выгруженного проекта; блоки старого сорта «ссылка» отбрасываются. */
  const importJson = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text()) as { nodes?: AnyNode[]; edges?: AnyEdge[] }
      if (!Array.isArray(raw.nodes)) throw new Error('no nodes array')

      const loadedNodes = raw.nodes.filter((n) => n.type === 'query' || n.type === 'synopsis')
      const dropped = raw.nodes.length - loadedNodes.length
      const alive = new Set(loadedNodes.map((n) => n.id))
      const loadedEdges = (raw.edges ?? []).filter(
        (e) => alive.has(e.source) && alive.has(e.target),
      )

      setNodes(loadedNodes)
      setEdges(loadedEdges.map(decorate))
      setSelectedId(null)
      window.setTimeout(() => rf.current?.fitView({ duration: 400 }), 80)
      say(
        dropped
          ? `Loaded. Blocks of the old separate "reference" kind dropped: ${dropped}.`
          : `Loaded: ${loadedNodes.length} blocks, ${loadedEdges.length} links.`,
      )
    } catch (err) {
      say(`Could not read the file: ${err instanceof Error ? err.message : 'parsing failed'}`)
    }
  }

  return (
    <ActionsContext.Provider value={actions}>
      <div className="app">
        <header className="topbar">
          <strong className="brand">BookRipper</strong>
          <select
            className="topbar__select"
            value={project ?? ''}
            onChange={(e) => setProject(e.target.value || null)}
            title="project — its folder holds the index and the canvas"
          >
            <option value="">no project</option>
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              const name = window.prompt('New project name')?.trim()
              if (!name) return
              void api
                .createProject(name)
                .then((p) => {
                  setProjects((list) => [...list, p])
                  setProject(p.name)
                  say(`Project created at ${p.path}`)
                })
                .catch((e: unknown) => say(`Could not create: ${String(e)}`))
            }}
          >
            + project
          </button>
          <button
            disabled={!project}
            title="delete this project — its index and canvas, not the books in Books/"
            onClick={() => {
              if (!project) return
              if (!window.confirm(`Delete project "${project}"? Its index and canvas are gone for good — the books in Books/ stay untouched.`)) {
                return
              }
              void api
                .deleteProject(project)
                .then(() => {
                  setProjects((list) => {
                    const rest = list.filter((p) => p.name !== project)
                    setProject(rest[0]?.name ?? null)
                    return rest
                  })
                  say(`Project "${project}" deleted.`)
                })
                .catch((e: unknown) => say(`Could not delete: ${String(e)}`))
            }}
          >
            delete project
          </button>
          <button
            className={`topbar__health ${health?.embed_ready ? 'ok' : 'bad'}`}
            onClick={() => setSettingsOpen(true)}
            title="AI connection and model settings"
          >
            {!health
              ? 'backend offline'
              : !health.ollama_reachable
                ? 'Ollama offline'
                : !health.embed_ready
                  ? 'embed model missing'
                  : `${projects.find((p) => p.name === project)?.sources.length ?? 0} sources · ${
                      projects.find((p) => p.name === project)?.chunks ?? 0
                    } chunks`}
          </button>
          <button onClick={() => setSettingsOpen(true)}>settings</button>
          <button onClick={() => setLibraryOpen(true)} disabled={!project}>
            library
          </button>
          <div className="topbar__spacer" />
          <button onClick={undo} disabled={!canUndo} title="undo (Ctrl+Z)">
            ↶
          </button>
          <button onClick={redo} disabled={!canRedo} title="redo (Ctrl+Shift+Z)">
            ↷
          </button>
          <button onClick={addSynopsis}>+ synopsis</button>
          <button onClick={addQuery}>+ reference</button>
          <button onClick={() => setNodes((ns) => layered(ns, edges))}>arrange</button>
          <button onClick={() => fileInput.current?.click()}>import JSON</button>
          <button
            onClick={() => {
              localStorage.removeItem(STORAGE_KEY)
              setNodes(initialNodes)
              setEdges(initialEdges.map(decorate))
              setSelectedId(null)
              say('Project reset to the demo contents.')
            }}
          >
            reset
          </button>
          <button onClick={exportJson}>export JSON</button>
          <button onClick={exportMarkdown}>export MD</button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importJson(f)
              e.target.value = ''
            }}
          />
        </header>

        <div className="main">
          <Outline
            nodes={nodes}
            edges={edges}
            citeOps={citeOps}
            onFocus={focusNode}
            onAddSynopsis={addSynopsis}
          />

          <div className="canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onEdgeClick={onEdgeClick}
              onSelectionChange={onSelectionChange}
              onInit={(i) => {
                rf.current = i
              }}
              colorMode="dark"
              fitView
              minZoom={0.2}
              /* Delete убирает выделенную связь; Backspace не трогаем — он нужен для набора. */
              deleteKeyCode={['Delete']}
              /*
               * Блоки по клавише не удаляем: только крестиком в заголовке.
               * Отменяем целиком — вместе с блоком React Flow забрал бы и его связи.
               */
              onBeforeDelete={async ({ nodes: toDelete, edges: edgesToDelete }) => {
                if (toDelete.length) {
                  say('Blocks are removed with the × in their header, so none is lost by accident.')
                  return false
                }
                return { nodes: [], edges: edgesToDelete }
              }}
              /* Узлы обмеряются через ResizeObserver: без видимого контейнера стрелок не будет. */
              onError={(code, msg) => console.warn('[React Flow]', code, msg)}
            >
              <Background gap={18} size={1} color="#21262d" />
              <MiniMap pannable zoomable nodeColor="#30363d" maskColor="rgba(1,4,9,0.7)" />
              <Controls position="top-left" />
            </ReactFlow>

            {/* Сворачивается: иначе перекрывает кнопки масштаба в углу канваса. */}
            {legendOpen ? (
              <div className="legend">
                <button
                  className="legend__fold"
                  title="hide the legend"
                  onClick={() => setLegendOpen(false)}
                >
                  ×
                </button>
                <span>
                  <i className="legend__ctx" /> context — accepted findings of ancestors go into the
                  prompt
                </span>
                <span>
                  <i className="legend__nar" /> narrow scope — search only where ancestors hit
                </span>
                <span>
                  <i className="legend__cite" /> citation into a synopsis
                </span>
                <span className="legend__tip">
                  click a blue or yellow arrow to switch its type · × on the label deletes the link
                </span>
              </div>
            ) : (
              <button className="legend__show" onClick={() => setLegendOpen(true)}>
                ? legend
              </button>
            )}

            {toast && <div className="toast">{toast}</div>}
          </div>

          <Inspector
            nodes={nodes}
            edges={edges}
            selectedId={selectedId}
            sources={projects.find((p) => p.name === project)?.sources ?? []}
            onRenameSource={(id, title) => {
              if (!project) return
              void api
                .renameSource(project, id, title)
                .then(() => api.projects().then(setProjects))
                .then(() => say(`Renamed to “${title}”.`))
                .catch((e: unknown) => say(`Rename failed: ${String(e)}`))
            }}
          />
        </div>
      </div>

      {libraryOpen && project && (
        <Library
          project={project}
          sources={projects.find((p) => p.name === project)?.sources ?? []}
          onDone={() => {
            setLibraryOpen(false)
            void api.projects().then(setProjects)
          }}
        />
      )}

      {settingsOpen && (
        <Settings health={health} onRefreshHealth={refreshHealth} onDone={() => setSettingsOpen(false)} />
      )}
    </ActionsContext.Provider>
  )
}
