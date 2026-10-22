import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError } from '../api/cliente'
import type { ContratoConsulta } from '../api/tipos'
import { BarraConsulta, Contradicciones, InsigniaCobertura, MarcoConsulta, PanelContrato, TarjetaError, TarjetaFuente, TarjetaInsuficiencia } from '../components/consulta'
import { SearchForm } from '../components/SearchForm'
import { Icon, Nota, Spinner } from '../components/ui'
import { useConsulta } from '../hooks/useConsulta'
import { useEjemplos } from '../hooks/useEjemplos'
import { plural } from '../lib/formato'
import { RichText } from '../lib/richText'
import { useServidor } from '../state/servidor'

const TIMEOUT_POR_DEFECTO = 90_000

function anuncio(fase: string, contrato: ContratoConsulta | null, error: ApiError | null): string {
  if (fase === 'cargando') return 'Consultando la base de conocimiento. Puede tardar unos segundos.'
  if (fase === 'verificando') return 'Comprobando si la documentación cambió desde esta consulta.'
  if (error) return `No pudimos responder. ${error.message}`
  if (contrato?.outcome === 'insufficient') return 'Documentación insuficiente: no se generó una respuesta.'
  if (contrato) return 'Respuesta lista.'
  return ''
}

export function Resultados() {
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { estado } = useServidor()
  const pregunta = params.get('q')?.trim() ?? ''
  const consulta = useConsulta(pregunta, `${location.key}:${pregunta}`, estado?.consultaTimeoutMs ?? TIMEOUT_POR_DEFECTO)
  const ejemplos = useEjemplos()

  const resultado = consulta.fase === 'lista' ? consulta.resultado : null
  const contrato = resultado?.tipo === 'ok' ? resultado.contrato : null
  const error = resultado?.tipo === 'error' ? resultado.error : null
  const requestId = resultado?.requestId ?? null

  // La consulta tarda lo bastante como para que quien la lanzó cambie de foco.
  // Al terminar, el foco vuelve al contenido y el estado se anuncia.
  const main = useRef<HTMLElement>(null)
  const previa = useRef(consulta.fase)
  useEffect(() => {
    if (previa.current === 'cargando' && consulta.fase === 'lista') main.current?.focus({ preventScroll: true })
    previa.current = consulta.fase
  }, [consulta.fase])

  const nuevaConsulta = (texto: string) => navigate(`/resultados?${new URLSearchParams({ q: texto })}`)
  const input = useRef<HTMLInputElement>(null)
  // El aviso de pregunta vacía pertenece a la entrada del historial donde ocurrió.
  const [vaciaEn, setVaciaEn] = useState<string | null>(null)
  const vaciaLocal = vaciaEn === location.key
  const setVaciaLocal = (vacia: boolean) => setVaciaEn(vacia ? location.key : null)

  let contenido
  if (consulta.fase === 'inactiva') {
    contenido = <section className="empty-results">
      <Icon name="search_off" />
      <h2>Comienza con una pregunta</h2>
      <p>Escribe una consulta sobre las políticas y procedimientos indexados, o elige uno de los ejemplos.</p>
      <SearchForm />
      <div className="suggestion-list">{ejemplos.lista.map(texto => <Link className="suggestion-chip" key={texto} to={`/resultados?${new URLSearchParams({ q: texto })}`}>{texto}</Link>)}</div>
    </section>
  } else if (consulta.fase === 'cargando' || consulta.fase === 'verificando') {
    contenido = <>
      <ConsultaProcesada pregunta={pregunta} />
      <section className="answer-panel answer-loading" aria-busy="true" aria-label="Consultando">
        {consulta.fase === 'cargando'
          ? <>
            <p className="loading-line"><Spinner />Consultando la base de conocimiento…</p>
            <p className="text-sm text-muted">{estado?.simulado
              ? 'Se recuperan los fragmentos del índice simulado y se arma una respuesta simulada.'
              : 'Se recuperan los fragmentos del índice y el modelo redacta la respuesta. Suele tardar unos segundos.'}</p>
          </>
          : <p className="loading-line"><Spinner />Comprobando si la documentación cambió…</p>}
        <div className="skeleton" aria-hidden="true"><span /><span /><span /><span /></div>
      </section>
    </>
  } else if (error) {
    // Errores con el marco de las imágenes "Consumir los servicios de consulta".
    // Una pregunta enviada vacía desde la barra no llega al servidor: se muestra
    // la validación sin ID de soporte.
    contenido = <div className="consulta-frame">
      <MarcoConsulta>
        <BarraConsulta key={`${requestId}-${pregunta}`} inicial={pregunta} onConsultar={nuevaConsulta} onInvalida={setVaciaLocal} refInput={input}>
          {vaciaLocal
            ? <TarjetaError error={null} requestId={null} onReintentar={consulta.reintentar} onCorregir={() => input.current?.focus()} />
            : <>
              <TarjetaError error={error} requestId={requestId} onReintentar={consulta.reintentar} onCorregir={() => input.current?.focus()} />
              {error.contrato && <PanelContrato datos={error.contrato} />}
            </>}
        </BarraConsulta>
      </MarcoConsulta>
    </div>
  } else if (contrato && contrato.outcome === 'insufficient') {
    contenido = <TarjetaInsuficiencia contrato={contrato} contactoUrl={estado?.contactoUrl ?? null} onConsultar={nuevaConsulta} />
  } else if (contrato) {
    contenido = <Respuesta contrato={contrato} simulado={estado?.simulado ?? false} />
  }

  const fase = consulta.fase
  return <main id="contenido" tabIndex={-1} ref={main} className={`page-container results-page ${error ? 'results-page-error' : ''} ${contrato?.outcome === 'insufficient' ? 'results-page-insufficient' : ''}`}>
    {/* Región viva permanente: si apareciera junto con su texto, los lectores
        de pantalla no la anunciarían de forma fiable. */}
    <p className="sr-only" role="status" aria-live="polite">{anuncio(fase, contrato, error)}</p>
    {contenido}
  </main>
}

