import { Link } from 'react-router-dom'
export function NotFound() {
  return <main id="contenido" tabIndex={-1} className="page-container not-found">
    <p className="eyebrow">404</p><h1>Página no encontrada</h1>
    <p>Vuelve al inicio para consultar el archivo documental.</p>
    <Link to="/" className="button button-primary">Volver a Consulta</Link>
  </main>
}
