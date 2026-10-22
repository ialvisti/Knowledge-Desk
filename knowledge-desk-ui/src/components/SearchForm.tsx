import { useId, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { MAX_QUESTION_LENGTH, validateQuestion } from '../api/knowledgeQuestion'
import { Button, Icon } from './ui'

export function SearchForm() {
  const id = useId()
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  function submit(event: FormEvent) {
    event.preventDefault()
    // La API rechaza con 422 lo que no cumple el mínimo, así que se comprueba
    // aquí y el usuario recibe el aviso sin gastar una llamada.
    const problem = validateQuestion(query)
    if (problem) { setError(problem); return }
    navigate(`/resultados?${new URLSearchParams({ q: query.trim() })}`)
  }
  return <form onSubmit={submit} className="search-form" role="search" noValidate>
    <label className="sr-only" htmlFor={id}>Escribe tu consulta</label>
    <div className={`search-control ${error ? 'search-invalid' : ''}`}>
      <Icon name="search" />
      <input id={id} value={query} maxLength={MAX_QUESTION_LENGTH} onChange={event => { setQuery(event.target.value); setError(null) }} autoComplete="off" placeholder="Escribe tu consulta aquí..." aria-invalid={error !== null} aria-describedby={error ? `${id}-error` : undefined} />
      <Button type="submit">Buscar</Button>
    </div>
    {error && <p id={`${id}-error`} role="alert" className="field-error">{error}</p>}
  </form>
}
