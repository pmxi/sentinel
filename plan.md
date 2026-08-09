# Sent

## 1. Background / motivation / problems

Sent is a bespoke, privately hosted web email client for Paras. It should feel unburdening: important mail should not disappear inside a chronological deluge of automated updates, while lower-priority mail should remain available rather than being blocked, unsubscribed from, or deleted.

### Current problems

- Personal Gmail and Purdue/Microsoft mail live in separate clients and organizational systems.
- Chronological inboxes give every delivered message roughly equal visual weight.
- Important messages can look like routine broadcasts. Meaning, consequences, deadlines, and likelihood of reply matter more than whether a message was automated.
- Existing folders, labels, categories, and filters are too rigid and provider-specific.
- Existing search is unreliable for searches expressed by meaning rather than exact words.
- Working through thousands of messages manually is laborious and creates cognitive load.

### Product principles

- Sent is a complete client: read, compose, reply, forward, archive, delete, and read/unread state must work without opening Gmail or Outlook.
- Gmail and Microsoft remain the delivery authorities. Sent maintains a synchronized private replica and preserves each provider's native labels, folders, flags, and IDs.
- Sent owns a provider-independent intelligence layer: classifications, summaries, embeddings, feedback, and virtual views.
- Receiving a message is separate from demanding attention. Lower-ranked mail remains searchable and browsable.
- Classification is personal and prompt-driven. It is expected to evolve through prompt versions and feedback.
- False negatives cost more than false positives. Failed or uncertain classifications must remain visible or be promoted, never silently hidden.
- Full message bodies may be sent to hosted LLM and embedding APIs. Attachment contents may also be processed when useful.
- The service is single-user and privately hosted so the same state is available on laptops and phones.

### Initial classification policy

#### L1 — monitor continuously

- Human-authored emails addressed to Paras
- Anything Paras might reply to
- Job offers and job interview offers

L1 is the default attention queue. Mobile notifications should eventually be sent for newly classified L1 mail.

#### L2 — review occasionally

- Wanted automated mail, including reminders, normal alerts, and social-media or LinkedIn notifications
- Sign-in codes
- New-login-location notifications

#### L3 — retain without attention

- Generic marketing and newsletters with no value or meaningful personalization
- NPS surveys
- Scams

### MVP outcome

Paras can connect personal Gmail and Purdue mail, use Sent as the complete client, monitor a high-quality L1 queue, browse L2 or L3 when desired, and search the complete archive using natural-language meaning as well as exact terms and filters.

## 2. MVP implementation plan

### Architecture

Use a responsive web/PWA frontend backed by a single private application service, a background worker, and PostgreSQL with full-text search plus `pgvector`. Provider adapters connect directly to the Gmail API and Microsoft Graph. The application database is Sent's normalized replica and intelligence store; mutations are synchronized back to the originating provider.

```text
Gmail API ---------\
                    > provider adapters -> sync/normalize -> PostgreSQL
Microsoft Graph ---/                              |          | full-text index
                                                   |          | vector index
                                                   v          | classifications
                                             LLM/embedding APIs

Responsive web client <-> Sent API <-> mutation outbox <-> originating provider
```

Keep the deployable system small:

- **Web app:** responsive inboxes, search, reader, composer, settings, and provider OAuth callbacks
- **Application API:** authentication, queries, message rendering, compose/send, and provider-neutral commands
- **Worker:** mailbox synchronization, backfills, parsing, embeddings, LLM classification, retries, and later notifications
- **PostgreSQL:** normalized messages, native provider state, full-text index, vectors, analysis, feedback, sync cursors, and durable job/outbox records
- **Optional object storage:** attachment cache only when caching becomes necessary; initially fetch attachment bytes lazily from the provider

Avoid adding Redis or a separate vector database until PostgreSQL proves insufficient. Durable jobs can initially use PostgreSQL.

### Core data model

- `accounts`: provider, address, encrypted OAuth tokens, status
- `sync_cursors`: Gmail history IDs, Microsoft delta links, webhook state, last successful sync
- `threads`: Sent identity plus provider-specific thread references
- `messages`: account/provider IDs, headers, participants, timestamps, normalized plain text and sanitized HTML, snippet, attachment metadata
- `provider_containers`: account-scoped native labels, folders, categories, and message membership
- `message_state`: read, starred/flagged, draft, deleted, and synchronization version
- `classifications`: L1/L2/L3, explanation, confidence, model, prompt version, timestamp, and override state
- `embeddings`: message or thread vector and embedding-model version
- `feedback`: manual tier changes and optional user explanation for future prompt refinement
- `mutation_outbox`: idempotent provider actions with retry and reconciliation state

Never flatten Gmail labels and Microsoft folders into one lossy field. Preserve them as account-scoped provider state, then implement L1, L2, L3, All Mail, and search as Sent-owned virtual views.

### Provider integration and synchronization

