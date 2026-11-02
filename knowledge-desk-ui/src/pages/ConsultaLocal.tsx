import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
// Límite propio de la búsqueda en los documentos del navegador; no es el de la
// pregunta al servidor, que tiene su propia regla.
const MAX_BUSQUEDA_LOCAL = 2000
import { IconoLocal } from '../components/documentosLocales'
import { Icon, Spinner } from '../components/ui'
import { buscarLocales, listarLocales, mensajeErrorLocal, suscribirLocales, type DocumentoLocal, type FragmentoLocal } from '../local/documentos'
import { fechaTexto, plural } from '../lib/formato'
import { ETIQUETA_TIPO, RUTA_COLECCION_LOCAL, rutaDocumentoLocal } from '../lib/locales'

interface Grupo { documento: DocumentoLocal; extractos: { fragmento: FragmentoLocal; numero: number }[] }
interface Resultado { clave: string; grupos: Grupo[]; total: number; enColeccion: number }

// Solo para resaltar en pantalla las palabras de la pregunta que aparecen en el
// extracto. El orden y la selección de extractos los decide el motor local.
const VACIAS = new Set('al algo ante bajo como con contra cual cuales cuando del desde donde dos ella entre era esa ese eso esta este esto fue hasta hay las les los mas muy nos para pero por porque que quien sin sobre son sus tiene una uno unos unas cuanto puedo debo hacer'.split(' '))
const sinTildes = (texto: string) => texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

function terminosResaltables(pregunta: string): Set<string> {
  return new Set((sinTildes(pregunta).match(/[a-z0-9]{2,}/g) ?? []).filter(termino => termino.length > 2 && !VACIAS.has(termino)))
}

function resaltar(texto: string, terminos: Set<string>): ReactNode[] {
  return texto.split(/([\p{L}\p{N}]+)/u).map((parte, indice) => (indice % 2 === 1 && terminos.has(sinTildes(parte)) ? <mark key={indice}>{parte}</mark> : parte))
}

function agrupar(resultados: Awaited<ReturnType<typeof buscarLocales>>): Grupo[] {
  const grupos: Grupo[] = []
  for (const { documento, fragmento } of resultados) {
    let grupo = grupos.find(item => item.documento.id === documento.id)
    if (!grupo) grupos.push(grupo = { documento, extractos: [] })
    grupo.extractos.push({ fragmento, numero: documento.fragmentos.findIndex(item => item.id === fragmento.id) + 1 })
  }
  return grupos
}

function FormularioLocal({ inicial, onBuscar }: { inicial: string; onBuscar: (pregunta: string) => void }) {
  const id = useId()
  const [texto, setTexto] = useState(inicial)
  const [error, setError] = useState<string | null>(null)
  function enviar(event: FormEvent) {
    event.preventDefault()
    if (!texto.trim()) { setError('Escribe una pregunta o unas palabras para buscar.'); return }
    onBuscar(texto.trim())
  }
  return <div className="local-search-form">
    <form onSubmit={enviar} className="frame-search" role="search" noValidate>
      <label htmlFor={id} className="sr-only">Pregunta sobre tus documentos locales</label>
      <div className={`frame-input ${error ? 'frame-input-invalid' : ''}`}>
        <Icon name="search" />
        <input id={id} value={texto} maxLength={MAX_BUSQUEDA_LOCAL} autoComplete="off" placeholder="Por ejemplo: ¿cuál es el reembolso diario de viáticos?"
          aria-invalid={error !== null} aria-describedby={error ? `${id}-error` : undefined}
          onChange={event => { setTexto(event.target.value); setError(null) }} />
      </div>
      <button type="submit" className="button-consultar">Buscar en documentos</button>
    </form>
    {error && <p id={`${id}-error`} role="alert" className="frame-field-error">{error}</p>}
  </div>
}

