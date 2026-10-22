import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button, DemoNote, Icon, Spinner } from '../components/ui'
import { SearchForm } from '../components/SearchForm'
import { SourceCard, SourceDialog } from '../components/SourceCard'
import { RichText } from '../lib/richText'
import { buildSources, coverageLabel, retrievalSummary, type AnswerSource } from '../lib/answerView'
import { useKnowledgeAnswer } from '../hooks/useKnowledgeAnswer'
import { suggestions } from '../data/questions'

const ANNOUNCEMENTS: Record<string, string> = {
  loading: 'Consultando la base de conocimiento. Puede tardar unos segundos.',
  ready: 'Respuesta lista.',
}

export function Resultados() {
  const [params] = useSearchParams()
  const query = params.get('q')?.trim() ?? ''
  const { status, answer, message, retry } = useKnowledgeAnswer(query)
  // La ficha abierta pertenece a la consulta que la produjo: si la pregunta
  // cambia, el diálogo no debe reaparecer sobre la respuesta nueva.
  const [selected, setSelected] = useState<{ query: string; id: string } | null>(null)

  const sources: AnswerSource[] = answer ? buildSources(answer) : []
  const selectedSource: AnswerSource | null =
    selected && selected.query === query ? sources.find(source => source.id === selected.id) ?? null : null
  const summary = answer ? retrievalSummary(answer) : null
  const coverage = answer ? coverageLabel(answer.confidence_note) : null

  // La consulta tarda lo bastante como para que quien la lanzó se marche de la
  // pantalla. Al terminar, el aviso se anuncia y el foco vuelve al contenido.
  const main = useRef<HTMLElement>(null)
  const previous = useRef(status)
  useEffect(() => {
    if (previous.current === 'loading' && (status === 'ready' || status === 'failed')) {
      main.current?.focus({ preventScroll: true })
    }
    previous.current = status
  }, [status])

  return <main id="contenido" tabIndex={-1} ref={main} className="page-container results-page">
    {/* Región viva permanente: si apareciera junto con su texto, los lectores de
        pantalla no la anunciarían de forma fiable. */}
    <p className="sr-only" role="status" aria-live="polite">
      {status === 'failed' ? `No pudimos responder. ${message ?? ''}` : status === 'invalid' ? message : ANNOUNCEMENTS[status] ?? ''}
    </p>

    <div className="results-toolbar">
      <Link to="/" className="text-link"><Icon name="arrow_back" />Nueva consulta</Link>
      {summary && <DemoNote>
        {[
          summary.chunks === null ? null : `${summary.chunks} fragmentos recuperados`,
          summary.articles === null ? null : `${summary.articles} artículos`,
          summary.model,
        ].filter(Boolean).join(' · ')}
      </DemoNote>}
    </div>

    <section className="query-echo">
      <p className="eyebrow">{query ? 'Consulta procesada' : 'Tu consulta'}</p>
      <h1>{query || '¿Qué te gustaría consultar?'}</h1>
    </section>

    {status === 'loading' && <section className="answer-panel answer-loading" aria-busy="true" aria-label="Consultando">
      <p className="loading-line"><Spinner />Consultando la base de conocimiento…</p>
      <p className="text-sm text-muted">Se recuperan los fragmentos del índice y el modelo redacta la respuesta. Suele tardar unos segundos.</p>
      <div className="skeleton" aria-hidden="true">
        <span /><span /><span /><span />
      </div>
    </section>}

    {status === 'failed' && <section className="answer-panel answer-failure">
      <h2><Icon name="error" />No pudimos responder</h2>
      <p>{message}</p>
      <Button onClick={retry}>Reintentar</Button>
    </section>}

    {status === 'invalid' && <section className="empty-results">
      <Icon name="edit_note" />
      <h2>Revisa tu consulta</h2>
      <p>{message}</p>
      <SearchForm />
    </section>}

    {status === 'ready' && answer && <>
      <section aria-label="Respuesta" className="answer-panel">
        <div className="answer-indicators">
          {coverage && <span className={`coverage-badge ${coverage.modifier}`}><Icon name={coverage.icon} />{coverage.label}</span>}
          <span>Respuesta generada sobre el conocimiento recuperado</span>
        </div>
        {answer.answer.trim()
          ? <RichText text={answer.answer} />
          : <p className="answer-prose">El modelo no devolvió texto para esta consulta. Prueba a reformular la pregunta.</p>}
        {summary && summary.subQueries.length > 0 && <details className="retrieval-detail">
          <summary>Búsquedas ejecutadas en el índice</summary>
          <ul>{summary.subQueries.map(item => <li key={item}>{item}</li>)}</ul>
        </details>}
      </section>

      {answer.key_points.length > 0 && <section className="results-section">
        <h2>Puntos clave</h2>
        <ul className="key-points">{answer.key_points.map((point, index) => <li key={`${index}-${point}`}>{point}</li>)}</ul>
      </section>}

      {sources.length > 0 && <section className="results-section">
        <h2>Fuentes documentales</h2>
        <div className="source-grid">{sources.map(source => <SourceCard source={source} key={source.id} onOpen={() => setSelected({ query, id: source.id })} />)}</div>
      </section>}
    </>}

    {status === 'idle' && <section className="empty-results">
      <Icon name="search_off" />
      <h2>Comienza con una pregunta</h2>
      <p>Escribe una consulta sobre las políticas y procedimientos indexados, o elige uno de los ejemplos.</p>
      <SearchForm />
      <div className="suggestion-list">{suggestions.map(text => <Link className="suggestion-chip" key={text} to={`/resultados?${new URLSearchParams({ q: text })}`}>{text}</Link>)}</div>
    </section>}

    {selectedSource && <SourceDialog source={selectedSource} onClose={() => setSelected(null)} />}
  </main>
}
