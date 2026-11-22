# Runoza development cycle: stages 10–21

Approved 12.11.2026. Everything is local, without push and publication. Gravity UI, Fastify,
Kysely, pg-boss, Pi and Electron are saved until a separate evaluation shows the benefit of
replacement. Delivery - ready-made upstream images on upstream-delivery.md; historical audit of
custom images does not block the beginning of this cycle. Do not return backport patches, npm
overrides or editing node_modules. The remaining upstream risks are reflected in the current
security documentation.

| Phase | Volume | Completion criterion |
|---|---|---|
| 10.Basic UI checks | Testing Library/user-event, component regressions, browser matrix, UX skills study | Reproduced checks of main scenarios; web/desktop, RU/EN, two themes, hover/focus/keyboard and narrow windows |
| 11. Query | Single server data cache, mutations, SSE matching, exit clearing, and user separation | Lists and open pages are agreed; reconnection does not repeat actions |
| 12. Form + schemas | Providers, models, SSOs, jobs; Zod is consistent with Fastify schemes | Creating/editing, secrets, undoing, dirty/reset and errors behave the same way |
| 13. Router + Hotkeys | Page addresses, history, deep links, transition blocking; keyboard command registry | In the desktop, immediately after the system buttons - back/forward icons, disabled/tooltip/focus and no-drag area; history and form protection work |
| 14. Better Auth | Local Login, SSO, Sessions, Devices and Browser Login Desktop | Migration of existing users and passwords verified; roles and ACL Runoza saved; backup/rollback; no mandatory external service |
| 15. models.dev + catalogue | Local snapshot of models/providers/prices; manual overrides; adapters; Table + Virtual | A large directory has search, groups, mass actions, and stable order; the provider is considered supported only after protocol tests. |
| 16. OpenTelemetry | API/queue/model/tool/executor; local browsing | Delays and errors are localized; the standard collection does not contain messages and secrets. |
| 17. Streamdown | Comparative experiment with the current AIKit renderer | Solution for speed, streaming Markdown, security, themes and cost of integration; replacement only with proven benefits |
| 18 Permits + LLM arbitrator | Once/conversation/limited permanent rule; recall; Confirm for me mode | Administrator includes function and selects model; arbitrator is limited to policies; failure/uncertainty/error leads to person; audit and immutability of confirmed action verified |
| Background designer | What/when/where/report or act/where the result/up to what condition | Unified UX on existing robust execution; see authority, source, history, offline-device, and waiting for confirmation |
| Final verification | Remove old implementations, update with data, restore, load, and UI | Matrix passed; restrictions explicitly listed; local delivery reproducible |
| 21.Evaluation of the full TanStack stack | Evaluate the stable components of the ecosystem, including the benefits of a fuller transition; beta separately | ADR: win/cost/risk/compatibility with Gravity, web/desktop and server; comparison with the resulting stack; solution without automatic migration |

## Implementation of 13.11.2026

Stages 10–21 are closed in an agreed volume; implementation and final delivery are locally
verified; push and publication are not performed. [check and operation](operations.md).

- Query, Form/Zod, Router/Hotkeys and Virtual are all integrated into the web/desktop app.
- Better Auth is connected; migrations 015–018 are applied after rehearsal to backup.
- models.dev comes with a local directory, OpenTelemetry is optional.
- Permission areas, a separate arbiter, and a single task designer are ready. The arbiter is off by default, user participation remains explicit.
- Streamdown investigated: saved AIKit by comparison. Table is not added without the need for tabular UX.
- [ADR 0003](adr/0003-tanstack-full-stack.md) records the evaluation of TanStack Start and AI. Adoption requires a concrete use case, and prerelease components are assessed separately.
- The [skills UX review](research/skills-ux-review.md) documents the research. Changes to skill behavior and turning a conversation into a skill were deferred.

## Additional components of TanStack

Virtual - for directory and long lists; chat requires separate check of dynamic heights and save
scroll. Hotkeys and Pacer are now beta: fix versions after compatibility; Pacer use only when
there is a measurable need for debounce/throttle/batching, not as a long-term server queue. DB
is still postponed: first Query/SSE, then re-evaluate in step 21. At stage 21, survey the
current full line, maturity and license of packages.

Sources: https://tanstack.com/, https://tanstack.com/virtual/latest,
https://tanstack.com/hotkeys/latest, https://tanstack.com/pacer/latest,
https://tanstack.com/db/latest.

## Boundaries of decisions

models.dev is a directory, not an automatic integration of all providers. Priority: manual setup
→ provider → local snapshot → backup directory. Match accurate identifiers, consider aliases,
versions and protocols. Reference prices with date; terms of use of logos check separately.

For Better Auth, first check the migration of IDs, password hashes, OIDC connections, sessions,
organizations and desktop devices. SSO settings and secrets remain local. Do not use mandatory
paid hosted functions.

Before the arbiter, examine open implementations/publications and prompts. The solution is
structured: allow/refuse/to the person; the model does not override prohibitions, expand rights,
or gain secrets unnecessarily. Provide prompt injection, action substitution, timeouts, budget,
and unavailability of the model.

AG-UI, Tauri/portable-pty, CEL and the conversion of conversation to skill are deferred. UX of
existing skills are explored as early as stage 10, without introducing new mechanics until the
usual scenario of inclusion and explanation of the actions of skills is determined.

## Implementing procedures

Stage 10 checks follow each next stage: small migrations, with data saved and individual
checkpoints; each report distinguishes between written tests, actual tests performed and
remaining scenarios; the general cycle is not considered complete by installing libraries alone.
