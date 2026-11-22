# Repository Guidelines

## Project Structure & Module Organization

Runóza is an Apache-2.0 TypeScript npm-workspaces monorepo: `apps/server` (Fastify API), `apps/worker` (jobs), `apps/migrate` (migrations), `apps/web` (Vite), and `apps/desktop` (Electron/native assets).

Shared screens live in `packages/app`, Gravity helpers in `packages/ui`, and adapters in `packages/platform`. Architecture and decisions live in `docs/architecture.md`, `docs/adr/`, and `docs/extensions-guide.md`; Compose in `deploy/compose`; disposable artifacts in ignored `work/`.

## Build, Test, and Development Commands

Use Node **24.22.1** and npm **11.6.2**.

- `npm ci --ignore-scripts`: install locked dependencies.
- `npm run build`: build server packages, web, and desktop frontend.
- `npm run check`: run boundary/format checks, typechecking, builds, unit/UI tests, and license validation.
- `npm test` / `npm run test:ui`: run unit or component tests.
- `npm run test:integration`: run backend integration tests after building.
- `npm start` / `npm run worker`: run compiled API or worker with configured environment.
- `npm run desktop`: launch Electron; `npm run package:desktop` creates a local bundle.

For Compose, follow `docs/upstream-delivery.md`; initialize using `node scripts/init-env.mjs`.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, semicolons, and double quotes. Format with Prettier: `npm run format`. Use PascalCase components and camelCase functions/variables. Respect package import boundaries enforced by `scripts/check-boundaries.mjs`; client packages must not import server modules. Add EN/RU translations together. Append migrations and update the migration registry/schema version rather than rewriting applied migrations.

## Testing Guidelines

Use `node:test`/tsx for unit/integration and Vitest/Testing Library for UI (`*.test.ts`, `*.test.tsx`). Integration requires disposable `TEST_DATABASE_URL` with CREATE DATABASE privileges and scenario fixtures. Never target user data. Cover changed behavior; report skips. No coverage threshold is enforced. Verify UI changes in web/Electron, both themes and languages, including hover, focus, and narrow layouts.

## Commit & Pull Request Guidelines

Use concise imperative commit summaries. PRs should explain behavior, tests, migrations/rollback, link issues, and include UI screenshots with synthetic data. Do not push or publish without explicit authorization.

## Security & Configuration

Exclude environment files, secrets, backups, and user content from Git/logs. Store local diagnostic evidence under `work/`; use relative paths and synthetic identities in tracked docs and fixtures. Preserve live ACL checks, proxied S3 access, and isolated execution. Use pinned upstream images and compatible licenses; avoid dependency patches, npm overrides, or edits to `node_modules`.

## Gravity UI & Branding

Start with [Gravity's ecosystem index](https://gravity-ui.com/llms.txt) and `.agents/skills/gravity-ui/SKILL.md`. Confirm installed versions; consult local `build/docs` and declarations, then versioned `/llms/<package>/<major>/llms.txt`. Prefer documented components and semantic tokens; avoid internal DOM overrides. Use the [theme generator](https://gravity-ui.com/ru/themes) for complete light/dark palettes; exclude external font imports.

Follow `docs/design/visual-refresh-plan.md`. Display **Runóza**; retain `runoza` identifiers. Use the manta assets in `assets/branding/`. Default to dark; preserve preferences.
