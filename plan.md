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
- Sent owns a provider-independent intelligence layer: classifications, embeddings, manual overrides, and virtual views.
- Receiving a message is separate from demanding attention. Lower-ranked mail remains searchable and browsable.
- Classification is personal and prompt-driven. It is expected to evolve through prompt versions and manual overrides.
- False negatives cost more than false positives. The prompt should place ambiguous mail in the more important tier, and failed classifications must never be silently hidden.
- Full message bodies may be sent to the OpenAI API for classification and embeddings. Attachment contents may also be processed when useful.
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

Use an online-only responsive web frontend backed by one codebase with separate web and worker entrypoints, plus PostgreSQL with full-text search and `pgvector`. Run both entrypoints from the same container image. Provider adapters connect directly to the Gmail API and Microsoft Graph. The application database is Sent's normalized replica and intelligence store; mutations are synchronized back to the originating provider through a durable outbox.

```text
Gmail API ---------\
                    > provider adapters -> sync/normalize -> PostgreSQL
Microsoft Graph ---/                              |          | full-text index
                                                   |          | vector index
                                                   v          | classifications
                                                OpenAI API

Responsive web client <-> Sent API <-> mutation outbox <-> originating provider
```

Keep the deployable system small:

- **Web app:** responsive inboxes, search, reader, composer, settings, and provider OAuth callbacks
- **Application API:** authentication, queries, message rendering, compose/send, and provider-neutral commands
- **Worker:** mailbox synchronization, backfills, parsing, embeddings, LLM classification, retries, and later notifications
- **PostgreSQL:** normalized messages, native provider state, full-text index, vectors, analysis, manual overrides, sync cursors, and durable job/outbox records
- **Optional object storage:** attachment cache only when caching becomes necessary; initially fetch attachment bytes lazily from the provider

Avoid adding Redis or a separate vector database until PostgreSQL proves insufficient. Durable jobs can initially use PostgreSQL.

### Core data model

- `accounts`: provider, address, encrypted OAuth tokens, status
- `sync_cursors`: Gmail history IDs, Microsoft delta links, and last successful sync
- `threads`: account-scoped Gmail thread IDs or Microsoft conversation IDs; no cross-account thread merging
- `messages`: account/provider IDs, headers, participants, timestamps, normalized plain text and sanitized HTML, snippet, attachment metadata
- `provider_containers`: account-scoped native labels, folders, categories, and message membership
- `message_state`: read, starred/flagged, deleted, and synchronization version
- `drafts`: Sent-owned draft content and sending account; drafts are not synchronized to provider Drafts folders
- `classifications`: model tier, reasoning, optional manual tier override, model, prompt version, and timestamp
- `embeddings`: message or thread vector and embedding-model version
- `mutation_outbox`: idempotent provider actions with retry and reconciliation state

Never flatten Gmail labels and Microsoft folders into one lossy field. Preserve only the provider state needed for correct synchronization; the MVP will not expose custom native label or folder management. Implement L1, L2, L3, All Mail, Sent, Drafts, Trash, and search as Sent-owned views.

### Provider integration and synchronization

1. Implement Gmail OAuth and Gmail API adapter.
2. Implement Microsoft OAuth and Graph adapter for the Purdue account.
3. Run an initial full-archive backfill, storing normalized messages and the native state required for synchronization.
4. Continue with Gmail history synchronization and Microsoft delta synchronization.
5. Poll both providers incrementally every 30–60 seconds. Do not implement provider webhooks or Google Pub/Sub for the MVP.
6. Reconcile remote edits and retain tombstones so deletions do not resurrect messages.
7. Fetch attachment bytes lazily. Record filenames, types, sizes, and provider references during sync.

Provider commands should expose a common interface such as `markRead`, `setFlagged`, `archive`, `delete`, `send`, and `fetchAttachment`, while allowing provider-specific implementations underneath. Drafts remain inside Sent until they are sent.

### Classification pipeline

Use a one-off script to classify the 500 most recent imported messages. The live worker classifies each new message or materially updated thread after that:

1. Parse headers and produce clean plain text from the message body.
2. Remove boilerplate and quoted history when possible, while retaining enough thread context to understand a reply.
3. Call the OpenAI API with the current personal classification prompt.
4. Require strict structured output containing only `{ "reasoning": string, "tier": 1 | 2 | 3 }`.
5. Store the result with its model and prompt version so mail can be reclassified later.
6. Instruct the model to choose the more important tier when a message is ambiguous. A failed call remains visible in L1 or an explicit Unclassified queue.
7. Store a manual tier change as a nullable override while retaining the original model tier and reasoning.

