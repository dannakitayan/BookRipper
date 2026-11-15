import { createContext, useContext } from 'react'
import type { FindingStatus } from './types'

export interface Actions {
  toggleCollapse: (blockId: string) => void
  renameBlock: (blockId: string, title: string) => void
  deleteBlock: (blockId: string) => void

  /** Заметка — это сохранённый запрос, её текст правится на месте. */
  editQuestion: (blockId: string, noteId: string, question: string) => void
  addNote: (blockId: string) => void
  deleteNote: (blockId: string, noteId: string) => void
  runNote: (blockId: string, noteId: string) => void
  deeperNote: (blockId: string, noteId: string) => void

  setFindingStatus: (
    blockId: string,
    noteId: string,
    findingId: string,
    status: FindingStatus,
  ) => void

  editSynopsis: (blockId: string, text: string) => void

  /** Текущая стадия поиска по каждой заметке: «filtering 12/24» и т.п. */
  progressByNote: Record<string, string>

  /** Удаление одной связи: блоки при этом остаются на месте. */
  deleteEdge: (edgeId: string) => void

  /** Запомнить позицию курсора в конспекте — туда встанет маркер цитаты. */
  rememberCaret: (synopsisId: string, pos: number) => void
  /** Поставить в текст конспекта маркер [n] на эту выписку. */
  insertCitation: (blockId: string, noteId: string, findingId: string) => void
}

export const ActionsContext = createContext<Actions | null>(null)

export function useActions(): Actions {
  const a = useContext(ActionsContext)
  if (!a) throw new Error('ActionsContext не предоставлен')
  return a
}
