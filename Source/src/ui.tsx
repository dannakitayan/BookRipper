import { useEffect, useRef } from 'react'
import { STATUS_META, formatLocator, type Finding, type FindingStatus } from './types'

/**
 * Поля ввода на канвасе: nodrag/nopan обязательны, иначе перетаскивание блока
 * съедает выделение текста, а колесо — скролл внутри поля.
 */
const CANVAS_SAFE = 'nodrag nopan nowheel'

/** Textarea, растущая под содержимое: на канвасе внутренние скроллы мешают. */
export function AutoTextarea({
  value,
  onChange,
  onCaret,
  placeholder,
  className = '',
  minRows = 2,
}: {
  value: string
  onChange: (v: string) => void
  onCaret?: (pos: number) => void
  placeholder?: string
  className?: string
  minRows?: number
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  /*
   * Позицию курсора слушаем нативно: синтетический onSelect у React приходит
   * только для элемента в фокусе, а нам нужна последняя известная позиция всегда.
   */
  useEffect(() => {
    const el = ref.current
    if (!el || !onCaret) return
    const report = () => onCaret(el.selectionStart ?? 0)
    for (const ev of ['select', 'keyup', 'click', 'blur'] as const) {
      el.addEventListener(ev, report)
    }
    return () => {
      for (const ev of ['select', 'keyup', 'click', 'blur'] as const) {
        el.removeEventListener(ev, report)
      }
    }
  }, [onCaret])

  return (
    <textarea
      ref={ref}
      className={`${CANVAS_SAFE} ta ${className}`}
      value={value}
      rows={minRows}
      placeholder={placeholder}
      onChange={(e) => {
        onChange(e.target.value)
        onCaret?.(e.target.selectionStart)
      }}
    />
  )
}

export function EditableTitle({
  value,
  onChange,
  placeholder,
  className = '',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <input
      className={`${CANVAS_SAFE} title-input ${className}`}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function IconButton({
  onClick,
  title,
  children,
  active = false,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
  active?: boolean
}) {
  return (
    <button className={`chip ${active ? 'chip--on' : ''} nodrag nopan`} title={title} onClick={onClick}>
      {children}
    </button>
  )
}

/** Выписка с подсвеченными **терминами** — ими расширяется запрос дочерней заметки. */
export function Excerpt({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g)
  return <p className="finding__excerpt">{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</p>
}

export function FindingHead({ finding }: { finding: Finding }) {
  return (
    <header className="finding__head">
      <span className="finding__source" title={finding.sourceTitle}>
        {finding.sourceTitle}
      </span>
      <span className="finding__loc">{formatLocator(finding.locator)}</span>
      <span className={`lang lang--${finding.sourceLang}`}>{finding.sourceLang}</span>
    </header>
  )
}

export function StatusButtons({
  status,
  onSet,
}: {
  status: FindingStatus
  onSet: (s: FindingStatus) => void
}) {
  const toggle = (s: FindingStatus) => onSet(status === s ? 'pending' : s)
  return (
    <>
      {(['accepted', 'rejected', 'pinned'] as FindingStatus[]).map((s) => (
        <IconButton key={s} title={STATUS_META[s].label} active={status === s} onClick={() => toggle(s)}>
          {STATUS_META[s].icon}
        </IconButton>
      ))}
    </>
  )
}
