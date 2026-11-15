import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useActions } from './actions'
import type { SynopsisNode as SynopsisNodeType } from './graph'
import { HANDLE } from './types'
import { AutoTextarea, EditableTitle } from './ui'

/** Лист читателя: текст пишет человек, ссылки подшиваются стрелками. */
export default function SynopsisNodeView({ id, data, selected }: NodeProps<SynopsisNodeType>) {
  const { editSynopsis, renameBlock, deleteBlock, toggleCollapse, rememberCaret } = useActions()
  const chars = data.text.trim().length

  return (
    <div className={`block block--synopsis ${selected ? 'block--selected' : ''}`}>
      <Handle
        id={HANDLE.synopsisInLeft}
        type="target"
        position={Position.Left}
        className="port port--cite"
      />
      <Handle
        id={HANDLE.synopsisInRight}
        type="target"
        position={Position.Right}
        className="port port--cite"
      />

      <header className="block__head">
        <button className="block__fold nodrag nopan" onClick={() => toggleCollapse(id)}>
          {data.collapsed ? '▸' : '▾'}
        </button>
        <span className="block__kind block__kind--synopsis">synopsis</span>
        <EditableTitle
          value={data.title}
          onChange={(v) => renameBlock(id, v)}
          placeholder="Synopsis title"
        />
        <span className="block__count">{chars ? `${chars} chars` : 'empty'}</span>
        <button className="block__del nodrag nopan" title="delete synopsis" onClick={() => deleteBlock(id)}>
          ×
        </button>
      </header>

      {!data.collapsed && (
        <div className="block__body block__body--synopsis">
          <AutoTextarea
            className="ta--synopsis"
            value={data.text}
            onChange={(v) => editSynopsis(id, v)}
            onCaret={(pos) => rememberCaret(id, pos)}
            placeholder="Your own writing: conclusions, comparisons, questions to yourself…"
            minRows={6}
          />
        </div>
      )}

    </div>
  )
}