1. Implement Gmail OAuth and Gmail API adapter.
2. Implement Microsoft OAuth and Graph adapter for the Purdue account.
3. Run an initial mailbox backfill, storing normalized messages and native organization.
4. Continue with Gmail history synchronization and Microsoft delta synchronization.
5. Use provider push/change notifications where available, with periodic polling as a recovery path.
6. Reconcile remote edits and retain tombstones so deletions do not resurrect messages.
7. Fetch attachment bytes lazily. Record filenames, types, sizes, and provider references during sync.

Provider commands should expose a common interface such as `markRead`, `setFlagged`, `archive`, `move`, `delete`, `createDraft`, `send`, and `fetchAttachment`, while allowing provider-specific implementations underneath.

### Classification pipeline

For every historical message during backfill and every new or materially updated thread:

1. Parse headers and produce clean plain text from the message body.
2. Remove boilerplate and quoted history when possible, while retaining enough thread context to understand a reply.
3. Call an LLM through a provider-independent interface with the current personal classification prompt.
4. Require structured output containing `tier`, `reason`, `confidence`, `human_authored`, `reply_likely`, and optional extracted action/deadline fields.
5. Store the result with its model and prompt version so mail can be reclassified later.
6. Promote uncertain results rather than burying them. A failed call remains visible in L1 or an explicit Unclassified queue.
7. Treat a manual tier change as an override and feedback example, not merely a transient UI action.

The initial prompt implements the L1/L2/L3 policy above. Prompt editing and bulk reclassification can begin as an admin/settings screen rather than a generalized rules product.

### Search pipeline

Semantic search should be hybrid rather than vector-only:

1. Build PostgreSQL full-text indexes for exact terms, names, addresses, subjects, and body text.
2. Generate embeddings for the historical archive and all new messages or threads.
3. At query time, retrieve lexical and vector candidates in parallel.
4. Merge candidate ranks, then optionally rerank the small combined set with an LLM.
5. Support structured filters for account, correspondent, date, tier, attachment type, and native label/folder.
6. Return the matched passage and a short explanation of why each result matched.

### Client experience

- Make L1 the default home view, with an unread/new count that reflects L1 rather than the entire archive.
- Provide L2, L3, Unclassified, and All Mail as immediately accessible views.
- Show account identity on every message and allow account filtering without making account boundaries dominate the UI.
- Implement thread reading, sanitized HTML rendering, attachment access, compose, reply/reply-all, forward, drafts, sending identity selection, archive, delete, flag, and read/unread.
- Use optimistic local updates backed by the durable mutation outbox; surface synchronization failures instead of silently reverting.
- Make search globally available and accept natural-language queries without requiring special syntax.
- Record manual tier corrections in one action.

### Security and operations

- Restrict the service to one authenticated user; prefer passkeys or another phishing-resistant login.
- Encrypt provider refresh tokens and other secrets separately from ordinary database fields.
- Use TLS, encrypted storage, automated database backups, and tested restoration.
- Never write message bodies, access tokens, sign-in codes, or model request payloads to ordinary application logs.
- Sanitize HTML email and proxy or block remote images by default to reduce tracking and rendering risk.
- Add health checks for provider sync lag, classification failures, expired credentials, outbox failures, and backup age.
- Deploy the app, worker, and PostgreSQL in a private environment with repeatable container-based setup.

### Delivery sequence

1. **Foundation:** application skeleton, database migrations, single-user authentication, deployment, and secret handling
2. **Ingestion:** Gmail and Microsoft connections, historical backfill, incremental synchronization, normalized storage, and attachment metadata
3. **Complete client:** unified views, reader, composer, drafts, sending, message actions, and reliable provider mutation outbox
4. **Automatic sorting:** versioned L1/L2/L3 prompt, structured LLM calls, backfill classification, incoming classification, overrides, and Unclassified safety path
5. **Hybrid search:** full-text indexing, embeddings, natural-language search, filters, rank fusion, and matched passages
6. **Hardening:** sync reconciliation, token refresh recovery, backups, monitoring, mobile layout, and performance tuning
7. **Post-MVP:** installable PWA/mobile notifications for L1, attachment semantic indexing, richer extracted actions/deadlines, and iterative category/prompt refinement

### MVP acceptance criteria

- Both accounts complete an initial sync and remain incrementally synchronized without duplicates or missing messages.
- The entire imported archive is searchable from one interface by exact text and semantic meaning.
- Every successfully processed message has a stored, explainable, versioned L1/L2/L3 classification.
- Uncertain and failed classifications cannot silently disappear into L2 or L3.
- L1 is usable as the primary monitored inbox; L2, L3, and All Mail remain browsable.
- Compose, reply, forward, draft, send, archive, delete, flag, and read/unread work against the correct originating account.
- Manual tier overrides persist across devices and provider resynchronization.
- A database restore and a full provider reconciliation can recover the service without corrupting provider mailboxes.
