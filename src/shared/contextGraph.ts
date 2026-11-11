/** Renderer contract: references are opaque digests; no titles, paths, transcripts or exception messages. */
export interface ContextGraphSettings { enabled: boolean; workspaces: string[] }
export type ContextGraphError = 'sqlite-unavailable' | 'storage-error' | 'unsupported-schema' | 'closed' | 'quota-exceeded';
export interface ContextGraphStatus {
  state: 'enabled' | 'disabled' | 'unavailable';
  enabled: boolean;
  workspaceId: string;
  sessionId: string;
  countsAvailable: boolean;
  counts: { nodes: number; edges: number; archivedNodes: number; archivedEdges: number };
  limits: { nodes: number; edges: number; bytes: number; retrievalNodes: number; retrievalEdges: number };
  lastProvenance: { origin: 'user' | 'worker' | 'import' | 'test'; reference: string; at: number } | null;
  error: ContextGraphError | null;
}
export interface ContextGraphMetadata {
  status?: 'pending' | 'active' | 'passed' | 'failed' | 'done'; count?: number; digest?: string;
  confidence?: number; sourceVersion?: number;
}
export interface ContextGraphProvenance { origin: 'user' | 'worker' | 'import' | 'test'; reference: string }
export type ContextGraphNodeKind = 'topic' | 'worker' | 'task' | 'artifact' | 'test' | 'decision' | 'source' | 'branch' | 'commit' | 'handoff';
export type ContextGraphRelation = 'topic-worker' | 'topic-task' | 'worker-artifact' | 'artifact-test' | 'decision-topic' | 'artifact-source' | 'branch-commit' | 'topic-artifact' | 'topic-handoff';
interface RecordVersion { createdAt: number; updatedAt: number; version: number; archived: boolean }
export interface ContextGraphNode extends RecordVersion {
  topicId: string; id: string; kind: ContextGraphNodeKind; metadata: ContextGraphMetadata; provenance: ContextGraphProvenance;
}
export interface ContextGraphEdge extends RecordVersion {
  topicId: string; from: string; to: string; relation: ContextGraphRelation; metadata: ContextGraphMetadata; provenance: ContextGraphProvenance;
}
export interface ContextGraphSnapshot { schemaVersion: 1; nodes: ContextGraphNode[]; edges: ContextGraphEdge[] }
export interface ContextGraphExport { status: ContextGraphStatus; snapshot: ContextGraphSnapshot }
