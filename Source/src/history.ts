import { useCallback, useEffect, useRef, useState } from 'react'
import type { AnyEdge, AnyNode } from './graph'

export interface Snapshot {
  nodes: AnyNode[]
  edges: AnyEdge[]
}

/**
 * Снимок без служебных полей React Flow: выделение, перетаскивание и замеры
 * меняются постоянно и не должны попадать в историю.
 */
export function snapshotOf(nodes: AnyNode[], edges: AnyEdge[]): Snapshot {
  return {
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
}

const LIMIT = 100

/**
 * История канваса. Набор текста сливается в один шаг по паузе,
 * иначе откат отматывал бы по одной букве.
 */
export function useHistory(
  nodes: AnyNode[],
  edges: AnyEdge[],
  apply: (s: Snapshot) => void,
  pauseMs = 500,
) {
  const past = useRef<string[]>([])
  const future = useRef<string[]>([])
  const current = useRef<string>(JSON.stringify(snapshotOf(nodes, edges)))
  const applying = useRef(false)
  const [depth, setDepth] = useState({ undo: 0, redo: 0 })

  const sync = () => setDepth({ undo: past.current.length, redo: future.current.length })

  useEffect(() => {
    const next = JSON.stringify(snapshotOf(nodes, edges))
    if (next === current.current) return

    if (applying.current) {
      // Состояние пришло от самого отката — запоминаем, но шага не создаём.
      current.current = next
      applying.current = false
      return
    }

    const t = window.setTimeout(() => {
      past.current = [...past.current, current.current].slice(-LIMIT)
      future.current = []
      current.current = next
      sync()
    }, pauseMs)
    return () => window.clearTimeout(t)
  }, [nodes, edges, pauseMs])

  const undo = useCallback(() => {
    const prev = past.current.at(-1)
    if (prev === undefined) return
    past.current = past.current.slice(0, -1)
    future.current = [...future.current, current.current]
    applying.current = true
    apply(JSON.parse(prev) as Snapshot)
    sync()
  }, [apply])

  const redo = useCallback(() => {
    const next = future.current.at(-1)
    if (next === undefined) return
    future.current = future.current.slice(0, -1)
    past.current = [...past.current, current.current]
    applying.current = true
    apply(JSON.parse(next) as Snapshot)
    sync()
  }, [apply])

  return { undo, redo, canUndo: depth.undo > 0, canRedo: depth.redo > 0 }
}
