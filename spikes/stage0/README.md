# Stage 0 compatibility lab

This is a disposable compatibility prototype, not the Runoza application. It never uses existing databases or Docker services. Run commands from the repository root with Node 24.22.1 and npm 11.6.2.

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build:spike
npm run test:spike
npm run dev:spike
```

Without environment variables infrastructure/terminal tests explicitly skip. To run the database/storage subset:

```sh
docker compose -p runoza-stage0 -f spikes/stage0/compose.yaml up -d
# Wait for postgres health and the RustFS service to become ready.
STAGE0_DATABASE_URL=postgres://runoza:stage0-local-test@127.0.0.1:55439/runoza_stage0 \
STAGE0_S3_ENDPOINT=http://127.0.0.1:59009 npm run test:spike
```

The fixed test credentials are for the loopback-only lab. Ports 55439 and 59009 must be free. Do not replace the test URL with a production database. Tests create and remove their own schemas and buckets.

```sh
docker compose -p runoza-stage0 -f spikes/stage0/compose.yaml down -v
```

The last command removes only this lab's containers/network and disposable volumes.

## UI checks

Open the Vite URL. Exercise EN/RU, light/dark, streamed Markdown, empty/error states, 500 messages and keyboard focus. Inspect widths 375 and 1400. The prototype now opts into AIKit message virtualization; verify scrolling and focus after any library upgrade. Locale is intentionally in-memory in this lab; profile persistence belongs to the application.

## Live provider check

Create the ignored `.env.stage0` with `OPENROUTER_API_KEY`. Never commit it. Explicit execution only:

```sh
node --import tsx spikes/stage0/live-model.ts
```

Uses `openai/gpt-4.1-nano`, at most two calls per scenario, 256 output tokens per request and 30-second request deadlines. The two scenarios are plain text and a harmless addition tool. The tool probe disables parallel calls and forces the first add call; it does not certify autonomous tool selection. The report contains no credential. API usage can be charged by the provider; this script is not part of default tests. A network failure is not proof of model incompatibility.

Actual local inference and cloud S3 remain future checks; the agreed local stage-0 scope uses LiteLLM/OpenRouter and RustFS. See the result matrix in `docs/research/stage0.md`.

## Extended local acceptance (2026-11-11)

Build and start the terminal and gateway in addition to PostgreSQL/RustFS:

```sh
sh spikes/stage0/build-terminal.sh
docker build -t runoza/litellm:stage0-1.108.5 spikes/stage0/litellm
docker compose -p runoza-stage0 -f spikes/stage0/compose.yaml --profile terminal --profile gateway up -d
STAGE0_DATABASE_URL=postgres://runoza:stage0-local-test@127.0.0.1:55439/runoza_stage0 STAGE0_S3_ENDPOINT=http://127.0.0.1:59009 STAGE0_TERMINAL_A=http://127.0.0.1:58019 STAGE0_TERMINAL_B=http://127.0.0.1:58029 npm run test:spike
node --import tsx spikes/stage0/persistence.ts
node --import tsx spikes/stage0/gateway-probe.ts
npm run build:spike
node --import tsx spikes/stage0/serve-production.ts
```

Wait for all services to become ready. Gateway requires ignored .env.stage0 containing OPENROUTER_API_KEY. Its probe is billable, capped at two requests per scenario and 256 output tokens/request; cancellation is forwarded. It checks automatic tool selection without forcing tool_choice. Context metadata uses the actual model limits; the probe asserts the outgoing response budget.

Production UI server listens on 5174 with CSP. Test hostile Markdown, tool confirmation and virtualized scrolling there. Terminal tests recreate terminal-a; persistence.ts recreates the lab database/storage containers. Never point these scripts at production.

This RustFS and LiteLLM/OpenRouter setup is the user-approved stage-0 scope; it does not certify local inference or cloud S3. The reduced LiteLLM image is lab-only: missing authentication returns 500, not 401.

Cleanup:

```sh
docker compose -p runoza-stage0 -f spikes/stage0/compose.yaml --profile terminal --profile gateway down -v
```
