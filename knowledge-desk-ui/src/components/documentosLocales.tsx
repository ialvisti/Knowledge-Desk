import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { EstadoServidor } from '../api/tipos'
import { eliminarLocal, guardarLocal, mensajeErrorLocal, obtenerLocal, validarArchivoLocal, type DocumentoLocal, type RegistroLocal, type TipoLocal } from '../local/documentos'
import { fechaHora, plural, tamano } from '../lib/formato'
import { ACEPTA_LOCAL, describirLocal, ETIQUETA_TIPO, tipoDe } from '../lib/locales'
import { Modal } from './Modal'
import { Button, Icon, Spinner } from './ui'

// Colección local de demostración: documentos guardados en IndexedDB de este
// navegador. Nada de esto viaja al servidor de Knowledge Desk ni a ForUsGuide.

const OPERACION: Record<RegistroLocal['tipo'], string> = { carga: 'Carga', reemplazo: 'Reemplazo', eliminacion: 'Eliminación' }

export function IconoLocal({ tipo, grande = false }: { tipo: TipoLocal; grande?: boolean }) {
  return <span className={`file-badge file-badge-local file-badge-${tipo} ${grande ? 'file-badge-large' : ''}`} aria-hidden="true">
    <Icon name="draft" /><span className="file-badge-label">{ETIQUETA_TIPO[tipo]}</span>
  </span>
}

// Texto normal, sin insignia: el documento quedó extraído y fragmentado para la búsqueda.
export function EstadoLocal() {
  return <span className="local-state">Indexado</span>
}

// Nota discreta sobre dónde se guardan los archivos. El alcance técnico queda
// plegado: es real, pero no hace falta repetirlo en cada pantalla.
export function AvisoColeccionLocal({ estado }: { estado: EstadoServidor | null }) {
  const corpus = estado?.modo === 'forusguide' ? 'el corpus de ForUsGuide' : 'el corpus del servidor'
  return <div className="local-notice">
    <p><Icon name="info" />Tus archivos se guardan en este navegador. En una ventana privada se pierden al cerrarla. Buscar en documentos usa estos archivos; Consulta responde con {corpus}.</p>
    {estado?.indexacion.configurada && <p>Los artículos indexados en el servidor siguen en <Link to="/documentos">Documentos del servidor</Link>.</p>}
    <details>
      <summary>Detalles de almacenamiento</summary>
      <ul>
        <li>Se guardan con IndexedDB solo para esta dirección (<code>{window.location.origin}</code>). No se envían a Render, a ForUsGuide ni a ningún servidor, y no los ven otros usuarios, equipos ni navegadores: localhost y Render guardan colecciones distintas.</li>
        <li>No forman parte del corpus de ForUsGuide ni de las respuestas de Consulta. Buscar en documentos encuentra fragmentos por coincidencia de palabras, sin embeddings ni generación de respuestas.</li>
        <li>Se borran al borrar los datos de este sitio, y el navegador puede liberarlos si se queda sin espacio.</li>
        <li>El texto se extrae en el navegador: PDF sin OCR, DOCX solo con los párrafos del cuerpo y TXT en UTF-8. Máximo 50 MB por archivo y 20 MB de texto extraído.</li>
        {estado && !estado.indexacion.configurada && <li>Este servidor no tiene indexación configurada{estado.modo === 'forusguide' ? ' y solo consulta ForUsGuide' : ''}: no recibe archivos.</li>}
      </ul>
    </details>
  </div>
}

export function RegistroLocalTecnico({ registro }: { registro: RegistroLocal }) {
  return <section className="tech-log" aria-label="Registro técnico">
    <h3>Registro técnico</h3>
    <dl>
      <div><dt>ID de operación</dt><dd>{registro.id}</dd></div>
      <div><dt>Documento</dt><dd>{registro.documentoId} - {registro.documentoNombre}</dd></div>
      <div><dt>Operación</dt><dd>{OPERACION[registro.tipo]} · v{registro.version} · {plural(registro.fragmentos, 'fragmento', 'fragmentos')}</dd></div>
      <div><dt>Fecha y hora</dt><dd>{fechaHora(registro.fecha)}</dd></div>
      <div><dt>Almacenamiento</dt><dd>IndexedDB de este navegador · {window.location.origin}</dd></div>
      <div><dt>Resultado</dt><dd><span className="result-pill result-ok">Exitoso</span></dd></div>
    </dl>
  </section>
}

