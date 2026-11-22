# Web-chat

Step 3 added text chat; step 4 supplemented it with [projects and file attachments](files-and-projects.md). Tool execution is available via Work in on a server or connected desktop. The shared React client uses Gravity AIKit 3.4.0; generation is performed by a server worker via Pi AI 1.5.2. All browser requests go to Runoza.

## First conversation.

1. Create a first administrator on the initial setup page using `BOOTSTRAP_TOKEN` from local `.env`, or sign in to an existing account.
2. Open **Settings → Model Providers** at the bottom of the sidebar. This section is available to the system administrator.
3. For OpenRouter, specify `https://openrouter.ai/api/v1`, your own API key. For a compatible server, specify the base address with `/v1`. For a service on a Docker Desktop host, use the `host.docker.internal`, not the `localhost` container.
4. Save the connection: the server will download the directory. Open **Settings → Models** and enable the desired models or groups. Here you can search, bulk operations and reasoning settings. For an API without `/models`, use Add by ID.
5. Click **New Conversation** in the sidebar, select a model next to the input field, write a message, and click **Send. **The conversation is created at the first message. **New Conversation ** opens an empty dialogue.

The story is in the sidebar: project conversations are embedded in projects, personal ones are shown separately. Renaming and deleting - the chat header is in the menu. **Generating a different answer creates a neighboring answer to the same question. To change and create a branch preserves the old history and creates a new way. Versions of the response switch directly to the message. The branch button below the message creates a separate conversation in the same project. The reboot restores the last selected conversation for the current user. EN/RU themes and language are available in the sidebar.

You can't delete a conversation during generation: first, stop the answer. Deletion includes messages, branches, launches and events. The administrator doesn't get the right to read other people's private conversations.

## Configuration and update

`PROVIDER_SECRETS_KEY` is a separate random key of 64 hex characters. It encrypts ISP keys and personal MCP credentials and is transmitted to APIs and workers. `SECRETS_KEY` remains the identity/SSO key and is not transferred to the worker. Both keys need to be stored with the backup; replacing the key without re-encrypting makes old secrets inaccessible. The new installer creates both keys. When you upgrade from step 2, add `PROVIDER_SECRETS_KEY` to `.env` once.

Apply migrations with a separate migrate service before launching the updated API and worker. Key requirements and update procedure are given in [Developer Guide](development.md).

HTTP/private endpoints are intentionally supported for local models. Therefore, the connections are managed only by system admin; it is a trusted role that selects network addresses available from API/worker. Unsupported arbitrary headers. OpenRouter is tied to the official endpoint, the key is never returned to the client, the endpoint change requires re-entering the key. Connection verification does not start generation.

## Implementation and rehabilitation

The creation of user/assistant messages, run and change the head conversation are performed by one transaction. `chat_runs` in the state of `queued` simultaneously serves as a durable outbox: the dispatcher worker publishes `chat.run` in pg-boss from singleton key to launch ID. Re-delivery is blocked by the atomic transition queued → running. Idempotent `requestId` is tied to the owner and hash of the request; repetition with the same key does not create a second message, another payload returns conflict.

Worker double-checks the user, feature flag, allowed model and launch status. Partial text and event are stored atomically approximately once every 100 ms. The event contains the current full text, seq and status, so the client replaces snapshot and ignores the already processed seq. API transmits events via SSE, every 500 ms reads PostgreSQL and re-checks the session and owner. Reconnect uses `after=<seq>`; cookies remain HttpOnly. Snapshot conversations and cursors are read in repeatable-read transactions.

Closing the tab or restarting the API does not cancel the worker. Cancel records the terminal state and stops contacting the provider at the nearest check. If the worker is missing, after 60 seconds without heartbeat, the start becomes `failed / WORKER_INTERRUPTED`; the text remains. There is no automatic re-paid request. The user can explicitly create a repeat. The continuation of the same upstream stream after the worker drops is not promised.

## The limits of the first alpha

