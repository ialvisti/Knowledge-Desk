import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { EstadoLocal, IconoLocal, ListaRegistrosLocales } from '../components/documentosLocales'
import { Icon, Spinner } from '../components/ui'
import { VisorJson } from '../components/VisorJson'
import { listarRegistrosLocales, mensajeErrorLocal, obtenerLocal, suscribirLocales, type DocumentoLocal, type RegistroLocal } from '../local/documentos'
import { fechaHora, fechaTexto, plural, tamano } from '../lib/formato'
import { ETIQUETA_TIPO, RUTA_COLECCION_LOCAL } from '../lib/locales'

const EXTRACCION: Record<DocumentoLocal['tipo'], string> = {
  pdf: 'Texto de las páginas del PDF. Sin OCR: las páginas escaneadas como imagen no aportan texto.',
  docx: 'Texto de los párrafos del cuerpo del documento. No incluye encabezados, pies, comentarios ni imágenes.',
  txt: 'Texto del archivo en UTF-8, con los espacios normalizados.',
  json: 'Título y textos de details del artículo kb_article_v2.',
}

async function sha256(archivo: Blob): Promise<string> {
  const resumen = await crypto.subtle.digest('SHA-256', await archivo.arrayBuffer())
  return Array.from(new Uint8Array(resumen), byte => byte.toString(16).padStart(2, '0')).join('')
}