// Lista (no tabla) para no confundirse con las filas de documentos.
export function ListaRegistrosLocales({ registros, limite = 5 }: { registros: RegistroLocal[]; limite?: number }) {
  const [todos, setTodos] = useState(false)
  const visibles = todos ? registros : registros.slice(0, limite)
  return <>
    <ol className="local-log-list">
      {visibles.map(registro => <li key={registro.id}>
        <span className="local-log-op">{OPERACION[registro.tipo]} v{registro.version}</span>
        <span className="local-log-doc">{registro.documentoNombre}</span>
        <span>{plural(registro.fragmentos, 'fragmento', 'fragmentos')}</span>
        <time dateTime={registro.fecha}>{fechaHora(registro.fecha)}</time>
        <span className="result-pill result-ok">Exitoso</span>
        <code title={`ID de operación ${registro.id}`}>{registro.id.slice(0, 8)}</code>
      </li>)}
    </ol>
    {registros.length > limite && <button type="button" className="text-link local-log-more" aria-expanded={todos} onClick={() => setTodos(!todos)}>
      {todos ? 'Mostrar menos' : `Mostrar las ${registros.length} operaciones`}
    </button>}
  </>
}

// Tras un fallo o un borrado se relee el documento: lo que se informa es lo que
// de verdad queda guardado, no una suposición.
type Comprobacion = { estado: 'presente'; documento: DocumentoLocal } | { estado: 'ausente' } | { estado: 'desconocido'; mensaje: string }

async function comprobar(id: string): Promise<Comprobacion> {
  try {
    const documento = await obtenerLocal(id)
    return documento ? { estado: 'presente', documento } : { estado: 'ausente' }
  } catch (fallo) {
    return { estado: 'desconocido', mensaje: mensajeErrorLocal(fallo) }
  }
}

function Contador({ titulo, valor, estado }: { titulo: string; valor: string; estado: 'ok' | 'fallo' | 'pendiente' }) {
  const icono = estado === 'ok' ? 'check_circle' : estado === 'fallo' ? 'cancel' : 'schedule'
  return <div className={`counter-tile counter-${estado}`}>
    <Icon name={icono} filled={estado === 'fallo'} />
    <div><strong>{titulo}</strong><span>{valor}</span></div>
  </div>
}

// --- Reemplazo: sustitución total en una sola transacción de IndexedDB.

type FaseReemplazo =
  | { tipo: 'editando' }
  | { tipo: 'enviando' }
  | { tipo: 'exito'; documento: DocumentoLocal; registro: RegistroLocal }
  | { tipo: 'error'; mensaje: string; vigente: Comprobacion }

