import { useId, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { MAX_PREGUNTA } from '../api/servicios'
import { Button, Icon } from './ui'

export function SearchForm() {
  const id = useId()
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  function submit(event: FormEvent) {
    event.preventDefault()
    // HU01: vacío o solo espacios no se envía. El resto de la validación la hace
    // el servidor antes de cualquier recuperación (HU10).
    if (!query.trim()) { setError('Escribe una pregunta para comenzar.'); return }
    navigate(`/resultados?${new URLSearchParams({ q: query.trim() })}`)
  }
  return <form onSubmit={submit} className="search-form" role="search" noValidate>
    <label className="sr-only" htmlFor={id}>Escribe tu consulta</label>
    <div className={`search-control ${error ? 'search-invalid' : ''}`}>
      <Icon name="search" />
      <input id={id} value={query} maxLength={MAX_PREGUNTA} onChange={event => { setQuery(event.target.value); setError(null) }} autoComplete="off" placeholder="Escribe tu consulta aquí..." aria-invalid={error !== null} aria-describedby={error ? `${id}-error` : undefined} />
      <Button type="submit">Buscar</Button>
    </div>
    {error && <p id={`${id}-error`} role="alert" className="field-error">{error}</p>}
  </form>
}