// Visor de un documento de la colección local: el texto extraído, sus
// fragmentos de búsqueda, el archivo original para descargar (los bytes
// guardados, verificados con su SHA-256) y su registro técnico. Se relee en
// cada cambio de la colección: un documento borrado o reemplazado no se sigue
// mostrando con datos anteriores.
export function VisorDocumentoLocal() {
  const { id = '' } = useParams()
  const [cargado, setCargado] = useState<{ id: string; documento: DocumentoLocal | null; registros: RegistroLocal[] } | null>(null)
  const [fallo, setFallo] = useState<{ id: string; mensaje: string } | null>(null)
  const [revision, setRevision] = useState(0)
  const recargar = useCallback(() => setRevision(valor => valor + 1), [])
  useEffect(() => suscribirLocales(recargar), [recargar])
  useEffect(() => {
    let activo = true
    Promise.all([obtenerLocal(id), listarRegistrosLocales()]).then(([documento, registros]) => {
      if (!activo) return
      setCargado({ id, documento, registros: registros.filter(registro => registro.documentoId === id) })
      setFallo(null)
    }, (error: unknown) => { if (activo) setFallo({ id, mensaje: mensajeErrorLocal(error) }) })
    return () => { activo = false }
  }, [id, revision])

  const documento = cargado?.id === id ? cargado.documento : undefined
  const archivo = documento?.archivo ?? null

  const [integridad, setIntegridad] = useState<{ archivo: Blob; calculado: string | null } | null>(null)
  useEffect(() => {
    if (!archivo) return
    let activo = true
    sha256(archivo).then(calculado => { if (activo) setIntegridad({ archivo, calculado }) }, () => { if (activo) setIntegridad({ archivo, calculado: null }) })
    return () => { activo = false }
  }, [archivo])
  const verificado = integridad && integridad.archivo === archivo ? integridad.calculado : undefined

  const [original, setOriginal] = useState<{ archivo: Blob; texto: string } | null>(null)
  const esJson = documento?.tipo === 'json'
  useEffect(() => {
    if (!archivo || !esJson) return
    let activo = true
    archivo.text().then(texto => { if (activo) setOriginal({ archivo, texto }) }, () => {})
    return () => { activo = false }
  }, [archivo, esJson])
  const textoOriginal = original && original.archivo === archivo ? original.texto : null

  const volver = <div className="results-toolbar">
    <Link to={RUTA_COLECCION_LOCAL} className="text-link"><Icon name="arrow_back" />Volver a documentos</Link>
    <Link to="/consulta-local" className="text-link"><Icon name="manage_search" />Buscar en documentos</Link>
  </div>

  if (fallo?.id === id) {
    return <main id="contenido" tabIndex={-1} className="page-container doc-view">
      {volver}
      <section className="error-card error-card-apilada" role="alert"><span className="error-card-icon"><Icon name="draft" /></span><div className="error-card-text">
        <h1>No se pudo leer el documento</h1>
        <p>{fallo.mensaje}</p>
        <button type="button" className="button button-primary error-card-action" onClick={recargar}>Reintentar</button>
      </div></section>
    </main>
  }
  if (documento === undefined) return <main id="contenido" tabIndex={-1} className="page-container doc-view"><p className="loading-line"><Spinner />Abriendo el documento…</p></main>
  if (documento === null) {
    return <main id="contenido" tabIndex={-1} className="page-container doc-view">
      {volver}
      <section className="error-card error-card-apilada"><span className="error-card-icon"><Icon name="draft" /></span><div className="error-card-text">
        <h1>No se encuentra el documento</h1>
        <p>No está guardado en este navegador. Puede haberse eliminado, o se cargó en otro navegador o en otra dirección (localhost y Render guardan documentos distintos).</p>
      </div></section>
      {cargado && cargado.registros.length > 0 && <section className="doc-history" aria-labelledby="historial-local">
        <h2 id="historial-local">Registro técnico</h2>
        <ListaRegistrosLocales registros={cargado.registros} />
      </section>}
    </main>
  }

  return <main id="contenido" tabIndex={-1} className="page-container doc-view">
    {volver}
    <p className="eyebrow">Documento · {ETIQUETA_TIPO[documento.tipo]}</p>
    <h1 className="doc-view-title"><IconoLocal tipo={documento.tipo} grande />{documento.nombre}</h1>
    <p className="doc-view-meta">
      <span>ID <code>{documento.id}</code></span> · v{documento.version} · cargado el {fechaTexto(documento.fechaCarga)} ({fechaHora(documento.fechaCarga)}) · {plural(documento.fragmentos.length, 'fragmento', 'fragmentos')} · {tamano(documento.bytes)} · <EstadoLocal />
    </p>
    <p className="doc-view-meta doc-view-identity">
      SHA-256: <code>{documento.sha256}</code>
      {verificado === undefined
        ? <span className="json-integrity"><Icon name="hourglass_empty" />Verificando…</span>
        : verificado === documento.sha256
          ? <span className="json-integrity json-integrity-ok"><Icon name="verified" filled />Archivo guardado íntegro</span>
          : <span className="json-integrity json-integrity-fail" role="alert"><Icon name="error" filled />{verificado === null ? 'No se pudo verificar el archivo guardado.' : 'El archivo guardado no coincide con su SHA-256.'}</span>}
    </p>
    <div className="doc-view-actions">
      {/* Los bytes guardados, con su nombre real. La URL del Blob se crea al
          pulsar y se revoca después para no retener el archivo en memoria. */}
      <a className="button button-secondary" href="#descargar-original" download={documento.nombre} onClick={event => {
        const url = URL.createObjectURL(documento.archivo)
        event.currentTarget.href = url
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }}><Icon name="download" />Descargar original</a>
    </div>

    {esJson && <section className="doc-json" aria-labelledby="json-local">
      <h2 id="json-local">JSON original de la versión v{documento.version}</h2>
      {textoOriginal === null ? <p className="loading-line"><Spinner />Leyendo el JSON original…</p> : <VisorJson texto={textoOriginal} nombre={documento.nombre} />}
    </section>}

    <section className="doc-text" aria-labelledby="texto-local">
      <h2 id="texto-local">Texto extraído</h2>
      <p className="text-muted doc-text-intro">{EXTRACCION[documento.tipo]}</p>
      <pre className="local-text" role="region" aria-label="Texto extraído" tabIndex={0}>{documento.texto}</pre>
    </section>

    <section className="doc-text" aria-labelledby="fragmentos-local">
      <h2 id="fragmentos-local">Fragmentos</h2>
      <p className="text-muted doc-text-intro">Buscar en documentos compara las palabras de tu pregunta con estos fragmentos.</p>
      {documento.fragmentos.map((fragmento, indice) => <article key={fragmento.id} className="doc-fragment" aria-label={`Fragmento ${indice + 1}`}>
        <p className="doc-fragment-meta"><strong>#{indice + 1}</strong> · <code>{fragmento.id}</code> · {plural(fragmento.texto.length, 'carácter', 'caracteres')}</p>
        <details><summary>Texto del fragmento</summary><p className="doc-fragment-text">{fragmento.texto}</p></details>
      </article>)}
    </section>

    <section className="doc-history" aria-labelledby="historial-local">
      <h2 id="historial-local">Registro técnico</h2>
      {cargado?.registros.length ? <ListaRegistrosLocales registros={cargado.registros} limite={10} /> : <p className="text-muted">Sin operaciones registradas.</p>}
    </section>
  </main>
}
