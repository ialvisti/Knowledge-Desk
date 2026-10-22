import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ERROR_RED, ERROR_TIEMPO_CLIENTE, type ApiError } from '../api/cliente'
import { MAX_PREGUNTA, validarPregunta } from '../api/servicios'
import type { Cobertura, ContratoConsulta, Fuente } from '../api/tipos'
import { afinidad, plural } from '../lib/formato'
import { CORPUS_CAMBIADO } from '../state/consultas'
import { Button, Icon } from './ui'

// --- Barra de consulta del marco "Consulta a la base de conocimiento" -------

export function BarraConsulta({ inicial, onConsultar, onInvalida, refInput, children }: {
  inicial: string
  onConsultar: (pregunta: string) => void
  onInvalida?: (invalida: boolean) => void
  refInput?: React.RefObject<HTMLInputElement | null>
  children?: ReactNode
}) {
  const id = useId()
  const [valor, setValor] = useState(inicial)
  const [error, setError] = useState<string | null>(null)
  function enviar(event: FormEvent) {
    event.preventDefault()
    // HU01: una pregunta vacía o de solo espacios no se envía.
    const problema = validarPregunta(valor)
    if (problema) {
      setError(problema)
      onInvalida?.(true)
      return
    }
    onInvalida?.(false)
    onConsultar(valor.trim())
  }
  return <>
    <form className="frame-search" role="search" noValidate onSubmit={enviar}>
      <div className={`frame-input ${error ? 'frame-input-invalid' : ''}`}>
        <Icon name="search" />
        <label className="sr-only" htmlFor={id}>Escribe tu pregunta</label>
        <input id={id} ref={refInput} value={valor} maxLength={MAX_PREGUNTA} placeholder="Escribe tu pregunta..." autoComplete="off"
          aria-invalid={error !== null} aria-describedby={error ? `${id}-error` : undefined}
          onChange={event => { setValor(event.target.value); setError(null) }} />
      </div>
      <button type="submit" className="button-consultar">Consultar</button>
    </form>
    {error && <p id={`${id}-error`} role="alert" className="frame-field-error">{error}</p>}
    {children}
  </>
}

export function MarcoConsulta({ children }: { children: ReactNode }) {
  return <>
    <h1 className="frame-title">Consulta a la base de conocimiento</h1>
    <p className="frame-subtitle">Cada consulta es independiente: el sistema no recuerda preguntas anteriores.</p>
    {children}
  </>
}

// --- Tarjetas de error (HU10: validación, recuperación, base vectorial, IA) --

interface Variante { titulo: string; icono: string; accion: 'reintentar' | 'corregir' | 'ninguna'; disposicion: 'lateral' | 'apilada' }

const VARIANTES: Record<string, Variante> = {
  VALIDATION_ERROR: { titulo: 'La pregunta no es válida', icono: 'edit', accion: 'corregir', disposicion: 'lateral' },
  RETRIEVAL_ERROR: { titulo: 'No pudimos buscar en los documentos', icono: 'plagiarism', accion: 'reintentar', disposicion: 'apilada' },
  VECTOR_DB_UNAVAILABLE: { titulo: 'La base de conocimiento no está disponible', icono: 'database_off', accion: 'reintentar', disposicion: 'apilada' },
  AI_PROVIDER_ERROR: { titulo: 'No pudimos generar la respuesta', icono: 'smart_toy', accion: 'reintentar', disposicion: 'lateral' },
  TIMEOUT: { titulo: 'La consulta tardó demasiado', icono: 'hourglass_disabled', accion: 'reintentar', disposicion: 'apilada' },
  [ERROR_TIEMPO_CLIENTE]: { titulo: 'La consulta tardó demasiado', icono: 'hourglass_disabled', accion: 'reintentar', disposicion: 'apilada' },
  [ERROR_RED]: { titulo: 'No hay conexión con Knowledge Desk', icono: 'cloud_off', accion: 'reintentar', disposicion: 'apilada' },
  UPSTREAM_UNREACHABLE: { titulo: 'El servicio de consulta no responde', icono: 'cloud_off', accion: 'reintentar', disposicion: 'apilada' },
  UPSTREAM_ERROR: { titulo: 'No pudimos completar la consulta', icono: 'error', accion: 'reintentar', disposicion: 'apilada' },
  UPSTREAM_AUTH_ERROR: { titulo: 'El servicio de consulta rechazó la configuración', icono: 'key_off', accion: 'ninguna', disposicion: 'apilada' },
  INTEGRATION_NOT_CONFIGURED: { titulo: 'La consulta no está configurada', icono: 'settings', accion: 'ninguna', disposicion: 'apilada' },
  CONTENT_UNAVAILABLE: { titulo: 'Un documento de la respuesta no está disponible', icono: 'lock', accion: 'reintentar', disposicion: 'apilada' },
  [CORPUS_CAMBIADO]: { titulo: 'La documentación cambió durante la consulta', icono: 'sync_problem', accion: 'reintentar', disposicion: 'apilada' },
  ACCESS_DENIED: { titulo: 'Acceso no autorizado', icono: 'lock', accion: 'ninguna', disposicion: 'apilada' },
}

