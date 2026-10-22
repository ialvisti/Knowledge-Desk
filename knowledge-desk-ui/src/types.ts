export type DocumentStatus = 'indexed' | 'processing' | 'error'
export interface KnowledgeDocument {
  id: string
  name: string
  uploadedAt: string
  fragments: number | null
  status: DocumentStatus
  simulated?: boolean
}