// Búsqueda por términos sobre la colección local del navegador. No genera
// respuestas ni consulta al servidor. Cada búsqueda se resuelve contra lo que
// hay guardado en ese momento y se repite cuando la colección cambia: un
// documento reemplazado o eliminado no aparece con datos anteriores, tampoco al
// volver atrás.
export function ConsultaLocal() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { key } = useLocation()
  const pregunta = params.get('q')?.trim() ?? ''
  const [revision, setRevision] = useState(0)
  const recargar = useCallback(() => setRevision(valor => valor + 1), [])
  useEffect(() => suscribirLocales(recargar), [recargar])
  const clave = `${key}#${revision}`
  const [resultado, setResultado] = useState<Resultado | null>(null)
  const [fallo, setFallo] = useState<{ clave: string; mensaje: string } | null>(null)

  useEffect(() => {
    if (!pregunta) return
    let activo = true
    Promise.all([buscarLocales(pregunta), listarLocales()]).then(([resultados, coleccion]) => {
      if (!activo) return
      const grupos = agrupar(resultados)
      setResultado({ clave, grupos, total: resultados.length, enColeccion: coleccion.length })
    }, (error: unknown) => { if (activo) setFallo({ clave, mensaje: mensajeErrorLocal(error) }) })
    return () => { activo = false }
  }, [pregunta, clave])

  const vigente = resultado?.clave === clave ? resultado : null
  const error = fallo?.clave === clave ? fallo.mensaje : null
  const terminos = terminosResaltables(pregunta)

  return <main id="contenido" tabIndex={-1} className="results-page local-search-page page-container">
    <div className="results-toolbar">
      <Link to={RUTA_COLECCION_LOCAL} className="text-link"><Icon name="arrow_back" />Volver a documentos</Link>
    </div>
    <h1 className="frame-title">Buscar en documentos</h1>
    <p className="frame-subtitle">Busca palabras en tus archivos y consulta los fragmentos encontrados.</p>
    <FormularioLocal key={pregunta} inicial={pregunta} onBuscar={valor => navigate(`/consulta-local?${new URLSearchParams({ q: valor })}`)} />

    {!pregunta ? null
      : error ? <div role="alert" className="notice notice-error local-search-error">
        <Icon name="error" filled />
        <p>No se pudo buscar en tus documentos: {error}</p>
        <button type="button" className="notice-action" onClick={recargar}>Reintentar</button>
      </div>
        : !vigente ? <p className="loading-line local-search-loading" role="status"><Spinner />Buscando…</p>
          : !vigente.grupos.length ? <div className="empty-results" role="status">
            <Icon name={vigente.enColeccion ? 'search_off' : 'folder_open'} />
            {vigente.enColeccion
              ? <><h2>Ningún fragmento contiene las palabras de tu pregunta</h2><p>{`Se revisaron ${plural(vigente.enColeccion, 'documento', 'documentos')}. Prueba con palabras que aparezcan en tus archivos; la búsqueda no reconoce sinónimos.`}</p></>
              : <><h2>Aún no hay documentos</h2><p>Carga PDF, DOCX, TXT o JSON en Documentos para buscar en ellos.</p></>}
            <Link to={RUTA_COLECCION_LOCAL} className="button button-secondary">Ir a documentos</Link>
          </div>
            : <section className="results-section local-results" aria-labelledby="extractos-locales">
              <h2 id="extractos-locales">{plural(vigente.total, 'fragmento', 'fragmentos')} en {plural(vigente.grupos.length, 'documento', 'documentos')}</h2>
              <p className="local-results-note">Ordenados por coincidencia con las palabras de tu pregunta. Abre el documento para ver el contexto.</p>
              <div className="source-grid">
                {vigente.grupos.map(({ documento, extractos }) => <article key={documento.id} className="source-card local-source" aria-label={`Fragmentos de ${documento.nombre}`}>
                  <div className="source-card-top">
                    <span className="source-type"><IconoLocal tipo={documento.tipo} />Documento · {ETIQUETA_TIPO[documento.tipo]}</span>
                    <span className="source-relevance">Versión v{documento.version}</span>
                  </div>
                  <h3><Link to={rutaDocumentoLocal(documento.id)} className="source-title-link">{documento.nombre}</Link></h3>
                  {extractos.map(extracto => <blockquote key={extracto.fragmento.id} className="local-excerpt">
                    <p>{resaltar(extracto.fragmento.texto, terminos)}</p>
                    <footer>Fragmento {extracto.numero} de {documento.fragmentos.length}</footer>
                  </blockquote>)}
                  <div className="source-meta">
                    <span><Icon name="calendar_today" />cargado el {fechaTexto(documento.fechaCarga)}</span>
                    <span><Icon name="segment" />{plural(documento.fragmentos.length, 'fragmento', 'fragmentos')}</span>
                  </div>
                </article>)}
              </div>
            </section>}
    {!pregunta && <p className="local-search-hint"><Icon name="info" />Escribe una pregunta o unas palabras que aparezcan en tus archivos.</p>}
  </main>
}
