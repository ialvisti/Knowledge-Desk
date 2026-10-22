import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { ApiError, leerOriginal, type Original } from '../api/cliente'
import { detalleDocumento, obtenerOperacion } from '../api/servicios'
import type { DetalleDocumento, Operacion } from '../api/tipos'
import { DialogoRegistro, IconoArchivo } from '../components/documentos'
import { Icon, Spinner, StatusBadge } from '../components/ui'
import { VisorJson } from '../components/VisorJson'
import { fechaHora, fechaTexto, plural, tamano } from '../lib/formato'
import { anclaRuta } from '../lib/rutas'

const RESULTADO: Record<string, string> = { en_curso: 'En curso', exitoso: 'Exitoso', fallido: 'Fallido', fallido_parcial: 'Fallido - parcial' }
const TIPO: Record<string, string> = { carga: 'Carga', reemplazo: 'Reemplazo', reintento: 'Reintento', eliminacion: 'Eliminación' }
const NIVEL: Record<string, string> = { critical: 'crítico', high: 'alto', medium: 'medio', low: 'bajo' }

interface EstadoNavegacion { resaltar?: string[]; rutas?: string[] }

// Artículo completo (HU04): se llega desde el nombre en Documentos o desde el
// título o la flecha de una fuente. Muestra la versión concreta que se usó, su
// JSON auténtico (los bytes cargados, verificables con su SHA-256) y los
// fragmentos indexados con las rutas JSON de las que salen.
export function DocumentoCompleto() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const location = useLocation()
  const navegacion = (location.state as EstadoNavegacion | null) ?? {}
  const chunks = useMemo(() => new Set(navegacion.resaltar ?? []), [navegacion.resaltar])
  const versionPedida = params.get('version') ?? [...chunks][0]?.match(/_v(\d+)_(\d+)_chunk_/)?.slice(1).join('.') ?? null
  // Cada dato recuerda qué documento y versión pidió: al cambiar de versión no
  // se muestra ni un instante el JSON de otra.
  const pedido = `${id}@${versionPedida ?? 'vigente'}`
  const [cargado, setCargado] = useState<{ pedido: string; detalle: DetalleDocumento } | null>(null)
  const [original, setOriginal] = useState<{ pedido: string; datos: Original } | null>(null)
  const [fallos, setFallos] = useState<{ pedido: string; documento?: string; original?: string } | null>(null)
  const [registro, setRegistro] = useState<Operacion | null>(null)

  useEffect(() => {
    const controlador = new AbortController()
    const mensaje = (fallo: unknown, defecto: string) => (fallo instanceof ApiError ? fallo.message : defecto)
    detalleDocumento(id, versionPedida).then(datos => {
      if (controlador.signal.aborted) return
      setCargado({ pedido, detalle: datos })
      if (!datos.version.archivoUrl) return
      leerOriginal(datos.version.archivoUrl, controlador.signal).then(leido => setOriginal({ pedido, datos: leido }), (fallo: unknown) => {
        if (!controlador.signal.aborted) setFallos({ pedido, original: mensaje(fallo, 'No se pudo leer el JSON original.') })
      })
    }, (fallo: unknown) => {
      if (!controlador.signal.aborted) setFallos({ pedido, documento: mensaje(fallo, 'No se pudo abrir el documento.') })
    })
    return () => controlador.abort()
  }, [id, versionPedida, pedido])

  const detalle = cargado?.pedido === pedido ? cargado.detalle : null
  const leido = original?.pedido === pedido ? original.datos : null
  const error = fallos?.pedido === pedido ? fallos.documento ?? null : null
  const errorOriginal = fallos?.pedido === pedido ? fallos.original ?? null : null

  const usadosIndices = useMemo(() => {
    if (!detalle) return new Set<number>()
    const prefijo = `_v${detalle.version.version.replace('.', '_')}_chunk_`
    return new Set(detalle.fragmentos.filter(item => [...chunks].some(chunk => chunk.endsWith(`${prefijo}${item.indice}`))).map(item => item.indice))
  }, [detalle, chunks])
  const rutasUsadas = useMemo(() => {
    const rutas = new Set(navegacion.rutas ?? [])
    for (const fragmento of detalle?.fragmentos ?? []) if (usadosIndices.has(fragmento.indice)) fragmento.rutas.forEach(ruta => rutas.add(ruta))
    return [...rutas]
  }, [detalle, usadosIndices, navegacion.rutas])

  if (error) {
    return <main id="contenido" tabIndex={-1} className="page-container doc-view">
      <Link to="/documentos" className="text-link"><Icon name="arrow_back" />Volver a documentos</Link>
      <section className="error-card error-card-apilada"><span className="error-card-icon"><Icon name="draft" /></span><div className="error-card-text"><h1>No se puede abrir el documento</h1><p>{error}</p></div></section>
    </main>
  }
  if (!detalle) return <main id="contenido" tabIndex={-1} className="page-container doc-view"><p className="loading-line"><Spinner />Abriendo el artículo…</p></main>

  const { documento, version, fragmentos } = detalle
  const articulo = version.articulo
  const vigente = version.estado === 'activa' && documento.estado === 'indexado'

  return <main id="contenido" tabIndex={-1} className="page-container doc-view">
    <div className="results-toolbar">
      <button type="button" className="text-link" onClick={() => history.back()}><Icon name="arrow_back" />Volver</button>
    </div>
    <p className="eyebrow">Artículo de conocimiento · JSON kb_article_v2</p>
    <h1 className="doc-view-title"><IconoArchivo grande />{articulo.titulo}</h1>
    <p className="doc-view-meta">
      <span className="doc-view-file">{version.nombre}</span> · {documento.id} · v{version.version} · <code>{articulo.id}</code> · cargado el {fechaTexto(version.cargadoEn)} · {plural(version.fragmentos, 'fragmento', 'fragmentos')} · {tamano(version.bytes)} · <StatusBadge status={documento.estado} />
    </p>
    <p className="doc-view-meta doc-view-identity">
      record_keeper: <code>{articulo.recordKeeper ?? 'null (todos)'}</code> · plan_type: <code>{articulo.planType ?? 'null (todos)'}</code> · esquema: <code>{articulo.schemaVersion ?? 'sin declarar'}</code>
    </p>
    {!vigente && <p className="lock-note doc-view-notice"><Icon name="history" />
      {documento.estado === 'retirado' ? 'Este documento fue retirado: ya no sustenta respuestas.'
        : version.estado === 'reemplazada' ? `Esta versión fue reemplazada por la v${documento.versionActiva}; ya no sustenta respuestas.`
          : 'Esta versión no está disponible para consultas.'}
    </p>}
    {articulo.avisos.length > 0 && <ul className="doc-view-warnings">{articulo.avisos.map(aviso => <li key={aviso}><Icon name="info" />{aviso}</li>)}</ul>}

    <section className="doc-json" aria-labelledby="json-original">
      <h2 id="json-original">JSON original de la versión v{version.version}</h2>
      {!version.archivoUrl
        ? <p className="text-muted">El archivo original ya no está disponible.</p>
        : errorOriginal ? <p role="alert" className="notice notice-error"><Icon name="error" filled />{errorOriginal}</p>
          : !leido ? <p className="loading-line"><Spinner />Leyendo el JSON original…</p>
            : <VisorJson key={pedido} texto={leido.texto} bytes={leido.bytes} sha256Esperado={version.sha256} rutasUsadas={rutasUsadas} descargaUrl={`${version.archivoUrl}&descargar=1`} nombre={version.nombre} />}
    </section>

    <section className="doc-text" aria-labelledby="texto-indexado">
      <h2 id="texto-indexado">Fragmentos indexados</h2>
      <p className="text-muted doc-text-intro">Cada fragmento sale de una o varias rutas del JSON y es lo que el índice usa para responder.</p>
      {fragmentos.length
        ? fragmentos.map(fragmento => {
          const usado = usadosIndices.has(fragmento.indice)
          return <article key={fragmento.indice} className={`doc-fragment ${usado ? 'doc-fragment-used' : ''}`} aria-label={`Fragmento ${fragmento.indice}${usado ? ', usado en la respuesta' : ''}`}>
            {usado && <span className="used-tag"><Icon name="check" />Usado en la respuesta</span>}
            <p className="doc-fragment-meta">
              <strong>#{fragmento.indice} · {fragmento.tipo}</strong> · {fragmento.categoria} · nivel {NIVEL[fragmento.nivel] ?? fragmento.nivel}{fragmento.parte ? ` · parte ${fragmento.parte[0]} de ${fragmento.parte[1]}` : ''}
            </p>
            <p className="doc-fragment-paths">{fragmento.rutas.map(ruta => <a key={ruta} href={`#${anclaRuta(ruta)}`} onClick={event => {
              const destino = document.getElementById(anclaRuta(ruta))
              if (destino) { event.preventDefault(); destino.scrollIntoView({ block: 'center' }) }
            }}><code>{ruta}</code></a>)}</p>
            <details><summary>Texto indexado</summary><p className="doc-fragment-text">{fragmento.texto}</p></details>
          </article>
        })
        : <p className="text-muted">No hay fragmentos indexados para esta versión.</p>}
    </section>

    <section className="doc-history" aria-labelledby="historial">
      <h2 id="historial">Versiones y registro técnico</h2>
      <ul>{detalle.versiones.map(item => <li key={item.version}>
        {item.version === version.version ? <strong>v{item.version}</strong> : <Link to={`/documentos/${documento.id}?version=${item.version}`}>v{item.version}</Link>} · {item.nombre} · {item.estado} · {fechaTexto(item.cargadoEn)}
      </li>)}</ul>
      <table className="history-table">
        <caption className="sr-only">Operaciones del documento</caption>
        <thead><tr><th scope="col">Operación</th><th scope="col">Tipo</th><th scope="col">Fecha</th><th scope="col">Resultado</th></tr></thead>
        <tbody>{detalle.operaciones.map(op => <tr key={op.id}>
          <td><button type="button" className="text-link" onClick={() => obtenerOperacion(op.id).then(datos => setRegistro(datos.operacion))}>{op.id}</button></td>
          <td>{TIPO[op.tipo]}{op.version ? ` v${op.version}` : ''}</td>
          <td>{fechaHora(op.fin ?? op.inicio)}</td>
          <td>{RESULTADO[op.resultado]}</td>
        </tr>)}</tbody>
      </table>
    </section>
    {registro && <DialogoRegistro operacion={registro} onClose={() => setRegistro(null)} />}
  </main>
}