const MOTIVOS: Record<string, string> = {
  vacia: 'no puede estar vacío ni superar el largo permitido.',
  corta: 'necesita al menos 10 caracteres.',
  larga: 'no puede superar 2000 caracteres.',
  formato: 'no puede estar vacío ni superar el largo permitido.',
}

function textoValidacion(error: ApiError | null): string {
  const motivo = String(error?.contrato?.details?.motivo ?? 'vacia')
  return `Revisa el texto: ${MOTIVOS[motivo] ?? MOTIVOS.vacia}`
}

export function IdSoporte({ id }: { id: string | null }) {
  const [copiado, setCopiado] = useState(false)
  if (!id) return <p className="support-id">Sin ID de soporte: la solicitud no se envió.</p>
  return <p className="support-id">
    <span>ID de soporte: <span className="support-id-value">{id}</span></span>
    <button type="button" className="copy-button" aria-label={`Copiar ID de soporte ${id}`} onClick={() => {
      navigator.clipboard?.writeText(id).then(() => setCopiado(true), () => setCopiado(false))
    }}><Icon name={copiado ? 'check' : 'content_copy'} /></button>
    <span className="sr-only" role="status">{copiado ? 'ID copiado' : ''}</span>
  </p>
}

export function TarjetaError({ error, requestId, onReintentar, onCorregir }: {
  error: ApiError | null
  requestId: string | null
  onReintentar: () => void
  onCorregir: () => void
}) {
  const codigo = error?.code ?? 'VALIDATION_ERROR'
  const variante = VARIANTES[codigo] ?? { titulo: 'No pudimos completar la consulta', icono: 'error', accion: error?.retryable === false ? 'ninguna' : 'reintentar', disposicion: 'apilada' as const }
  const mensaje = codigo === 'VALIDATION_ERROR' ? textoValidacion(error) : error?.message
  const accion = variante.accion === 'reintentar' && error?.retryable !== false
    ? <Button onClick={onReintentar}>{variante.disposicion === 'apilada' && codigo === 'RETRIEVAL_ERROR' ? <><Icon name="refresh" />Reintentar</> : 'Reintentar'}</Button>
    : variante.accion === 'corregir' ? <Button onClick={onCorregir}>Corregir pregunta</Button> : null
  return <section className={`error-card error-card-${variante.disposicion}`} aria-labelledby="titulo-error" data-code={codigo}>
    <span className="error-card-icon"><Icon name={variante.icono} /></span>
    <div className="error-card-text">
      <h2 id="titulo-error">{variante.titulo}</h2>
      <p>{mensaje}</p>
      {variante.disposicion === 'apilada' && accion && <div className="error-card-action">{accion}</div>}
    </div>
    <div className="error-card-side">
      {variante.disposicion === 'lateral' && accion}
      <IdSoporte id={requestId} />
    </div>
  </section>
}

export function PanelContrato({ datos, plegado = false }: { datos: unknown; plegado?: boolean }) {
  const json = JSON.stringify(datos, (clave, valor) => (clave === 'content' && typeof valor === 'string' && valor.length > 160 ? `${valor.slice(0, 160)}…` : valor), 2)
  if (plegado) {
    return <details className="contract-panel contract-panel-collapsible">
      <summary>Contrato JSON que recibe la interfaz</summary>
      <pre>{json}</pre>
    </details>
  }
  return <section className="contract-panel" aria-label="Contrato JSON que recibe la interfaz">
    <h2>Contrato JSON que recibe la interfaz</h2>
    <pre>{json}</pre>
  </section>
}

// --- Cobertura y fuentes (HU03–HU05) ---------------------------------------

const COBERTURA: Record<Cobertura['level'], { clase: string; icono: string }> = {
  alta: { clase: 'coverage-high', icono: 'verified' },
  parcial: { clase: 'coverage-partial', icono: 'info' },
  baja: { clase: 'coverage-limited', icono: 'warning' },
  sin_evidencia: { clase: 'coverage-limited', icono: 'block' },
}

export function InsigniaCobertura({ cobertura }: { cobertura: Cobertura }) {
  const estilo = COBERTURA[cobertura.level]
  return <span className={`coverage-badge ${estilo.clase}`}><Icon name={estilo.icono} />{cobertura.label}</span>
}