export function DialogoReemplazoLocal({ documento, onClose }: { documento: DocumentoLocal; onClose: () => void }) {
  const [archivo, setArchivo] = useState<File | null>(null)
  const [confirmado, setConfirmado] = useState(false)
  const [errorArchivo, setErrorArchivo] = useState<string | null>(null)
  const [fase, setFase] = useState<FaseReemplazo>({ tipo: 'editando' })
  const input = useRef<HTMLInputElement>(null)
  const enCurso = fase.tipo === 'enviando'
  const fragmentos = documento.fragmentos.length
  const tipoNuevo = archivo ? tipoDe(archivo.name) : null

  async function reemplazar() {
    if (!archivo) return
    setFase({ tipo: 'enviando' })
    try {
      const resultado = await guardarLocal(archivo, documento.id)
      setFase({ tipo: 'exito', ...resultado })
    } catch (fallo) {
      setFase({ tipo: 'error', mensaje: mensajeErrorLocal(fallo), vigente: await comprobar(documento.id) })
    }
  }

  if (fase.tipo === 'exito') {
    const nuevo = fase.documento
    return <Modal etiqueta="Documento reemplazado" onClose={onClose} className="modal-result modal-local-result">
      <div className="result-hero">
        <span className="result-check" aria-hidden="true"><Icon name="check" /></span>
        <h2>Documento reemplazado</h2>
        <p>{`${nuevo.nombre} es ahora la versión v${nuevo.version} del documento, con el mismo identificador. La búsqueda ya usa esta versión. El archivo y los fragmentos de la v${documento.version} ya no están guardados.`}</p>
      </div>
      <RegistroLocalTecnico registro={fase.registro} />
      <div className="modal-actions modal-actions-center"><Button onClick={onClose} autoFocus>Volver a documentos</Button></div>
    </Modal>
  }

  if (fase.tipo === 'error') {
    const { vigente } = fase
    const cambiado = vigente.estado === 'presente' && (vigente.documento.version !== documento.version || vigente.documento.sha256 !== documento.sha256)
    const situacion = vigente.estado === 'ausente'
      ? 'El documento ya no está en la colección: se eliminó, probablemente desde otra pestaña.'
      : vigente.estado === 'desconocido'
        ? `No se pudo comprobar qué versión queda guardada: ${vigente.mensaje}`
        : cambiado
          ? `El documento cambió en otra pestaña: ahora es la v${vigente.documento.version} (${vigente.documento.nombre}). Cierra y revisa la lista antes de reemplazarlo.`
          : `Se conserva sin cambios la v${vigente.documento.version} (${vigente.documento.nombre}) con ${plural(vigente.documento.fragmentos.length, 'fragmento', 'fragmentos')}: comprobado en el almacenamiento del navegador.`
    return <Modal etiqueta="No se pudo reemplazar el documento" onClose={onClose} className="modal-replace-error">
      <div className="modal-head modal-head-status">
        <h2><span className="status-x" aria-hidden="true"><Icon name="close" /></span>No se pudo reemplazar el documento</h2>
      </div>
      <div className="danger-box danger-box-strong" role="alert">
        <Icon name="error" filled />
        <p>{fase.mensaje}<br />{situacion}</p>
      </div>
      <p className="error-detail">Archivo no aplicado: {archivo?.name} ({archivo ? tamano(archivo.size) : '—'}). No se guardó ninguna versión nueva.</p>
      <div className="modal-actions">
        <Button variant="outline" onClick={onClose}>Cerrar</Button>
        {vigente.estado === 'presente' && !cambiado && <>
          <Button variant="outline" onClick={() => setFase({ tipo: 'editando' })}>Elegir otro archivo</Button>
          <Button variant="olive" onClick={() => void reemplazar()} autoFocus>Reintentar</Button>
        </>}
      </div>
    </Modal>
  }

  return <Modal etiqueta="Reemplazar documento local" onClose={onClose} bloqueado={enCurso} className="modal-replace">
    <div className="modal-head">
      <h2>Reemplazar documento</h2>
      <button className="icon-button" aria-label="Cerrar" onClick={onClose} disabled={enCurso}><Icon name="close" /></button>
    </div>
    <p className="modal-label">Documento que se reemplazará</p>
    <div className="doc-card">
      <IconoLocal tipo={documento.tipo} />
      <div>
        <strong>{documento.nombre}</strong>
        <span>{describirLocal(documento)}</span>
        <span>ID {documento.id}</span>
      </div>
    </div>
    <p className="modal-label">Nuevo archivo aprobado</p>
    <div className="doc-card doc-card-new">
      {tipoNuevo ? <IconoLocal tipo={tipoNuevo} /> : <Icon name="draft" />}
      <strong>{archivo ? `${archivo.name} · ${tamano(archivo.size)}` : 'Ningún archivo seleccionado'}</strong>
      <button type="button" className="button-change" disabled={enCurso} title="PDF, DOCX, TXT o JSON kb_article_v2, hasta 50 MB" onClick={() => input.current?.click()}>{archivo ? 'Cambiar' : 'Seleccionar'}</button>
      <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-label="Seleccionar reemplazo local" accept={ACEPTA_LOCAL} onChange={event => {
        const elegido = event.target.files?.[0] ?? null
        event.target.value = ''
        if (!elegido) return
        const problema = validarArchivoLocal(elegido)
        setErrorArchivo(problema)
        setArchivo(problema ? null : elegido)
      }} />
    </div>
    {errorArchivo && <p role="alert" className="field-error modal-field-error">{errorArchivo}</p>}
    <div className="warning-box">
      <Icon name="warning" filled />
      <p>{`Sustitución total: el archivo original, el texto extraído y ${fragmentos === 1 ? 'el fragmento' : `los ${fragmentos} fragmentos`} de la v${documento.version} se sustituyen por los del nuevo archivo, que será la v${documento.version + 1} con el mismo identificador. Si algo falla, la v${documento.version} se conserva intacta.`}</p>
    </div>
    <label className="confirm-check">
      <input type="checkbox" checked={confirmado} disabled={enCurso} onChange={event => setConfirmado(event.target.checked)} />
      <span>Confirmo que este archivo es la versión aprobada y reemplaza al documento indicado.</span>
    </label>
    {enCurso && <div className="processing-note" role="status">
      <Spinner />
      <span>{`Extrayendo el texto y guardando la v${documento.version + 1}. La v${documento.version} sigue disponible hasta que termine.`}</span>
    </div>}
    <div className="modal-actions">
      <Button variant="outline" onClick={onClose} disabled={enCurso}>Cancelar</Button>
      <Button onClick={() => void reemplazar()} disabled={!archivo || !confirmado || enCurso}>Reemplazar documento</Button>
    </div>
  </Modal>
}

