# Context Graph runtime contract

The graph is optional local metadata, separate from topic memory and provider conversations. Existing and new configurations default to `contextGraph: { enabled: false, workspaces: [] }`. There is no graph SQLite load, directory creation, backfill, transcript ingestion or prompt injection while disabled. Enabling a workspace starts recording only subsequent accepted structured writes.

## Scope and IPC

Use the four methods exposed by `window.hub` / `HubApi`. All take the **stable hub session id** from the current snapshot, not a provider conversation id, topic id or filesystem path. The trusted-page IPC wrapper rejects other senders. Main resolves the session's current directory against configured workspace roots, canonicalizes symlinks and rejects sessions outside those roots. The longest matching root wins.

| HubApi method | IPC channel | Result |
| --- | --- | --- |
| `contextGraphStatus(id)` | `context-graph:status` | `ContextGraphStatus` |
| `contextGraphSetEnabled(id, enabled)` | `context-graph:set-enabled` | `ContextGraphStatus` |
| `contextGraphExportSnapshot(id)` | `context-graph:export-snapshot` | `{ status, snapshot }` |
| `contextGraphPurge(id)` | `context-graph:purge` | `ContextGraphStatus` |

The exact shared types are in `src/shared/contextGraph.ts`; `src/shared/types.ts` declares the methods. Invalid/unknown session ids, out-of-workspace sessions and nonboolean enable arguments reject the invocation. UI should show a short generic failure and refresh its selected session. No arbitrary path, export destination, SQL, node payload or worker-selected session id crosses these APIs.

Enabling/disabling applies to the selected session's **workspace**, including its other sessions. Export/purge apply only to the selected **workspace + stable session** partition. Switching the provider's conversation leaves this partition intact. Moving a session into another workspace changes the partition. Disabled export/purge are explicit local operations and may open SQLite without enabling ingestion. No export file is written automatically: UI receives structured JSON and can offer an explicit save/copy action.

## Status

- `state`: `disabled`, `enabled` or `unavailable`.
- `enabled`: persisted workspace opt-in. It remains `true` when enabled storage fails, so the UI can distinguish unavailable storage from a user's disabled choice.
- `workspaceId`, `sessionId`: opaque SHA-256 references, never paths or names.
- `counts`: `nodes`, `edges`, `archivedNodes`, `archivedEdges`. Total counts include archived rows.
- `countsAvailable`: false means the database was not read; do not display zero as proof that persisted data is absent. This is normal for disabled status after handles close.
- `limits`: 10,000 nodes, 30,000 edges and 16 MiB SQLite pages **per partition**; retrieval at most 50 nodes / 100 edges.
- `lastProvenance`: origin, opaque source reference and storage update timestamp, or null when unknown/empty. Do not try to render source text or resolve it as a path.
- `error`: null or a safe code: `sqlite-unavailable`, `storage-error`, `unsupported-schema`, `closed`, `quota-exceeded`. Native exception messages and private content are never returned.

Status may initialize storage only for an enabled workspace. `setEnabled` persists opt-in before opening storage. Disabling closes all handles of that workspace and preserves its data. Ordinary settings patches cannot enable the feature; use the dedicated method. SQLite errors fail closed: reads return empty snapshots with an unavailable status, writes stop, existing files are preserved. A user toggle retries initialization. There is no fallback to JSON or another provider.

Snapshot export is deterministic when graph data does not change. Repeated purge converges to an empty graph and does not change opt-in. Purge affects only graph records: it does not erase topic memory, provider conversations, attachments or other sessions. There is no automatic archive pruning. Lower-level storage preserves the explicit archive/restore/delete-archived behavior.

## Structured ingestion and retrieval

Only successful `topic_memory update`, `decision` and `compact` actions trigger graph writes. `remember`, reads, user messages, worker reports and transcripts do not. Each accepted operation records its nodes/edges in one SQLite transaction. A graph failure never rejects an already accepted topic-memory operation.

The runtime records topic/worker associations, task and artifact identities, decision identities and handoff identities. All names, source references, task text, decision text, summaries and artifact paths become opaque hashes/digests. Stored metadata is restricted to numeric source version, confidence, supported status/count and SHA-256 digests. Dates and graph versions are stored on each record. Runtime provenance origin is `worker`, meaning an accepted explicit agent tool write; it does not claim independently verified user authorship. Confidence `1` attests that this structural record was explicitly supplied, not that its underlying assertion is true. Hash references are not a secrets vault or a guarantee against guessing low-entropy inputs; callers must still supply anonymized data.

The `context_graph` tool performs explicit retrieval for one topic, most recently updated records first with stable ties and the topic node first. Default: 20 nodes; maximum: 50 nodes and 100 connecting edges. Only edges whose two active endpoints fit the node budget are included. Archived nodes/edges are excluded. Workers may retrieve only their currently assigned topic; the master retrieves within its own session partition. There is no cross-session aggregation, semantic search, raw labels, automatic prompt injection or LLM/provider call. UI export is the explicit full-partition path and is bounded by storage quotas rather than retrieval limits.

## Validation

Synthetic tests cover disabled side effects, opt-in persistence, SQLite unavailability, quotas, archive behavior, idempotent writes/export/purge, transactional rollback, workspace/session/topic isolation, symlink escapes, argument validation and worker topic authorization. No installed-app profile, real provider or user dataset is accessed.
