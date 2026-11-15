import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react'
import { useActions } from './actions'
import type { AnyEdge } from './graph'
import { EDGE_LABEL } from './types'

/**
 * Стрелка со своей подписью: на подписи живёт крестик удаления,
 * чтобы убирать связь, не трогая блоки.
 */
export default function LabeledEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  markerEnd,
  style,
}: EdgeProps<AnyEdge>) {
  const { deleteEdge } = useActions()
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })
  const kind = data?.kind ?? 'context'

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className={`edge-label edge-label--${kind} ${selected ? 'edge-label--sel' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <span className="edge-label__text">{EDGE_LABEL[kind]}</span>
          <button
            className="edge-label__del nodrag nopan"
            title="delete link"
            onClick={(e) => {
              // Иначе клик уйдёт в onEdgeClick и сначала переключит тип связи.
              e.stopPropagation()
              deleteEdge(id)
            }}
          >
            ×
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
