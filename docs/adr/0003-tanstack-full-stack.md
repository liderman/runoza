# ADR 0003: Evaluation of the complete TanStack stack

Date: 13.11.2026 Status: accepted for the current cycle; migration to the full framework is not
performed.

## Decision

Continue to use Query + Form + Router + Virtual in general React UI, with Gravity UI, Fastify,
PostgreSQL / Kysely, pg-boss, Pi and Electron. A full transition to TanStack Start now will not
reduce the server part and complicate the overall build of the web / desktop. This is the
conclusion about Runoza, not a limitation of the license or maturity of Start.

Start is already stable v1: the official documentation directly indicates this. It adds SSR,
server functions/routes and middleware to the Router, supports Vite/Rsbuild and different
hosting methods. These features are useful for a new web product with SSR/public pages. Runoza
is now an authorized workspace; the main value is history, SSE, background work and local host
bridge.

## Comparison of options

| Option. | Possible gains | Cost and risk for Runoza | Decision |
|---|---|---|---|
| Current composite stack | One UI for web/desktop; ready-made HTTP contracts, Queue and ACL; already tested new Query/Form/Router | Explicit API-client/schema boundaries remain | Save. |
| Start for web, current desktop | SSR/server functions, easy data loading | Two entrypoint/build modes, browser/hash routing and auth matching, origin/CSRF/SSO rechecking | Do not implement without the need for SSR |
| Start instead of Fastify | Typed server functions and collaborative server assembly | Moving API, SSE, native device/PTY protocol, multipart/S3 proxy, health and auth; worker/pg-boss/SQL still needed | Not justified by the current task |
| TanStack AI instead of Pi | Unified TS AI adapters, tools/interrupts and agent blocks | Migration of own durable run protocol, approvals, leases, rollback and native RPC; new error model and usage | Separate possible spike if you need a native provider API; now leave Pi |

Neither Start nor TanStack DB replaces PostgreSQL server or server role in multi-user access
control. Server functions also require the same ACL and CSRF; the framework name does not make
these checks automatic.

## Lineage and maturity

The official website and npm metadata 13.11.2026 were checked; all the listed MIT packages were
not automatically installed.

- Query 5, Form 1, Router 1, Virtual 3: used and secured in lockfile.
- Start 1.169.5: stable v1 according to documentation; valued above, not connected.
- AI 1.4.0: new v1 ("fresh" on the site), **not named beta**. provider adapters/agent building blocks are useful, but replacing the engine requires a separate comparison of behavior and real-world models, rather than a single package installation.
- Table 9.3.1: stable major. The directory now consists of groups/cards; Virtual solves its problem. Table add sortable columns, resizing or tabular admins if necessary, agreeing with Gravity.
- DB: the site still tags beta, npm latest — 1.0.0-rc.1.5. Do not connect to the main path. Re-evaluation is required for offline-first/complex live joins; current Query/SSE and server-authoritative writers remain.
- Store 0.11.2: The site marks alpha.Do not add as a separate global store; the Form/Router used manages the necessary internal state.
- Pacer 0.24.1: beta, do not connect without a measurable timing/batching task. Server scheduler and pg-boss are not replaced.
- Hotkeys 0.25.0: beta, already used in the restricted navigation area of the approved step 13. Version is fixed, there are keyboard/dirty guard tests; regular history buttons work independently of the hot keys.
- Ranger 0.0.5: narrow headless range control. A regular Gravity Slider is enough for the reasoning effort; no additional layer is needed.
- Config and Devtools (0.16.0): convenient for ecosystem maintenance and debugging; production SDK/panels are not installed for ecosystem membership.
- Application Starter on alpha: The new project generator is not a way to migrate the existing Runoza.

## When to get back to the decision

Revise Start for public SSR pages, a proven first render problem, or a substantial benefit of
server functions on a prototype with Electron. Revise DB after stable release with mandatory
offline work/replication. For AI, compare two real-world scenarios with Pi: SSE/tool
interruption and failure recovery without re-executing the command.

Sources: https://tanstack.com/start/latest/docs/framework/react/overview.md,
https://tanstack.com/ai/latest, https://tanstack.com/table/latest,
https://tanstack.com/db/latest, https://tanstack.com/store/latest,
https://tanstack.com/pacer/latest, https://tanstack.com/hotkeys/latest,
https://tanstack.com/ranger/latest, https://tanstack.com/config/latest. Versions/licenses are
verified from registry.npmjs.org; local image metadata — work/stage21-package-metadata.json.