function ConsultaProcesada({ pregunta, metadatos }: { pregunta: string; metadatos?: string }) {
  return <>
    <div className="results-toolbar">
      <Link to="/" className="text-link"><Icon name="arrow_back" />Nueva consulta</Link>
      {metadatos && <Nota>{metadatos}</Nota>}
    </div>
    <section className="query-echo">
      <p className="eyebrow">Consulta procesada</p>
      <h1>{pregunta}</h1>
    </section>
  </>
}

// Respuesta sustentada: estructura del PDF "Resultados — Knowledge Desk".
function Respuesta({ contrato, simulado }: { contrato: ContratoConsulta; simulado: boolean }) {
  const recuperacion = contrato.retrieval
  // En la demostración no hay modelo ni índice reales: se dice, en vez de
  // mostrar un nombre de modelo.
  const metadatos = [
    plural(recuperacion.fragments_retrieved, 'fragmento recuperado', 'fragmentos recuperados'),
    plural(recuperacion.articles_consulted, 'artículo', 'artículos'),
    simulado ? 'respuesta simulada (demostración)' : recuperacion.model,
  ].filter(Boolean).join(' · ')
  return <>
    <ConsultaProcesada pregunta={contrato.question} metadatos={metadatos} />
    <section aria-label="Respuesta" className="answer-panel">
      <div className="answer-indicators">
        <InsigniaCobertura cobertura={contrato.coverage} />
        <span>Respuesta generada sobre el conocimiento recuperado</span>
        <span className="request-id">ID de solicitud: {contrato.request_id}</span>
      </div>
      <p className="coverage-explanation">{contrato.coverage.explanation} La cobertura mide la evidencia recuperada; no es una probabilidad de acierto.</p>
      <RichText text={contrato.answer ?? ''} />
      <p className="answer-review-note"><Icon name="fact_check" />Apoyo para el personal interno: revísala antes de enviarla a un cliente final.</p>
      {recuperacion.sub_queries.length > 0 && <details className="retrieval-detail">
        <summary>Búsquedas ejecutadas en el índice</summary>
        <ul>{[...new Set(recuperacion.sub_queries)].map(item => <li key={item}>{item}</li>)}</ul>
      </details>}
    </section>

    <Contradicciones contrato={contrato} />

    {contrato.key_points.length > 0 && <section className="results-section">
      <h2>Puntos clave</h2>
      <ul className="key-points">{contrato.key_points.map((punto, indice) => <li key={`${indice}-${punto}`}>{punto}</li>)}</ul>
    </section>}

    {contrato.sources.length > 0 && <section className="results-section">
      <h2>Fuentes documentales</h2>
      <div className="source-grid">{contrato.sources.map(fuente => <TarjetaFuente fuente={fuente} usada key={fuente.id} />)}</div>
    </section>}

    <div className="results-section technical-section">
      <PanelContrato datos={contrato} plegado />
    </div>
  </>
}
