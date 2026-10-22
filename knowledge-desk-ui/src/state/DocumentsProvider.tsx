import { useEffect, useRef, useState, type ReactNode } from 'react'
import { initialDocuments, validateDocument } from '../data/demo'
import type { KnowledgeDocument } from '../types'
import { DocumentsContext, type UploadReport } from './documents-context'

export function DocumentsProvider({ children }: { children: ReactNode }) {
  const [documents, setDocuments] = useState(initialDocuments)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  function addFiles(files: File[]): UploadReport {
    const errors: string[] = []
    const added: KnowledgeDocument[] = []
    for (const file of files) {
      const error = validateDocument(file)
      if (error) { errors.push(error); continue }
      const now = new Date()
      const uploadedAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      added.push({ id: crypto.randomUUID(), name: file.name, uploadedAt, fragments: null, status: 'processing', simulated: true })
    }
    if (added.length) {
      setDocuments(current => [...added, ...current])
      const ids = new Set(added.map(doc => doc.id))
      // Only metadata is retained. No File objects, parsing, uploads, or storage.
      const timer = setTimeout(() => {
        setDocuments(current => current.map(doc => ids.has(doc.id) ? { ...doc, status: 'indexed' } : doc))
        timers.current = timers.current.filter(entry => entry !== timer)
      }, 1500)
      timers.current.push(timer)
    }
    return { added: added.length, errors }
  }
  return <DocumentsContext.Provider value={{ documents, addFiles }}>{children}</DocumentsContext.Provider>
}