// --- Eliminación: documento, texto y fragmentos se borran en una transacción;
// el registro de la operación se conserva.

export function DialogoEliminacionLocal({ documento, onClose }: { documento: DocumentoLocal; onClose: () => void }) {
  const [confirmado, setConfirmado] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState<{ mensaje: string; vigente: Comprobacion } | null>(null)
  const [resultado, setResultado] = useState<{ registro: RegistroLocal; comprobacion: Comprobacion } | null>(null)
  const fragmentos = documento.fragmentos.length

  async function eliminar() {
    setEnviando(true)
    setError(null)
    try {
      const registro = await eliminarLocal(documento.id)
      setResultado({ registro, comprobacion: await comprobar(documento.id) })
    } catch (fallo) {
      setError({ mensaje: mensajeErrorLocal(fallo), vigente: await comprobar(documento.id) })
    } finally {
      setEnviando(false)
    }
  }

  if (resultado) {
    const { registro, comprobacion } = resultado
    return <Modal etiqueta="Documento eliminado" onClose={onClose} className="modal-deleted modal-deleted-local">
      <div className="result-hero">
        <span className="result-check result-check-outline" aria-hidden="true"><Icon name="check" /></span>
        <h2 className="font-editorial">Documento eliminado</h2>
        <p>Ya no aparece en Documentos ni en la búsqueda.</p>
      </div>
      <div className="counter-row">
        <Contador titulo="Fragmentos" valor={`${registro.fragmentos} de ${registro.fragmentos} retirados`} estado="ok" />
        <Contador titulo="Original" valor="Borrado" estado="ok" />
        <Contador titulo="Comprobación"
          valor={comprobacion.estado === 'ausente' ? 'Ya no está guardado' : comprobacion.estado === 'presente' ? 'Sigue guardado' : 'No se pudo comprobar'}
          estado={comprobacion.estado === 'ausente' ? 'ok' : comprobacion.estado === 'presente' ? 'fallo' : 'pendiente'} />
      </div>
      <RegistroLocalTecnico registro={registro} />
      <div className="modal-actions"><Button onClick={onClose} autoFocus>Volver a documentos</Button></div>
    </Modal>
  }

  const ausente = error?.vigente.estado === 'ausente'
  return <Modal etiqueta="¿Eliminar este documento local?" onClose={onClose} bloqueado={enviando} className="modal-delete">
    <span className="delete-icon" aria-hidden="true"><Icon name="delete" /></span>
    <h2 className="font-editorial delete-title">¿Eliminar este documento?</h2>
    <div className="doc-card doc-card-center">
      <strong>{documento.nombre}</strong>
      <span>{describirLocal(documento)}</span>
    </div>
    <div className="danger-box">
      <Icon name="warning" />
      <p>{`Se borrarán el archivo original, su texto extraído y ${fragmentos === 1 ? 'su fragmento' : `sus ${fragmentos} fragmentos`}. Dejará de aparecer en la búsqueda. El registro técnico de la operación se conserva.`}</p>
    </div>
    <label className="confirm-check">
      <input type="checkbox" checked={confirmado} disabled={enviando || ausente} onChange={event => setConfirmado(event.target.checked)} />
      <span>Entiendo las consecuencias y confirmo la eliminación de este documento.</span>
    </label>
    {error && <div role="alert" className="notice notice-error">
      <Icon name="error" filled />
      <p>
        No se eliminó el documento. {error.mensaje}
        <br />
        {error.vigente.estado === 'presente'
          ? `Sigue guardado completo (v${error.vigente.documento.version}, ${plural(error.vigente.documento.fragmentos.length, 'fragmento', 'fragmentos')}): comprobado en el almacenamiento del navegador. Puedes reintentarlo.`
          : error.vigente.estado === 'ausente'
            ? 'El documento ya no está guardado.'
            : `No se pudo comprobar su estado: ${error.vigente.mensaje}`}
      </p>
    </div>}
    {enviando && <div className="processing-note" role="status"><Spinner /><span>Eliminando el documento…</span></div>}
    <div className="modal-actions">
      <Button variant="outline" onClick={onClose} disabled={enviando}>{ausente ? 'Cerrar' : 'Cancelar'}</Button>
      <Button variant="danger" onClick={() => void eliminar()} disabled={!confirmado || enviando || ausente}>Eliminar documento</Button>
    </div>
  </Modal>
}
