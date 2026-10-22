import { useCallback, useEffect, useState } from 'react'
import { KnowledgeQuestionError, askKnowledgeQuestion, forgetAnswer, validateQuestion, type KnowledgeAnswer } from '../api/knowledgeQuestion'

export type AnswerStatus = 'idle' | 'invalid' | 'loading' | 'ready' | 'failed'

interface Snapshot {
  status: AnswerStatus
  answer: KnowledgeAnswer | null
  message: string | null
}

export interface AnswerState extends Snapshot {
  retry: () => void
}

interface Tracked extends Snapshot {
  key: string
}

function initial(question: string): Snapshot {
  if (!question) return { status: 'idle', answer: null, message: null }
  const problem = validateQuestion(question)
  if (problem) return { status: 'invalid', answer: null, message: problem }
  return { status: 'loading', answer: null, message: null }
}

export function useKnowledgeAnswer(question: string): AnswerState {
  const [attempt, setAttempt] = useState(0)
  const key = `${attempt}:${question}`
  const [resolved, setResolved] = useState<Tracked | null>(null)
  // El estado guardado sólo vale para la pregunta que lo produjo. Al cambiar la
  // consulta la vista vuelve a su estado de partida durante el render, sin
  // esperar a que el efecto ponga el indicador de carga.
  const current = resolved && resolved.key === key ? resolved : initial(question)

  useEffect(() => {
    // Volver a una pregunta ya resuelta no debe disparar otra consulta: un fallo
    // guardado se relanzaba solo y sustituía el aviso sin que nadie lo pidiera.
    if (resolved && resolved.key === key) return
    if (initial(question).status !== 'loading') return
    let active = true
    askKnowledgeQuestion(question).then(
      answer => { if (active) setResolved({ key, status: 'ready', answer, message: null }) },
      (error: unknown) => {
        if (!active) return
        const message = error instanceof KnowledgeQuestionError ? error.message : 'No se pudo completar la consulta.'
        setResolved({ key, status: 'failed', answer: null, message })
      },
    )
    return () => { active = false }
  }, [question, key, resolved])

  const retry = useCallback(() => {
    forgetAnswer(question)
    setAttempt(value => value + 1)
  }, [question])

  return { status: current.status, answer: current.answer, message: current.message, retry }
}
