import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/cliente'
import { eliminarDocumento, reemplazarDocumento, validarArchivo } from '../api/servicios'
import { useOperacion } from '../hooks/useOperacion'
import type { DocumentoResumen, Operacion } from '../api/tipos'
import { fechaCorta, fechaHora, fechaTexto } from '../lib/formato'
import { Modal } from './Modal'
import { Button, Icon, Spinner } from './ui'

const ETAPAS: Record<string, string> = {
  validacion: 'la validación del artículo JSON',
  almacenamiento: 'el almacenamiento del archivo',
  lectura: 'la lectura del artículo',
  fragmentacion: 'la fragmentación por secciones',
  embeddings: 'la indexación',
  verificacion: 'la verificación de la indexación',
  interno: 'el procesamiento',
}

const NOMBRES_PASO: Record<string, string> = {
  validacion: 'Validación', almacenamiento: 'Almacenamiento', lectura: 'Lectura del artículo', fragmentacion: 'Fragmentación',
  embeddings: 'Embeddings', verificacion: 'Verificación', activacion: 'Publicación',
  limpieza: 'Retiro de la versión anterior', rollback: 'Retirada de lo no publicado', confirmacion: 'Confirmación',
  fragmentos: 'Fragmentos', registro: 'Registro', interrupcion: 'Interrupción',
}

const RESULTADOS: Record<Operacion['resultado'], string> = {
  en_curso: 'En curso', exitoso: 'Exitoso', fallido: 'Fallido', fallido_parcial: 'Fallido - parcial',
}

// Artículo de conocimiento en JSON: la misma insignia en la lista, los
// diálogos y el visor.
export function IconoArchivo({ grande = false }: { grande?: boolean }) {
  return <span className={`file-badge file-badge-json ${grande ? 'file-badge-large' : ''}`} aria-hidden="true">
    <Icon name="draft" /><span className="file-badge-label">JSON</span>
  </span>
}

export function RegistroTecnico({ operacion }: { operacion: Operacion }) {
  const exito = operacion.resultado === 'exitoso'
  return <section className="tech-log" aria-label="Registro técnico">
    <h3>Registro técnico</h3>
    <dl>
      <div><dt>ID de operación</dt><dd>{operacion.id}</dd></div>
      <div><dt>Documento</dt><dd>{operacion.documentoId} - {operacion.documentoNombre}</dd></div>
      <div><dt>Fecha y hora</dt><dd>{fechaHora(operacion.fin ?? operacion.inicio)}</dd></div>
      <div><dt>Operador</dt><dd>{operacion.operador}</dd></div>
      <div><dt>Resultado</dt><dd><span className={`result-pill ${exito ? 'result-ok' : 'result-fail'}`}>{RESULTADOS[operacion.resultado]}</span></dd></div>
    </dl>
  </section>
}

export function DialogoRegistro({ operacion, onClose }: { operacion: Operacion; onClose: () => void }) {
  return <Modal etiqueta="Registro completo de la operación" onClose={onClose} className="modal-log">
    <div className="modal-head">
      <h2>Registro completo</h2>
      <button className="icon-button" aria-label="Cerrar registro" onClick={onClose} autoFocus><Icon name="close" /></button>
    </div>
    <RegistroTecnico operacion={operacion} />
    {operacion.mensaje && <p className="log-message">{operacion.mensaje}</p>}
    <ol className="log-steps">
      {operacion.pasos.map((paso, indice) => <li key={`${paso.nombre}-${indice}`} className={`log-step log-step-${paso.estado}`}>
        <Icon name={paso.estado === 'ok' ? 'check_circle' : paso.estado === 'error' ? 'cancel' : 'remove_circle'} />
        <div><strong>{NOMBRES_PASO[paso.nombre] ?? paso.nombre}</strong><span>{paso.detalle}</span></div>
        <time dateTime={paso.en}>{fechaHora(paso.en)}</time>
      </li>)}
    </ol>
    <div className="modal-actions"><Button variant="outline" onClick={onClose}>Cerrar</Button></div>
  </Modal>
}

