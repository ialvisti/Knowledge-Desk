import { useEffect } from 'react'
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom'
import { Header } from './components/Header'
import { Consulta } from './pages/Consulta'
import { DocumentoCompleto } from './pages/DocumentoCompleto'
import { Documentos } from './pages/Documentos'
import { FuenteExterna } from './pages/FuenteExterna'
import { NotFound } from './pages/NotFound'
import { Resultados } from './pages/Resultados'
import { ProveedorServidor } from './state/servidor'

const TITULOS: [RegExp, string][] = [
  [/^\/$/, 'Consulta'],
  [/^\/resultados$/, 'Resultados'],
  [/^\/documentos$/, 'Documentos'],
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
      <Route path="/documentos" element={<Documentos />} />
      <Route path="/documentos/:id" element={<DocumentoCompleto />} />
      <Route path="/fuentes/:articleId" element={<FuenteExterna />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  </div>
}

export default function App() {
  return <BrowserRouter><ProveedorServidor><Application /></ProveedorServidor></BrowserRouter>
}