- By default, 10 active launches per user, one per conversation; 30 attempts to send in 10 minutes. The administrator changes the limit (1-100) to "Administration → Assistant." Takes into account the queue, execution and waiting for permission; check the atomic for the user.
- Messages up to 32,000 characters; context paths up to 120,000 characters; conversations up to about 1,000 thread messages. These are application limitations, not exact tokenizer models: a smaller model context can lead to ISP error.
- The limit of output tokens is determined by the catalog of the model or its administrative redefinition: additional protection of text size is 2,000,000 characters; chat is limited to 10 minutes, agent work is one hour.
- Usage is saved when the adapter receives the provider’s non-zero values. The lack of usage is not replaced by valuation. Cost, organization budgets, and the exact tokenizer have not yet been implemented.
- The list shows the last 200 conversations; full search/pagination is the next iteration. Event history is stored until the conversation is deleted; snapshots increase storage for long answers; Retention/compact will require a separate migration and resync contract.
- Text-based OpenAI Chat Completions stream is supported. Compatibility of a particular model and its extensions is not guaranteed by a single successful test. Tools are available through the workspace. The reasoning received from the provider is saved and shown; image generation and audio are not yet available. Text attachments are implemented in step 4.
- Markdown is displayed without raw HTML and MDX; CSP does not allow arbitrary scripts and external images.The chat client is loaded by a separate chunk after logging in.

## Checks.

`npm run check` checks types, builds, package boundaries, modular tests and licenses. `TEST_DATABASE_URL=... TEST_S3_ENDPOINT=... S3_ACCESS_KEY=... S3_SECRET_KEY=... npm run test:integration` creates random test databases; do not use production credentials.

For manual check after assembly: `TEST_DATABASE_URL=... node --import tsx tests/manual/chat.ts`. The stand listens only to the loopback and opens by `http://localhost:53019/` (another host name so that its cookies do not intersect with the main installation on 127.0.0.1), creates a temporary database and an artificial user `stage3@example.test` with a password `Runoza-stage3-test-only!`. SIGTERM / SIGINT deletes this stand. The password is only for a one-time local test. By default, it is used without paid fixture.

`RUN_LIVE_MODELS=true` additionally performs short queries via OpenRouter and LiteLLM and reads the settings from the ignored `.env.stage0`. This is an obvious paid opt-in, not part of the standard tests.

## Working area

The chat takes up the entire height of the window, the messages are scrolled separately from the input field. Enter sends a message, Shift+Enter adds a line. In the lower Settings menu, the account is available and, according to the role, the providers / administration. Unsaved forms and messages are protected by a warning when leaving. More: [justification and verification of the interface](research/ui-workspace-redesign.md).

## Catalogue and reasoning

The `010_models` migration saves the previous authorized list and adds directory cache and override. The selected reasoning settings are checked on the server and fixed to run before posting to the queue. The change of settings by the administrator does not change the query already made. Details are [models.md](models.md).


## Titles, history and context (6.2)

Settings → Administration → Assistant: Auto name, specific model turned on, or Turned off. The car prefers known small families of models among the included, then the first available; the selected model is shown in the settings. This is a preference list, not a comparison of current prices. The name of a new conversation is generated by the first question (one attempt, up to 15 seconds); if a crash, the abbreviated question remains. Existing and manually renamed conversations are not automatically renamed.

The last run error can be closed. This is stored separately for the user, including the reboot, but the historical error remains in the disclosed run history. Regeneration requires explicit action.

Underneath the answer is a disclosing story with duration, reasoning, and tools. Reasons are only displayed if the provider sends them; old answers are not supplemented by retroactively. Time includes waiting for queues and permissions. Actions of copying Markdown, a separate branch, repeating, and time appear when hovering or keyboard navigation. On touch devices, actions are available without hovering.

A separate branch copies the chosen message path, attachments, and stored reasoning, but not the processes, the work folder, or the launch history. When branched from a question, the question opens as a draft for editing.

The conversation information shows the input context used for the last call and the remainder relative to the model directory. The color changes by 70% and 90%. This is a snapshot of the last request, not an exact count of the next message. Without use or context capacity, the data is missing. The title auxiliary query is not yet included in the conversation statistics.

Before upgrading, use all migrations, including `011_chat_experience`, when the API/worker is stopped.

## Activity and expansion (stage 7)

In the side list, the gray indicator is the queue, the pulsating green is the execution, the orange is the waiting for resolution. Status is available in text in the hint and for the on-screen announcer; reduced-motion turns off animation. The list is updated every three seconds. Once completed, the indicator disappears. [Skills and MCP](extensions.md) are selected by the Extension button next to the model.
