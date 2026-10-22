import { useEffect } from 'react'
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom'
import { Header } from './components/Header'
import { DocumentsProvider } from './state/DocumentsProvider'
import { Consulta } from './pages/Consulta'
import { Resultados } from './pages/Resultados'
import { Documentos } from './pages/Documentos'
import { NotFound } from './pages/NotFound'

function Application() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
    const title = pathname === '/' ? 'Consulta' : pathname === '/resultados' ? 'Resultados' : pathname === '/documentos' ? 'Documentos' : 'Página no encontrada'
    document.title = `${title} — Knowledge Desk`
  }, [pathname])
  return <div className="app-shell">
    <a className="skip-link" href="#contenido">Saltar al contenido</a>
    <Header />
    <Routes>
      <Route path="/" element={<Consulta />} />
      <Route path="/resultados" element={<Resultados />} />
      <Route path="/documentos" element={<Documentos />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  </div>
}

export default function App() {
  return <BrowserRouter><DocumentsProvider><Application /></DocumentsProvider></BrowserRouter>
}
