import { useNavigate } from 'react-router-dom'
import { SearchForm } from '../components/SearchForm'
import { DemoNote } from '../components/ui'
import { suggestions } from '../data/questions'
export function Consulta() {
  const navigate = useNavigate()
  return <main id="contenido" tabIndex={-1} className="consultation-page page-container">
    <div className="consultation-content">
      <div>
        <h1>¿Qué necesitas saber?</h1>
        <p className="consultation-description">Busca en el conocimiento indexado para encontrar respuestas rápidas y precisas sobre políticas, procedimientos y guías internas.</p>
      </div>
      <SearchForm />
      <div className="suggestions">
        <h2 className="eyebrow">Ejemplos sugeridos</h2>
        <div className="suggestion-list">
          {suggestions.map(suggestion => <button key={suggestion} onClick={() => navigate(`/resultados?${new URLSearchParams({ q: suggestion })}`)} className="suggestion-chip">{suggestion}</button>)}
        </div>
      </div>
    </div>
    <div className="consultation-footnote"><DemoNote>Conectado al índice de conocimiento · Respuestas generadas por el modelo</DemoNote></div>
  </main>
}
