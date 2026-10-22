import { useEffect, useRef } from 'react'
import type { AnswerSource } from '../lib/answerView'
import { formatScore } from '../lib/answerView'
import { Button, Icon } from './ui'

export function SourceCard({ source, onOpen }: { source: AnswerSource; onOpen: () => void }) {
  const score = formatScore(source.score)
  return <button className="source-card" onClick={onOpen}>
    <div className="source-card-top">
      <span className="source-type"><Icon name="menu_book" />Artículo</span>
      <span className="source-relevance">{source.used ? 'Usado en la respuesta' : 'Apoyo'}</span>
    </div>
    <h3>{source.title}</h3>
    <div className="source-meta">
      {score && <span><Icon name="insights" />Afinidad {score}</span>}
      <span><Icon name="find_in_page" />{source.fragments.length} {source.fragments.length === 1 ? 'fragmento' : 'fragmentos'}</span>
      <Icon name="arrow_outward" className="source-arrow" />
    </div>
  </button>
}

export function SourceDialog({ source, onClose }: { source: AnswerSource; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const score = formatScore(source.score)
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement as HTMLElement | null
    dialog.showModal()
    return () => { dialog.close(); previous?.focus() }
  }, [])
  return <dialog ref={ref} className="source-dialog" aria-labelledby="source-title" onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => {
    if (event.key !== 'Tab') return
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button')
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="dialog-content">
      <div className="flex items-center justify-between gap-4 mb-6">
        <span className="eyebrow text-primary">Artículo{score ? ` · Afinidad ${score}` : ''}</span>
        <button className="icon-button" onClick={onClose} aria-label="Cerrar fuente" autoFocus><Icon name="close" /></button>
      </div>
      <h2 id="source-title" className="font-editorial text-[28px] leading-tight mb-3">{source.title}</h2>
      <p className="text-sm text-muted mb-8">
        {source.fragments.length
          ? `${source.fragments.length} ${source.fragments.length === 1 ? 'fragmento recuperado' : 'fragmentos recuperados'} del índice`
          : 'Sin fragmentos recuperados para este artículo'}
      </p>
      <div className="fragment-list" role="group" aria-label="Fragmentos recuperados" tabIndex={0}>
        {source.fragments.map((fragment, index) => <article className="fragment" key={fragment.id}>
          <p className="eyebrow">Fragmento {index + 1} · Afinidad {fragment.score.toFixed(2)}</p>
          <blockquote className="source-excerpt">{fragment.content}</blockquote>
        </article>)}
      </div>
      <p className="text-sm text-muted my-8">Texto recuperado del índice, tal como se entregó al modelo para redactar la respuesta.</p>
      <Button variant="secondary" onClick={onClose}>Volver a la respuesta</Button>
    </div>
  </dialog>
}