function Pasos({ operacion }: { operacion: Operacion | null }) {
  if (!operacion?.pasos.length) return null
  return <ol className="live-steps" aria-label="Avance">
    {operacion.pasos.map((paso, indice) => <li key={`${paso.nombre}-${indice}`} className={`log-step-${paso.estado}`}><Icon name={paso.estado === 'ok' ? 'check' : 'close'} />{NOMBRES_PASO[paso.nombre] ?? paso.nombre}: {paso.detalle}</li>)}
  </ol>
}

// --- Reemplazo (HU08, imágenes "Vista de edición", "Mensaje de éxito" y "error al reemplazar")

export function DialogoReemplazo({ documento, maxBytes, onClose, onCambio }: { documento: DocumentoResumen; maxBytes?: number; onClose: () => void; onCambio: () => void }) {
  const [archivo, setArchivo] = useState<File | null>(null)
  const [confirmado, setConfirmado] = useState(false)
  const [errorArchivo, setErrorArchivo] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [opId, setOpId] = useState<string | null>(null)
  const operacion = useOperacion(opId)
  const input = useRef<HTMLInputElement>(null)
  const activos = documento.fragmentos ?? 0
  const version = documento.versionActiva

  useEffect(() => { if (operacion && operacion.resultado !== 'en_curso') onCambio() }, [operacion, onCambio])

  async function reemplazar() {
    if (!archivo) return
    setEnviando(true)
    setErrorArchivo(null)
    try {
      const { operacion: creada } = await reemplazarDocumento(documento.id, archivo)
      setOpId(creada.id)
      onCambio()
    } catch (error) {
      setErrorArchivo(error instanceof ApiError ? error.message : 'No se pudo enviar el archivo.')
    } finally {
      setEnviando(false)
    }
  }

  const enCurso = enviando || (opId !== null && (!operacion || operacion.resultado === 'en_curso'))
  const etapaFallida = operacion?.pasos.findLast(paso => paso.estado === 'error' && paso.nombre !== 'rollback')?.nombre ?? 'interno'

  if (operacion?.resultado === 'exitoso') {
    return <Modal etiqueta="Documento reemplazado" onClose={onClose} className="modal-result">
      <div className="result-hero">
        <span className="result-check" aria-hidden="true"><Icon name="check" /></span>
        <h2>Documento reemplazado</h2>
        <p>{`La versión v${operacion.version} ya está activa. Las nuevas respuestas usarán solo esta versión.`}</p>
        {operacion.mensaje?.includes('pendiente') && <p className="result-note">La limpieza de la versión anterior quedó pendiente; sus fragmentos ya no se usan en respuestas.</p>}
      </div>
      <div className="modal-actions modal-actions-center"><Button onClick={onClose} autoFocus>Volver a documentos</Button></div>
    </Modal>
  }

  if (operacion && operacion.resultado !== 'en_curso') {
    return <Modal etiqueta="No se pudo reemplazar el documento" onClose={onClose} className="modal-replace-error">
      <div className="modal-head modal-head-status">
        <h2><span className="status-x" aria-hidden="true"><Icon name="close" /></span>No se pudo reemplazar el documento</h2>
      </div>
      <div className="danger-box danger-box-strong" role="alert">
        <Icon name="error" filled />
        <p>
          {`Falló ${ETAPAS[etapaFallida] ?? 'la indexación'}.`} {version ? `Se conserva la versión v${version} con sus ${activos} fragmentos.` : 'El documento sigue sin una versión disponible.'}
          <br />{`Los fragmentos de la versión v${operacion.version} no se publicaron y no aparecerán en respuestas.`}
        </p>
      </div>
      <p className="error-detail">Detalle técnico: {operacion.pasos.find(paso => paso.nombre === etapaFallida)?.detalle ?? operacion.mensaje}</p>
      <div className="modal-actions">
        <Button variant="outline" onClick={onClose}>Cerrar</Button>
        <Button variant="olive" onClick={() => { setOpId(null); void reemplazar() }} autoFocus>Reintentar</Button>
      </div>
    </Modal>
  }

  return <Modal etiqueta="Reemplazar documento" onClose={onClose} bloqueado={enCurso} className="modal-replace">
    <div className="modal-head">
      <h2>Reemplazar documento</h2>
      <button className="icon-button" aria-label="Cerrar" onClick={onClose} disabled={enCurso}><Icon name="close" /></button>
    </div>
    <p className="modal-label">Documento que se reemplazará</p>
    <div className="doc-card">
      <IconoArchivo />
      <div>
        <strong>{documento.titulo}</strong>
        <span>{documento.id}. {version ? `v${version}` : 'sin versión activa'}. cargado el {fechaTexto(documento.fechaCarga)}. {activos} fragmentos activos</span>
      </div>
    </div>
    <p className="modal-label">Nuevo archivo aprobado</p>
    <div className="doc-card doc-card-new">
      <Icon name="draft" />
      <strong>{archivo?.name ?? 'Ningún archivo seleccionado'}</strong>
      <button type="button" className="button-change" disabled={enCurso} title={`Nueva versión del artículo ${documento.articuloId} en JSON kb_article_v2`} onClick={() => input.current?.click()}>{archivo ? 'Cambiar' : 'Seleccionar'}</button>
      <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-label="Seleccionar el nuevo artículo JSON" accept=".json,application/json" onChange={event => {
        const elegido = event.target.files?.[0] ?? null
        event.target.value = ''
        if (!elegido) return
        const problema = validarArchivo(elegido, maxBytes)
        setErrorArchivo(problema)
        setArchivo(problema ? null : elegido)
      }} />
    </div>
    {errorArchivo && <p role="alert" className="field-error modal-field-error">{errorArchivo}</p>}
    <div className="warning-box">
      <Icon name="warning" filled />
      <p>Política de sustitución total: al terminar la reindexación, los {activos} fragmentos actuales dejarán de usarse en nuevas respuestas.</p>
    </div>
    <label className="confirm-check">
      <input type="checkbox" checked={confirmado} disabled={enCurso} onChange={event => setConfirmado(event.target.checked)} />
      <span>Confirmo que este archivo es la versión aprobada y que reemplaza al documento indicado.</span>
    </label>
    {enCurso && <div className="processing-note" role="status">
      <Spinner />
      <span>Reindexando{operacion?.version ? ` v${operacion.version}` : ''}. {version ? `La versión v${version} sigue activa hasta que termine.` : ''}</span>
    </div>}
    <Pasos operacion={operacion} />
    <div className="modal-actions">
      <Button variant="outline" onClick={onClose} disabled={enCurso}>Cancelar</Button>
      <Button onClick={() => void reemplazar()} disabled={!archivo || !confirmado || enCurso}>Reemplazar documento</Button>
    </div>
  </Modal>
}

