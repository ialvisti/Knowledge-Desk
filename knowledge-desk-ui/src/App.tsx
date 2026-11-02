import { useEffect } from 'react'
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom'
import { Header } from './components/Header'
import { Consulta } from './pages/Consulta'
import { ConsultaLocal } from './pages/ConsultaLocal'
import { DocumentoCompleto } from './pages/DocumentoCompleto'
import { VisorDocumentoLocal } from './pages/DocumentoLocal'
import { Documentos } from './pages/Documentos'
import { FuenteExterna } from './pages/FuenteExterna'
import { NotFound } from './pages/NotFound'
import { Resultados } from './pages/Resultados'
import { ProveedorServidor } from './state/servidor'

const TITULOS: [RegExp, string][] = [
  [/^\/$/, 'Consulta'],
  [/^\/resultados$/, 'Resultados'],
  [/^\/consulta-local$/, 'Buscar en documentos'],
  [/^\/documentos$/, 'Documentos'],
  [/^\/documentos\/local\//, 'Documento'],
  [/^\/documentos\//, 'Documento completo'],
  [/^\/fuentes\//, 'Fuente documental'],
]

function Application() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
    const titulo = TITULOS.find(([patron]) => patron.test(pathname))?.[1] ?? 'Página no encontrada'
    document.title = `${titulo} — Knowledge Desk`
  }, [pathname])
  return <div className="app-shell">
    <a className="skip-link" href="#contenido">Saltar al contenido</a>
    <Header />
    <Routes>
      <Route path="/" element={<Consulta />} />
      <Route path="/resultados" element={<Resultados />} />
      <Route path="/consulta-local" element={<ConsultaLocal />} />
      <Route path="/documentos" element={<Documentos />} />
      {/* Colección local del navegador: antes que la ruta del documento del servidor. */}
      <Route path="/documentos/local/:id" element={<VisorDocumentoLocal />} />
      <Route path="/documentos/:id" element={<DocumentoCompleto />} />
      <Route path="/fuentes/:articleId" element={<FuenteExterna />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  </div>
}

export default function App() {
  return <BrowserRouter><ProveedorServidor><Application /></ProveedorServidor></BrowserRouter>
}
