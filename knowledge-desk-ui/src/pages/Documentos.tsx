import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError } from '../api/cliente'
import { cargarDocumento, listarDocumentos, reintentarDocumento, textoLimite, validarArchivo } from '../api/servicios'
import type { DocumentoResumen } from '../api/tipos'
import { DialogoEliminacion, DialogoReemplazo } from '../components/documentos'
import { Button, Icon, StatusBadge } from '../components/ui'
import { fechaCorta } from '../lib/formato'
import { observarRevision, suscribirRevision } from '../state/consultas'
import { useServidor } from '../state/servidor'

function normalizar(valor: string) {
  return valor.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

interface Aviso { id: number; tipo: 'ok' | 'error'; texto: string }

const ACTIVOS = new Set(['procesando', 'eliminando'])

function useDocumentos() {
  const [documentos, setDocumentos] = useState<DocumentoResumen[] | null>(null)
  const [indexacion, setIndexacion] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const recargar = useCallback(() => setVersion(valor => valor + 1), [])
  // Un cambio del corpus hecho en otra pestaña u observado al revalidar
  // también refresca la lista.
  useEffect(() => suscribirRevision(recargar), [recargar])
  useEffect(() => {
    const alVolver = () => { if (document.visibilityState === 'visible') recargar() }
    window.addEventListener('focus', alVolver)
    return () => window.removeEventListener('focus', alVolver)
  }, [recargar])
  useEffect(() => {
    let activo = true
    let temporizador: ReturnType<typeof setTimeout>
    listarDocumentos().then(datos => {
      if (!activo) return
      observarRevision(datos.revisionCorpus, { autoritativa: true })
      setDocumentos(datos.documentos)
      setIndexacion(datos.indexacionConfigurada)
      setError(null)
      // Mientras algo se procesa, el estado se vuelve a pedir: lo que se ve es
      // siempre el estado real del servidor, nunca una simulación.
      if (datos.documentos.some(doc => ACTIVOS.has(doc.estado) || doc.operacionEnCurso)) temporizador = setTimeout(recargar, 1000)
    }, (fallo: Error) => { if (activo) setError(fallo.message) })
    return () => { activo = false; clearTimeout(temporizador) }
  }, [version, recargar])
  return { documentos, indexacion, error, recargar }
}

export function Documentos() {
  const { estado, revalidar } = useServidor()
  const { documentos, indexacion, error, recargar } = useDocumentos()
  const [params] = useSearchParams()
  const filtro = normalizar(params.get('filtro') ?? '')
  const visibles = (documentos ?? []).filter(doc => normalizar(`${doc.nombre} ${doc.titulo} ${doc.articuloId}`).includes(filtro))
  const input = useRef<HTMLInputElement>(null)
  const profundidad = useRef(0)
  const [arrastrando, setArrastrando] = useState(false)
  const [avisos, setAvisos] = useState<Aviso[]>([])
  const [subiendo, setSubiendo] = useState(0)
  const [reemplazo, setReemplazo] = useState<DocumentoResumen | null>(null)
  const [eliminacion, setEliminacion] = useState<DocumentoResumen | null>(null)
  const [detalleError, setDetalleError] = useState<string | null>(null)
  const puede = estado?.puedeAdministrar ?? false
  const cargaDisponible = puede && indexacion
  const maxBytes = estado?.limites.archivoMaxBytes

  const alCambiar = useCallback(() => { recargar(); void revalidar() }, [recargar, revalidar])

  async function recibir(archivos: File[]) {
    const nuevos: Aviso[] = []
    for (const archivo of archivos) {
      const problema = validarArchivo(archivo, maxBytes)
      if (problema) { nuevos.push({ id: Math.random(), tipo: 'error', texto: problema }); continue }
      setSubiendo(valor => valor + 1)
      try {
        const { documento } = await cargarDocumento(archivo)
        nuevos.push({ id: Math.random(), tipo: 'ok', texto: `${archivo.name}: artículo "${documento.titulo}" recibido. Se está indexando; quedará disponible para consultas al terminar.` })
      } catch (fallo) {
        nuevos.push({ id: Math.random(), tipo: 'error', texto: `No fue posible cargar ${archivo.name}. ${fallo instanceof ApiError ? fallo.message : 'Error de conexión.'}` })
      } finally {
        setSubiendo(valor => valor - 1)
      }
    }
    setAvisos(nuevos)
    alCambiar()
  }

  function soltar(event: DragEvent) {
    event.preventDefault()
    profundidad.current = 0
    setArrastrando(false)
    if (cargaDisponible) void recibir(Array.from(event.dataTransfer.files))
  }

  // Sin indexación en modo forusguide, las respuestas salen del corpus de
  // ForUsGuide y aquí no se carga nada: se dice tal cual.
  const sinIndexacion = estado?.modo === 'forusguide'
    ? 'Las consultas usan el corpus de ForUsGuide. Este servidor no tiene indexación configurada: aquí no se cargan artículos.'
    : 'La indexación no está configurada en este servidor.'
  const motivoBloqueo = !puede ? 'Tu acceso es solo de consulta.' : !indexacion ? sinIndexacion : null

  return <main id="contenido" tabIndex={-1} className="documents-page page-container">
    <div className="documents-heading">
      <h1>Documentos de la base de conocimiento</h1>
      <p>Administra y carga los archivos que alimentan las respuestas del sistema.</p>
    </div>
    <div className="documents-grid">
      <section aria-label="Carga de documentos" className="upload-section">
        <div className={`upload-zone ${arrastrando ? 'is-dragging' : ''} ${cargaDisponible ? '' : 'is-disabled'}`}
          onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = cargaDisponible ? 'copy' : 'none' }}
          onDragEnter={event => { event.preventDefault(); profundidad.current++; setArrastrando(cargaDisponible) }}
          onDragLeave={event => { event.preventDefault(); if (--profundidad.current === 0) setArrastrando(false) }}
          onDrop={soltar}>
          <span className="upload-icon"><Icon name="cloud_upload" filled /></span>
          <h2>Cargar documento</h2>
          <p>Arrastra archivos aquí o haz clic para explorar.</p>
          <p className="upload-formats" id="upload-formats" title="Artículos de conocimiento kb_article_v2 (metadata y details)">{textoLimite(maxBytes)}</p>
          <Button type="button" className="button-explore" disabled={!cargaDisponible || subiendo > 0} onClick={() => input.current?.click()}>
            {subiendo > 0 ? 'Subiendo…' : 'Explorar archivos'}
          </Button>
          <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-label="Seleccionar artículos JSON" aria-describedby="upload-formats" accept=".json,application/json" multiple
            onChange={event => { void recibir(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        </div>
        {motivoBloqueo && <p className="upload-explanation"><Icon name="info" />{motivoBloqueo}</p>}
        <div className="upload-feedback" aria-live="polite">
          {avisos.map(aviso => <p key={aviso.id} role={aviso.tipo === 'error' ? 'alert' : 'status'} className={`notice notice-${aviso.tipo}`}>
            <Icon name={aviso.tipo === 'ok' ? 'check_circle' : 'error'} filled />{aviso.texto}
          </p>)}
        </div>
      </section>

      <section className="document-list-section" aria-label="Documentos disponibles">
        <div className="document-table-wrap">
          <table className="document-table">
            <caption className="sr-only">Documentos de la base de conocimiento</caption>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Fecha de carga</th><th scope="col">Fragmentos</th><th scope="col">Estado</th><th scope="col">Acciones</th></tr></thead>
            <tbody>{visibles.map(doc => {
              const ocupado = ACTIVOS.has(doc.estado) || doc.operacionEnCurso !== null
              const alerta = doc.estado === 'error' || doc.estado === 'bloqueado'
              return <tr key={doc.id} data-estado={doc.estado}>
                <td data-label="Nombre"><div className="document-name">
                  <Icon name={alerta ? 'radio_button_checked' : 'description'} className={alerta ? 'text-error' : ''} />
                  {/* El nombre abre el JSON auténtico de la versión vigente. */}
                  <Link to={`/documentos/${doc.id}`} className="document-link" title={`${doc.titulo} · ${doc.articuloId} · ver el JSON`}>{doc.nombre}</Link>
                </div></td>
                <td data-label="Fecha de carga">{fechaCorta(doc.fechaCarga)}</td>
                <td data-label="Fragmentos">{doc.fragmentos ?? '-'}</td>
                <td data-label="Estado">
                  {doc.estado === 'error' && doc.error
                    ? <button type="button" className="status-button" aria-expanded={detalleError === doc.id} aria-controls={`error-${doc.id}`} onClick={() => setDetalleError(actual => (actual === doc.id ? null : doc.id))}><StatusBadge status="error" /><span className="sr-only">Ver motivo del error</span></button>
                    : <StatusBadge status={doc.estado} />}
                  {doc.operacionEnCurso?.tipo === 'reemplazo' && <span className="status-note">Reemplazo a v{doc.operacionEnCurso.version} en curso</span>}
                  {detalleError === doc.id && doc.error && <div id={`error-${doc.id}`} className="error-popover" role="region" aria-label={`Motivo del error de ${doc.nombre}`}>
                    <p>{doc.error.mensaje}</p>
                    {!doc.versionActiva && indexacion && puede && <Button variant="outline" onClick={() => {
                      setDetalleError(null)
                      reintentarDocumento(doc.id).then(alCambiar, (fallo: Error) => setAvisos([{ id: Math.random(), tipo: 'error', texto: fallo.message }]))
                    }}>Reintentar procesamiento</Button>}
                  </div>}
                </td>
                <td data-label="Acciones"><div className="row-actions">
                  <button type="button" className="action-button" aria-label={`Editar ${doc.nombre}`} title={motivoBloqueo ?? (ocupado ? 'Hay una operación en curso' : 'Reemplazar por una nueva versión del artículo')} disabled={!cargaDisponible || ocupado || doc.estado === 'bloqueado'} onClick={() => setReemplazo(doc)}><Icon name="edit" filled /></button>
                  <button type="button" className="action-button" aria-label={`${doc.estado === 'bloqueado' ? 'Reintentar la eliminación de' : 'Eliminar'} ${doc.nombre}`} title={!puede ? 'Tu acceso es solo de consulta.' : ocupado ? 'Hay una operación en curso' : 'Eliminar'} disabled={!puede || ocupado} onClick={() => setEliminacion(doc)}><Icon name="delete" filled /></button>
                </div></td>
              </tr>
            })}</tbody>
          </table>
          {documentos !== null && !visibles.length && <div role="status" className="documents-empty">
            <Icon name={filtro ? 'search_off' : 'folder_open'} />
            {filtro ? <><p>No hay documentos que coincidan con tu búsqueda.</p><p>Prueba con otro nombre.</p></> : <p>Aún no hay artículos cargados.</p>}
          </div>}
          {error && <p role="alert" className="notice notice-error"><Icon name="error" filled />No se pudo cargar la lista: {error}</p>}
        </div>
        <div className="document-list-footer">
          <span role="status">{visibles.length} {visibles.length === 1 ? 'documento' : 'documentos'}{filtro ? ` de ${documentos?.length ?? 0}` : ''}</span>
          {estado && <span>{estado.indexacion.configurada ? `Índice: ${estado.indexacion.destino}` : 'Indexación no configurada'}{estado.simulado ? ' · servicios simulados (demostración)' : ''}{estado.datosTemporales ? ' · vista previa con datos temporales: los artículos cargados se pierden al reiniciar o redesplegar' : ''}</span>}
        </div>
      </section>
    </div>
    {reemplazo && <DialogoReemplazo documento={reemplazo} maxBytes={maxBytes} onClose={() => setReemplazo(null)} onCambio={alCambiar} />}
    {eliminacion && <DialogoEliminacion documento={eliminacion} onClose={() => setEliminacion(null)} onCambio={alCambiar} />}
  </main>
}
