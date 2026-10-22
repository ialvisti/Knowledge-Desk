import { createContext, useContext } from 'react'
import type { KnowledgeDocument } from '../types'

export interface UploadReport { added: number; errors: string[] }
interface DocumentsContextValue {
  documents: KnowledgeDocument[]
  addFiles: (files: File[]) => UploadReport
}
export const DocumentsContext = createContext<DocumentsContextValue | null>(null)
export function useDocuments() {
  const context = useContext(DocumentsContext)
  if (!context) throw new Error('DocumentsProvider is required')
  return context
}