The initial prompt implements the L1/L2/L3 policy above. Historical classification is a manually invoked batch job, not a general server workflow. Prompt editing and later reclassification can begin as a small settings/admin capability rather than a generalized rules product.

### Search pipeline

Semantic search should be hybrid rather than vector-only:

1. Build PostgreSQL full-text indexes for exact terms, names, addresses, subjects, and body text.
2. Generate embeddings for the entire historical archive with a one-off batch script; the live worker embeds new messages.
3. At query time, retrieve lexical and vector candidates in parallel.
4. Merge lexical and vector ranks directly without an LLM reranking call.
5. Support basic structured filters for account, correspondent, date, tier, and attachment presence.
6. Return ordinary highlighted snippets for matching results.

### Client experience

- Make L1 the default home view, with an unread/new count that reflects L1 rather than the entire archive.
- Provide L2, L3, Unclassified, and All Mail as immediately accessible views.
- Show account identity on every message and allow account filtering without making account boundaries dominate the UI.
- Use provider-native conversation grouping within each account; do not merge threads across accounts.
- Implement thread reading, sanitized HTML rendering, attachment access, plain-text compose, reply/reply-all, forward, ordinary file attachments, Sent-owned drafts, sending identity selection, archive, delete, flag, and read/unread.
- Do not implement rich-text composition, inline images, or signatures in the MVP.
- Do not expose custom Gmail label or Outlook folder browsing and management in the MVP.
- Do not implement recipient autocomplete in the MVP; this is tracked in `roadmap.md`.
- Use optimistic local updates backed by the durable mutation outbox; surface synchronization failures instead of silently reverting.
- Make search globally available and accept natural-language queries without requiring special syntax.
- Record manual tier corrections in one action.
- Require a network connection; do not implement offline caches, service workers, or installable PWA behavior.

### Security and operations

- Restrict the service to one deployment-configured password stored as a secure password hash. Use secure cookie sessions and basic login rate limiting; do not build signup, user management, or recovery flows.
- Encrypt provider refresh tokens and other secrets separately from ordinary database fields.
- Use TLS, encrypted storage, automated database backups, and tested restoration.
- Never write message bodies, access tokens, sign-in codes, or model request payloads to ordinary application logs.
- Sanitize HTML email and proxy or block remote images by default to reduce tracking and rendering risk.
- Add health checks for provider sync lag, classification failures, expired credentials, outbox failures, and backup age.
- Expose the web app over public HTTPS and deploy the app, worker, and PostgreSQL in a privately controlled environment with repeatable container-based setup.

### Delivery sequence

1. **Foundation:** application skeleton, database migrations, single-password authentication, deployment, and secret handling
2. **Ingestion:** Gmail and Microsoft connections, full-archive backfill, 30–60 second incremental polling, normalized storage, and attachment metadata
3. **Complete client:** unified views, provider-native threads, reader, composer, Sent-owned drafts, sending, message actions, and reliable provider mutation outbox
4. **Automatic sorting:** versioned L1/L2/L3 prompt, one-off classification of the newest 500 messages, incoming classification, overrides, and Unclassified safety path
5. **Hybrid search:** full-text indexing, one-off full-archive embedding, live embedding, natural-language search, basic filters, rank fusion, and highlighted snippets
6. **Hardening:** sync reconciliation, token refresh recovery, backups, monitoring, mobile layout, and performance tuning

### MVP acceptance criteria

- Both accounts complete an initial sync and remain incrementally synchronized without duplicates or missing messages.
- The entire imported archive is searchable from one interface by exact text and semantic meaning.
- The newest 500 imported messages and all new messages have stored, explainable, versioned L1/L2/L3 classifications.
- Ambiguous mail is conservatively promoted, and failed classifications cannot silently disappear into L2 or L3.
- L1 is usable as the primary monitored inbox; L2, L3, and All Mail remain browsable.
- Compose, reply, forward, draft, send, archive, delete, flag, and read/unread work against the correct originating account.
- Sent drafts synchronize across Sent sessions but are not written to provider Drafts folders.
- Manual tier overrides persist across devices and provider resynchronization.
- A database restore and a full provider reconciliation can recover the service without corrupting provider mailboxes.
