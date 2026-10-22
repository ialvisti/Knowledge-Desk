import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ApiError } from '../api/cliente'
import { obtenerFuente } from '../api/servicios'
import type { ArticuloExterno } from '../api/tipos'
import { Icon, Spinner } from '../components/ui'
import { VisorJson } from '../components/VisorJson'

// Artículo de la base de ForUsGuide, administrado fuera de Knowledge Desk.
// ForUsGuide no expone el archivo JSON original de sus artículos: lo que se
// muestra es el JSON de sus fragmentos INDEXADOS, tal como los devuelve el
// índice, y la pantalla lo dice.
export function FuenteExterna() {
  const { articleId = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const resaltar = useMemo(() => new Set<string>((location.state as { resaltar?: string[] } | null)?.resaltar ?? []), [location.state])
  const [articulo, setArticulo] = useState<ArticuloExterno | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let activo = true
    obtenerFuente(articleId).then(datos => {
      if (!activo) return
      if (datos.tipo === 'documento') navigate(`/documentos/${datos.documentoId}?version=${datos.version}`, { replace: true, state: location.state })
      else setArticulo(datos)
    }, (fallo: unknown) => { if (activo) setError(fallo instanceof ApiError ? fallo.message : 'No se pudo abrir la fuente.') })
    return () => { activo = false }
  }, [articleId, navigate, location.state])

  const vista = useMemo(() => {
    if (!articulo) return null
    const datos = {
      article_id: articulo.articleId,
      article_title: articulo.titulo,
      origen: 'fragmentos_indexados',
      fragmentos: articulo.fragmentos.map(fragmento => ({ chunk_id: fragmento.id, chunk_index: fragmento.indice, chunk_type: fragmento.tipo, content: fragmento.contenido })),
    }
    const rutas = articulo.fragmentos.flatMap((fragmento, indice) => (resaltar.has(fragmento.id) ? [`fragmentos[${indice}]`] : []))
    return { texto: JSON.stringify(datos, null, 2), rutas }
  }, [articulo, resaltar])

  if (error) {
    return <main id="contenido" tabIndex={-1} className="page-container doc-view">
      <Link to="/" className="text-link"><Icon name="arrow_back" />Nueva consulta</Link>
      <section className="error-card error-card-apilada"><span className="error-card-icon"><Icon name="draft" /></span><div className="error-card-text"><h1>No se puede abrir la fuente</h1><p>{error}</p></div></section>
    </main>
  }
  if (!articulo || !vista) return <main id="contenido" tabIndex={-1} className="page-container doc-view"><p className="loading-line"><Spinner />Abriendo el artículo…</p></main>

  return <main id="contenido" tabIndex={-1} className="page-container doc-view">
    <div className="results-toolbar"><button type="button" className="text-link" onClick={() => history.back()}><Icon name="arrow_back" />Volver</button></div>
    <p className="eyebrow">Artículo de ForUsGuide · fragmentos indexados</p>
    <h1 className="doc-view-title"><span className="file-badge" aria-hidden="true"><Icon name="menu_book" /></span>{articulo.titulo}</h1>
    <p className="doc-view-meta"><code>{articulo.articleId}</code> · {articulo.fragmentos.length} fragmentos · administrado fuera de Knowledge Desk</p>
    <p className="lock-note doc-view-notice" role="note"><Icon name="info" />
      ForUsGuide no expone el archivo JSON original de este artículo. Lo que ves es el JSON de sus fragmentos indexados, tal como los devuelve el índice: no es el artículo original.
    </p>
    <section className="doc-json" aria-labelledby="json-indexado">
      <h2 id="json-indexado">JSON de los fragmentos indexados</h2>
      <VisorJson texto={vista.texto} rutasUsadas={vista.rutas} nombre={`${articulo.articleId}.fragmentos.json`} />
    </section>
  </main>
}
