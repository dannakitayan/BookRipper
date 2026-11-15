import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useActions } from './actions'
import type { QueryNode as QueryNodeType } from './graph'
import { HANDLE, STATUS_META, type Finding, type Note } from './types'
import { AutoTextarea, EditableTitle, Excerpt, FindingHead, StatusButtons } from './ui'

const NOTE_STATE_LABEL: Record<Note['state'], string> = {
  empty: 'not run',
  running: 'searching…',
  fresh: 'up to date',
  stale: 'needs rerun',
  nothing: 'nothing found',
}

function FindingCard({
  blockId,
  noteId,
  finding,
}: {
  blockId: string
  noteId: string
  finding: Finding
}) {
  const { setFindingStatus, insertCitation } = useActions()

  return (
    <div className={`finding finding--${finding.status}`}>
      <FindingHead finding={finding} />
      <Excerpt text={finding.excerpt} />
      <p className="finding__why">{finding.why}</p>

      <footer className="finding__actions">
        <StatusButtons
          status={finding.status}
          onSet={(s) => setFindingStatus(blockId, noteId, finding.id, s)}
        />
        <button
          className="chip nodrag nopan"
          title="insert [n] into the synopsis text"
          onClick={() => insertCitation(blockId, noteId, finding.id)}
        >
          [n]
        </button>
        <span className="finding__status">{STATUS_META[finding.status].label}</span>
      </footer>
    </div>
  )
}

function NoteCard({ blockId, note, progress }: { blockId: string; note: Note; progress?: string }) {
  const { runNote, deeperNote, editQuestion, deleteNote } = useActions()
  const shown = note.findings.filter((f) => f.status !== 'rejected')
  const rejected = note.findings.length - shown.length

  return (
    <section className="note">
      <header className="note__head">
        <span className={`dot dot--${note.state}`} title={NOTE_STATE_LABEL[note.state]} />
        <AutoTextarea
          className="ta--question"
          value={note.question}
          onChange={(v) => editQuestion(blockId, note.id, v)}
          placeholder="What should I look for in the books?"
        />
      </header>

      <div className="note__meta">
        <span>{progress || NOTE_STATE_LABEL[note.state]}</span>
        <button className="link nodrag nopan" onClick={() => runNote(blockId, note.id)}>
          {note.state === 'empty' ? 'run' : 'rerun'}
        </button>
        {note.findings.length > 0 && note.state !== 'running' && (
          <button className="link nodrag nopan" onClick={() => deeperNote(blockId, note.id)}>
            search deeper
          </button>
        )}
        <button className="link link--danger nodrag nopan" onClick={() => deleteNote(blockId, note.id)}>
          delete
        </button>
      </div>

      {note.summary && <p className="note__summary">{note.summary}</p>}

      <div className="note__findings">
        {shown.map((f) => (
          <FindingCard key={f.id} blockId={blockId} noteId={note.id} finding={f} />
        ))}
        {!note.findings.length && <p className="note__empty">No findings yet.</p>}
        {rejected > 0 && <p className="note__hidden">dismissed and hidden: {rejected}</p>}
      </div>
    </section>
  )
}

export default function QueryNodeView({ id, data, selected }: NodeProps<QueryNodeType>) {
  const { toggleCollapse, addNote, renameBlock, deleteBlock, progressByNote } = useActions()
  const findings = data.notes.reduce((n, note) => n + note.findings.length, 0)

  return (
    <div className={`block block--query ${selected ? 'block--selected' : ''}`}>
      <Handle id={HANDLE.queryIn} type="target" position={Position.Left} className="port" />
      {/* Левый выход — для конспекта, стоящего слева от запроса. */}
      <Handle
        id={HANDLE.queryOutLeft}
        type="source"
        position={Position.Left}
        className="port port--cite port--out-left"
      />

      <header className="block__head">
        <button className="block__fold nodrag nopan" onClick={() => toggleCollapse(id)}>
          {data.collapsed ? '▸' : '▾'}
        </button>
        <span className="block__kind">reference</span>
        <EditableTitle value={data.title} onChange={(v) => renameBlock(id, v)} placeholder="Reference topic" />
        <span className="block__count">
          {data.notes.length} q · {findings} f
        </span>
        <button className="block__del nodrag nopan" title="delete block" onClick={() => deleteBlock(id)}>
          ×
        </button>
      </header>

      {!data.collapsed && (
        <div className="block__body nowheel">
          {data.notes.map((note) => (
            <NoteCard key={note.id} blockId={id} note={note} progress={progressByNote?.[note.id]} />
          ))}
          <button className="block__add nodrag nopan" onClick={() => addNote(id)}>
            + question
          </button>
        </div>
      )}

      <Handle id={HANDLE.queryOut} type="source" position={Position.Right} className="port" />
    </div>
  )
}