// --- Eliminación (HU09, imágenes "Eliminar documento", "Éxito eliminado" y "Eliminación incompleta")

function Contador({ titulo, valor, estado }: { titulo: string; valor: string; estado: 'ok' | 'fallo' | 'pendiente' }) {
  const icono = estado === 'ok' ? 'check_circle' : estado === 'fallo' ? 'cancel' : 'schedule'
  return <div className={`counter-tile counter-${estado}`}>
    <Icon name={icono} filled={estado === 'fallo'} />
    <div><strong>{titulo}</strong><span>{valor}</span></div>
  </div>
}

export function DialogoEliminacion({ documento, onClose, onCambio }: { documento: DocumentoResumen; onClose: () => void; onCambio: () => void }) {
  const [confirmado, setConfirmado] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [operacion, setOperacion] = useState<Operacion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [verRegistro, setVerRegistro] = useState(false)
  const fragmentos = documento.fragmentos ?? 0

  async function eliminar() {
    setEnviando(true)
    setError(null)
    try {
      const respuesta = await eliminarDocumento(documento.id)
      setOperacion(respuesta.operacion)
    } catch (fallo) {
      setError(fallo instanceof ApiError ? fallo.message : 'No se pudo eliminar el documento.')
    } finally {
      setEnviando(false)
      onCambio()
    }
  }

  if (verRegistro && operacion) return <DialogoRegistro operacion={operacion} onClose={() => setVerRegistro(false)} />

  if (operacion) {
    const c = operacion.contadores
    const exito = operacion.resultado === 'exitoso'
    const frag = c.fragmentos ?? { hechos: 0, total: 0 }
    const emb = c.embeddings ?? { hechos: 0, total: 0 }
    const tiles = <div className="counter-row">
      <Contador titulo="Fragmentos" valor={`${frag.hechos} de ${frag.total}`} estado={frag.hechos === frag.total ? 'ok' : 'fallo'} />
      <Contador titulo="Embeddings" valor={`${emb.hechos} de ${emb.total}`} estado={emb.hechos === emb.total ? 'ok' : 'fallo'} />
      <Contador titulo="Registro" valor={c.registro === 'retirado' ? 'Retirado' : 'Pendiente'} estado={c.registro === 'retirado' ? 'ok' : 'pendiente'} />
    </div>
    if (exito) {
      return <Modal etiqueta="Documento eliminado" onClose={onClose} className="modal-deleted">
        <div className="result-hero">
          <span className="result-check result-check-outline" aria-hidden="true"><Icon name="check" /></span>
          <h2 className="font-editorial">Documento eliminado</h2>
          <p>Ya no aparecerá como fuente ni se usará como contexto en nuevas consultas.</p>
        </div>
        {tiles}
        <RegistroTecnico operacion={operacion} />
        <div className="modal-actions">
          <Button variant="outline" onClick={() => setVerRegistro(true)}>Ver registro completo</Button>
          <Button onClick={onClose} autoFocus>Volver a documentos</Button>
        </div>
      </Modal>
    }
    return <Modal etiqueta="Eliminación incompleta" onClose={onClose} className="modal-partial">
      <div className="modal-head modal-head-status">
        <h2><span className="status-x" aria-hidden="true"><Icon name="close" /></span>Eliminación incompleta</h2>
        <button className="icon-button" aria-label="Cerrar" onClick={onClose}><Icon name="close" /></button>
      </div>
      {tiles}
      <div className="danger-box" role="alert">
        <Icon name="cancel" filled />
        <p>{operacion.mensaje}</p>
      </div>
      <p className="lock-note"><Icon name="lock" />El documento queda bloqueado para consultas hasta completar la eliminación.</p>
      <RegistroTecnico operacion={operacion} />
      <div className="modal-actions">
        <Button variant="outline" onClick={onClose}>Cerrar</Button>
        <Button variant="olive" onClick={() => { setOperacion(null); void eliminar() }} disabled={enviando} autoFocus>Reintentar</Button>
      </div>
    </Modal>
  }

  return <Modal etiqueta="¿Eliminar este documento?" onClose={onClose} bloqueado={enviando} className="modal-delete">
    <span className="delete-icon" aria-hidden="true"><Icon name="delete" /></span>
    <h2 className="font-editorial delete-title">¿Eliminar este documento?</h2>
    <div className="doc-card doc-card-center">
      <strong title={`${documento.titulo} · ${documento.articuloId}`}>{documento.nombre}</strong>
      <span>{documento.id} - cargado el {fechaCorta(documento.fechaCarga)} - {fragmentos} fragmentos</span>
    </div>
    {documento.estado === 'bloqueado' && <p className="lock-note"><Icon name="lock" />Una eliminación anterior quedó incompleta. Confirma para reintentarla.</p>}
    <div className="danger-box">
      <Icon name="warning" />
      <p>Se eliminarán sus {fragmentos} fragmentos y embeddings del índice. Las consultas dejarán de usar este documento como fuente.</p>
    </div>
    <label className="confirm-check">
      <input type="checkbox" checked={confirmado} disabled={enviando} onChange={event => setConfirmado(event.target.checked)} />
      <span>Entiendo las consecuencias y confirmo que este documento está retirado.</span>
    </label>
    {error && <p role="alert" className="field-error modal-field-error">{error}</p>}
    {enviando && <div className="processing-note" role="status"><Spinner /><span>Retirando fragmentos, embeddings y registro…</span></div>}
    <div className="modal-actions">
      <Button variant="outline" onClick={onClose} disabled={enviando}>Cancelar</Button>
      <Button variant="danger" onClick={() => void eliminar()} disabled={!confirmado || enviando}>Eliminar documento</Button>
    </div>
  </Modal>
}
