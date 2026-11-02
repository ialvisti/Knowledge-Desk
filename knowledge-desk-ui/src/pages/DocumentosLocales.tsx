import { useRef, useState, type DragEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AvisoColeccionLocal, DialogoEliminacionLocal, DialogoReemplazoLocal, EstadoLocal, ListaRegistrosLocales } from '../components/documentosLocales'
import { Button, Icon, Spinner } from '../components/ui'
import { useAlmacenamiento, useColeccionLocal } from '../hooks/useColeccionLocal'
import { guardarLocal, mensajeErrorLocal, validarArchivoLocal, type DocumentoLocal } from '../local/documentos'
import { fechaCorta, normalizar, plural, tamano } from '../lib/formato'
import { ACEPTA_LOCAL, ETIQUETA_TIPO, ICONO_TIPO, rutaDocumentoLocal } from '../lib/locales'
import { useServidor } from '../state/servidor'

interface Aviso { clave: number; tipo: 'ok' | 'error'; texto: string }
interface Pendiente { clave: number; nombre: string; bytes: number; estado: 'cola' | 'procesando' }

let secuencia = 0

const sinNombre = (nombre: string, mensaje: string) => (mensaje.startsWith(`${nombre}: `) ? mensaje.slice(nombre.length + 2) : mensaje)

