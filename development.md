
- sign up with google
- connect gmail
- configure prompt
- openai api to classify new emails with prompt
- send telegram message
- hosted at sentinel.parasmittal.com


## Google OAuth setup (project `email-sentinel-mvp`)

- Google Cloud project **email-sentinel-mvp**, Gmail API enabled.
- A **Web** OAuth client; `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`.
- Registered redirect URIs:
  - `http://localhost:8765/oauth/google/callback` (dev)
  - `https://sentinel.parasmittal.com/oauth/google/callback` (prod)
- Consent screen is External + unverified: add your Google account as a **Test
  user**, and expect an "unverified app" warning on the `gmail.readonly`
  restricted scope until verification completes (see external track).

According to Claude, readonly scope on Gmail requires "CASA security assessment" which costs real money.
Fortunately, we can operate in testing with at most 100 users for free.


TODO stop storing email content
TODO .devcontainer is out of date

Problems according to Claude:
  - #2 — encrypt secrets at rest (pairs with splitting the secret out of the config_json JSONB).
  - #5 — Gmail run_local_server interactive-auth fallback can hang the worker.
  - #6 — data-model gaps: alert table + user_id on message/classification (blocks the flagged list).
  - #7 — no persistent cursor (in-memory only; message-table dedup covers restarts). The non-atomic message+classification write is now fixed (`Database.record_classified_message` writes both in one transaction).
  - #8 — LLM cost controls; no test suite.


  UX notes

  