export function TarjetaFuente({ fuente, usada }: { fuente: Fuente; usada: boolean }) {
  // HU04: el título y la flecha disparan la misma acción, abrir el artículo
  // completo, y llevan los fragmentos y las rutas JSON usados para resaltarlos.
  const estado = { resaltar: fuente.fragments.map(fragmento => fragmento.id), rutas: [...new Set(fuente.fragments.flatMap(fragmento => fragmento.paths ?? []))], origen: fuente.title }
  return <article className="source-card" aria-label={fuente.title}>
    <div className="source-card-top">
      <span className="source-type"><Icon name={fuente.kind === 'document' ? 'data_object' : 'menu_book'} />{fuente.kind === 'document' ? 'Documento' : 'Artículo'}</span>
      <span className="source-relevance">{usada ? 'Usado en la respuesta' : 'Encontrado, sin evidencia suficiente'}</span>
    </div>
    <h3><Link to={fuente.href} state={estado} className="source-title-link">{fuente.title}</Link></h3>
    <div className="source-meta">
      <span><Icon name="insights" />Afinidad {afinidad(fuente.affinity)}</span>
      <span><Icon name="find_in_page" />{plural(fuente.fragment_count, 'fragmento', 'fragmentos')}</span>
      {fuente.location && <span title={fuente.file_name ?? undefined}><Icon name="data_object" /><code className="source-path">{fuente.location}</code></span>}
      <Link to={fuente.href} state={estado} className="source-arrow" aria-label={`Abrir el documento completo: ${fuente.title}`}><Icon name="arrow_outward" /></Link>
    </div>
  </article>
}

export function Contradicciones({ contrato }: { contrato: ContratoConsulta }) {
  if (!contrato.contradictions.length) return null
  const titulo = (id: string) => contrato.sources.find(fuente => fuente.id === id)?.title ?? id
  return <section className="contradictions" aria-labelledby="titulo-contradicciones">
    <h2 id="titulo-contradicciones"><Icon name="compare_arrows" />Evidencia contradictoria</h2>
    <p>Las fuentes no coinciden. Revisa ambas antes de usar la respuesta.</p>
    <ul>{contrato.contradictions.map(item => <li key={item.description}>{item.description} <span className="text-muted">({item.source_ids.map(titulo).join(' · ')})</span></li>)}</ul>
  </section>
}

// --- Insuficiencia documental (HU05, imagen "Mensaje de error en pregunta") --

export function TarjetaInsuficiencia({ contrato, contactoUrl, onConsultar }: { contrato: ContratoConsulta; contactoUrl: string | null; onConsultar: (pregunta: string) => void }) {
  const [verDocumentos, setVerDocumentos] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const cobertura = contrato.coverage
  const encontrados = contrato.found_documents
  return <section className="insufficient-card" aria-labelledby="titulo-asistente">
    <header className="insufficient-header">
      <h1 id="titulo-asistente">Asistente de documentación interna</h1>
      <span>Usuario interno</span>
    </header>
    <div className="insufficient-body">
      <BarraConsulta inicial={contrato.question} onConsultar={onConsultar} refInput={input} />
      <div className="insufficient-indicators">
        <span className="insufficient-badge"><Icon name={cobertura.level === 'sin_evidencia' ? 'block' : 'warning'} filled />{cobertura.level === 'sin_evidencia' ? 'Sin evidencia' : 'Cobertura baja'}</span>
        <span>{cobertura.relevant_fragments} de {cobertura.total_fragments} {cobertura.total_fragments === 1 ? 'fragmento relevante' : 'fragmentos relevantes'} • {plural(cobertura.documents, 'documento', 'documentos')}</span>
      </div>
      <p className="insufficient-explanation">{cobertura.explanation}</p>
      <div className="insufficient-alert" role="alert">
        <Icon name="block" />
        <p>Documentación insuficiente. No generamos una respuesta porque no hay evidencia suficiente en las fuentes aprobadas. Revisa otra fuente o consulta al área responsable.</p>
      </div>
      <div className="insufficient-actions">
        <button type="button" className="outline-action" aria-expanded={verDocumentos} disabled={!encontrados.length}
          title={encontrados.length ? undefined : 'No se encontró ningún documento relevante'} onClick={() => setVerDocumentos(valor => !valor)}>
          Ver documentos encontrados
        </button>
        <button type="button" className="outline-action" onClick={() => { input.current?.focus(); input.current?.select() }}>Reformular consulta</button>
        {contactoUrl
          ? <a className="outline-action" href={contactoUrl}>Contactar al área</a>
          : <button type="button" className="outline-action" disabled title="El canal de contacto del área no está configurado (KD_CONTACTO_URL)">Contactar al área</button>}
      </div>
      {verDocumentos && <div className="found-documents">
        <h2>Documentos encontrados</h2>
        <p className="text-muted">Contienen fragmentos relacionados, pero no bastan para sustentar una respuesta.</p>
        <div className="source-grid">{encontrados.map(fuente => <TarjetaFuente fuente={fuente} usada={false} key={fuente.id} />)}</div>
      </div>}
    </div>
  </section>
}