// Documentos locales: la misma vista de Documentos, pero sobre la colección de
// este navegador (IndexedDB). Cada fila es lo que hay guardado; mientras un
// archivo se procesa se ve como tal, y un fallo no deja nada a medias.
export function DocumentosLocales() {
  const { estado } = useServidor()
  const { documentos, registros, error, recargar } = useColeccionLocal()
  const almacenamiento = useAlmacenamiento(documentos)
  const [params] = useSearchParams()
  const filtro = normalizar(params.get('filtro') ?? '')
  const visibles = (documentos ?? []).filter(doc => normalizar(doc.nombre).includes(filtro))
  const input = useRef<HTMLInputElement>(null)
  const profundidad = useRef(0)
  const [arrastrando, setArrastrando] = useState(false)
  const [avisos, setAvisos] = useState<Aviso[]>([])
  const [pendientes, setPendientes] = useState<Pendiente[]>([])
  const [reemplazo, setReemplazo] = useState<DocumentoLocal | null>(null)
  const [eliminacion, setEliminacion] = useState<DocumentoLocal | null>(null)

  async function recibir(archivos: File[]) {
    if (!archivos.length) return
    const nuevos: Aviso[] = []
    const validos: { archivo: File; clave: number }[] = []
    for (const archivo of archivos) {
      const problema = validarArchivoLocal(archivo)
      if (problema) nuevos.push({ clave: ++secuencia, tipo: 'error', texto: problema })
      else validos.push({ archivo, clave: ++secuencia })
    }
    setAvisos([...nuevos])
    setPendientes(actual => [...actual, ...validos.map(({ archivo, clave }) => ({ clave, nombre: archivo.name, bytes: archivo.size, estado: 'cola' as const }))])
    // Uno por uno: cada archivo se extrae y se guarda en su propia transacción.
    for (const { archivo, clave } of validos) {
      setPendientes(actual => actual.map(item => (item.clave === clave ? { ...item, estado: 'procesando' } : item)))
      try {
        const { documento } = await guardarLocal(archivo)
        nuevos.push({ clave, tipo: 'ok', texto: `${archivo.name}: documento cargado (v${documento.version}, ${plural(documento.fragmentos.length, 'fragmento', 'fragmentos')}).` })
      } catch (fallo) {
        nuevos.push({ clave, tipo: 'error', texto: `${archivo.name}: no se guardó. ${sinNombre(archivo.name, mensajeErrorLocal(fallo))}` })
      } finally {
        setPendientes(actual => actual.filter(item => item.clave !== clave))
      }
      setAvisos([...nuevos])
    }
  }

  function soltar(event: DragEvent) {
    event.preventDefault()
    profundidad.current = 0
    setArrastrando(false)
    void recibir(Array.from(event.dataTransfer.files))
  }

  const procesando = pendientes.length > 0
  return <main id="contenido" tabIndex={-1} className="documents-page documents-page-local page-container">
    <div className="documents-heading local-heading">
      <div>
        <h1>Documentos</h1>
        <p>Carga, reemplaza y elimina tus archivos PDF, DOCX, TXT o JSON, y busca en ellos.</p>
      </div>
      <Link to="/consulta-local" className="button button-primary local-cta"><Icon name="manage_search" />Buscar en documentos</Link>
    </div>
    <AvisoColeccionLocal estado={estado} />
    <div className="documents-grid">
      <section aria-label="Carga de documentos" className="upload-section">
        <div className={`upload-zone ${arrastrando ? 'is-dragging' : ''}`}
          onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
          onDragEnter={event => { event.preventDefault(); profundidad.current++; setArrastrando(true) }}
          onDragLeave={event => { event.preventDefault(); if (--profundidad.current === 0) setArrastrando(false) }}
          onDrop={soltar}>
          <span className="upload-icon"><Icon name="cloud_upload" filled /></span>
          <h2>Cargar documento</h2>
          <p>Arrastra uno o varios archivos aquí o haz clic para explorar.</p>
          <p className="upload-formats" id="formatos-locales">PDF, DOCX, TXT o JSON (Max 50MB)</p>
          <Button type="button" className="button-explore" onClick={() => input.current?.click()}>
            {procesando ? 'Procesando…' : 'Explorar archivos'}
          </Button>
          <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-label="Seleccionar documentos locales" aria-describedby="formatos-locales" accept={ACEPTA_LOCAL} multiple
            onChange={event => { void recibir(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        </div>
        <p className="upload-explanation"><Icon name="info" />PDF con texto seleccionable (sin OCR), DOCX, TXT en UTF-8 o artículo JSON kb_article_v2.</p>
        <div className="upload-feedback" aria-live="polite">
          {avisos.map(aviso => <div key={aviso.clave} role={aviso.tipo === 'error' ? 'alert' : 'status'} className={`notice notice-${aviso.tipo}`}>
            <Icon name={aviso.tipo === 'ok' ? 'check_circle' : 'error'} filled />
            <p>{aviso.texto}</p>
            {aviso.tipo === 'error' && <button type="button" className="notice-action" onClick={() => input.current?.click()}>Volver a seleccionar</button>}
          </div>)}
        </div>
      </section>

      <section className="document-list-section" aria-label="Documentos disponibles">
        <div className="document-table-wrap">
          <table className="document-table">
            <caption className="sr-only">Documentos guardados en este navegador</caption>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Fecha de carga</th><th scope="col">Fragmentos</th><th scope="col">Estado</th><th scope="col">Acciones</th></tr></thead>
            <tbody>
              {pendientes.map(item => <tr key={`pendiente-${item.clave}`} data-estado="procesando">
                <td data-label="Nombre"><div className="document-name"><Icon name="hourglass_top" /><span title={tamano(item.bytes)}>{item.nombre}</span></div></td>
                <td data-label="Fecha de carga">—</td>
                <td data-label="Fragmentos">-</td>
                <td data-label="Estado"><div className="local-status">
                  <span className="local-state">{item.estado === 'cola' ? 'En cola' : 'Procesando…'}</span>
                  <span className="status-note">{item.estado === 'cola' ? 'Esperando turno' : 'Extrayendo texto'}</span>
                </div></td>
                <td data-label="Acciones"><span className="sr-only">Sin acciones mientras se procesa</span></td>
              </tr>)}
              {visibles.map(doc => <tr key={doc.id} data-estado="indexado-local">
                <td data-label="Nombre"><div className="document-name">
                  <Icon name={ICONO_TIPO[doc.tipo]} />
                  <Link to={rutaDocumentoLocal(doc.id)} className="document-link" title={`${doc.nombre} · ${ETIQUETA_TIPO[doc.tipo]} · v${doc.version} · abrir el documento`}>{doc.nombre}</Link>
                </div></td>
                <td data-label="Fecha de carga">{fechaCorta(doc.fechaCarga)}</td>
                <td data-label="Fragmentos">{doc.fragmentos.length}</td>
                <td data-label="Estado"><div className="local-status">
                  <EstadoLocal />
                  <span className="status-note">{ETIQUETA_TIPO[doc.tipo]} · v{doc.version}</span>
                </div></td>
                <td data-label="Acciones"><div className="row-actions">
                  <button type="button" className="action-button" aria-label={`Editar ${doc.nombre}`} title="Reemplazar por una nueva versión" onClick={() => setReemplazo(doc)}><Icon name="edit" filled /></button>
                  <button type="button" className="action-button" aria-label={`Eliminar ${doc.nombre}`} title="Eliminar" onClick={() => setEliminacion(doc)}><Icon name="delete" filled /></button>
                </div></td>
              </tr>)}
            </tbody>
          </table>
          {documentos === null && !error && <p className="loading-line documents-empty"><Spinner />Cargando documentos…</p>}
          {documentos !== null && !visibles.length && !pendientes.length && <div role="status" className="documents-empty">
            <Icon name={filtro ? 'search_off' : 'folder_open'} />
            {filtro
              ? <><p>No hay documentos que coincidan con tu búsqueda.</p><p>Prueba con otro nombre.</p></>
              : <><p>Aún no hay documentos.</p><p>Carga un PDF, DOCX, TXT o JSON para empezar.</p></>}
          </div>}
          {error && <div role="alert" className="notice notice-error">
            <Icon name="error" filled />
            <p>No se pudo leer la lista de documentos: {error}</p>
            <button type="button" className="notice-action" onClick={recargar}>Reintentar</button>
          </div>}
        </div>
        <div className="document-list-footer">
          <span role="status">{plural(visibles.length, 'documento', 'documentos')}{filtro ? ` de ${documentos?.length ?? 0}` : ''} · guardados en este navegador</span>
          {almacenamiento && <span>Espacio usado: {tamano(almacenamiento.uso)} de {tamano(almacenamiento.cuota)} disponibles</span>}
        </div>
        {registros && registros.length > 0 && <section className="local-log" aria-labelledby="registro-local">
          <h2 id="registro-local">Registro técnico</h2>
          <p>Operaciones confirmadas. Un intento fallido no cambia ningún documento y se informa en pantalla.</p>
          <ListaRegistrosLocales registros={registros} />
        </section>}
      </section>
    </div>
    {reemplazo && <DialogoReemplazoLocal documento={reemplazo} onClose={() => setReemplazo(null)} />}
    {eliminacion && <DialogoEliminacionLocal documento={eliminacion} onClose={() => setEliminacion(null)} />}
  </main>
}
