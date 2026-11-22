# Runóza: Visual Cycle 22–28

Component and Asset Generation Solutions: [themes and brand](theme.md), [message
contract](message-parts.md).Based on [Gravity UI audit](gravity-ui-audit.md) and [component
map](gravity-ui-map.md).

## The direction taken

- The displayed name is always **Runóza** (U+00F3), the technical identifiers remain `runoza`.
- The Runóza sign is a stingray; separately a sign, separately an inscription. The originals are retained unchanged in `assets/branding/`; the former sign and the scroll are retired.
- Calm neutral surfaces in the spirit of Codex, without the purple shade of dark background and no turquoise pours in large areas. Dark theme is the original; saved user choice takes priority.
- Light theme: white work area, slightly different sidebar/panels; dark: neutral charcoal background, delicate separation of surfaces.
- The colors of the stingray are used in limited accents. Primary action can remain contrast neutral; links, focus, selection are consistent. Error/warning/success semantics are not repainted into the brand color.
- Density is controlled by purpose: compact navigation and settings, comfortable reading of messages, not reduce the entire UI to a single scale.

## 22.Basis: brand, palettes and icons

1. Prepare a single theme configuration and connect after the standard UIKit styles to the web and desktop connect. Generator: https://gravity-ui.com/ru/themes. Original research export - `work/design-research/gravity-generated-theme.css`.
2. Check neutral background/panels, border/hover/selection/focus/link and contrast of both topics.Reduce selection saturation for the first export, remove external font imports; export not blindly connect.
3. Translate fallback themes from light to dark in all entrypoints.The missing preference differs from the explicitly chosen light; there are no mass UPDATE users.
4. Staff `Logo` Navigation: `iconSrc` + `text`, without the Button wrapper and the effect of the selected item. The clickable logo remains visible keyboard focus.
5. Use a separate asset inscription if it is read at a height of 20-24 px; the permissible fallback is the live text of Runóza. Do not invert the color sign along with the inscription.
6. Update favicon ICO/PNG, touch/manifest icons, Electron PNG/ICNS/ICO, window/app title and connect/login/mobile/compact options. Check the sign at 16/24/32/64 px and Dock: do not trim the tail, leave old images or blurred decorative border.

Ready: wide/curled sidebar, login/connect, tab and Dock use the new brand; dark default and
explicit light checked separately; pair of theme snapshots.

## 23 Side menu and shared cap

- Use `PageLayout menuDensity="compact"` and real-world Navigation 8 APIs. Match two group options: regular MenuGroup and Disclosure + List. Select by density and availability, do not rewrite internal CSS selectors.
- The project remains a reference to the project, chevron disclosing his conversations separately. A new conversation inherits the current project. Personal conversations are a standalone group.
- Remove decorative branches and repetitive large icons from each conversation; the group title is secondary, the selected conversation is clearly highlighted.
- One line of the conversation header with ellipsis/hint; the indicator of the ongoing query does not disappear when the text is shortened; remember the disclosure of groups and menus.
- Simplify footer: profile/settings and service actions share common axes, tooltip and correct hit areas.
- Save Back/Forward after system buttons, no-drag for all actions, sticky header, access to workspace/info/menu, space for a long header.

Readiness: 0/1/many projects, long RU/EN titles, search/clear, running and waiting approval,
compact popup, mobile drawer; hover/focus do not shift content.

## 24.Messages and the real sequence of the agent's work

This is a separate reworking of the data, not a cosmetic rearrangement of existing blocks. Now
`message.content`/`reasoning` is aggregated, the actions are loaded separately into
`RunActivity`/`CodeActivity` after the text. This model does not save the alternation.

- Identify structured parts with stable ID and order: `thinking`, `text`, `tool`, confirmation/execution state and result.
- Keep the boundaries of the model turns and sequence on the server; if necessary, add a small migration. SSE/replay and snapshot should give the same order without repeating commands. ACL and exact-action approval remain server-side.
- Old messages show compatible renderer: don't invent a precise order that the old aggregates no longer have. For new messages, a complete ordered pipeline.
- Use AIKit `AssistantMessage` parts, `ThinkingMessageGroup`, `ToolMessage` and renderer registry. Runoza approval card is a proprietary part with a valid API. Group only adjacent reasoning; text or command breaks the group.
- Conditions: queued, thinking, intermediate text, tool pending/running/completed, waiting for resolution/device/environment, final, cancel, error, reconnect.
- Don't show empty reasoning. Save disclosure when streaming; current activity is visible compactly, the completed story is folded; the final answer is not duplicated. Copy copies Markdown text, not JSON parts or service fields.
- Control autoscroll: follow the answer only near the bottom; when reading above show the transition to new messages. Panels / expansion do not steal the position.

Readiness: "thinking → tool → text → thinking → tool → final" fixture, multiple parallel tools,
failure, lost SSE/reload, old dialog and switching conversations. Live/replay/snapshot match;
security and idempotency undiminished.

## 25 Composer, Model Selection, Embedding and Workspace

- Check the capabilities of `PromptInput`/hooks AIKit for composer; save "Work in", model/effort, permission mode, attachments and send from the keyboard.
- Settings effort: one main value, secondary recommended Label, without the same bold header/value/recommendation. Animation only of the current intense state, with reduced-motion; no constant glow.
- Model picker: provider filters, non-switchable group headers, height limit inside viewport, sticky search, scroll list. In desktop popup never hits the draggable area, the keyboard is available throughout the list.
- `FilePreview`/`FileDropZone` and explicit upload/progress/error; long names do not push out Send. Stop and Send have an understandable available state.
- Shared grid and file/terminal toolbar, empty/error states, panel separator and adaptive Drawer/Sheet; cancelling a new file does not make the form dirty.

Ready: 375/390 px, desktop minimum width and 1440 px; Enter/Shift+Enter, IME, many attachments,
long filename, high directory, open both panels.

## Settings, projects, extensions and assignments

- Unified geometry of headings/partitions/forms; semantic Text, spacing/radius tokens.Card only where you need a separate semantic object; not "card in card".
- Field wrappers: Label/HelpMark, mandatory, help/error, disabled/loading, multi-line instructions, NumberInput for numbers with empty intermediate input.
- Checkbox - Delayed Group Change, Switch - Immediate; if the setting is maintained by a shared button, the behavior is clearly marked. Query/Form dirty/reset and keeping the secret with an empty field remain validated.
- Administrative users/audit: Rate `@gravity-ui/table` 2 with search, selection/pagination. The already installed UIKit 8 keeps the old Table only in the legacy: do not add a deprecated API.
- Projects: Talk groups, described instructions/files, clear roles, and empty states. Extensions: Separate skills instructions from MCP capabilities, show the source and scope of inclusion; do not change discreetly fixed versions and ACLs.
- Tasks: check four steps, mobile navigation, summary, validation and history. Date Components - if you need calendar input; do not replace the timezone / DST scheduler with your own UI logic.
- `Skeleton`, `Alert`, `PlaceholderContainer`, `Toaster` select by state; error near cause and with available action, without duplication of notifications.

Readiness: screen-by-screen audit of all listed sections, save, server error, empty state, long
text, cancel/discard/Back, both topics.

## Visual and behavioral acceptance

For each modified screen, web + assembled Electron; RU/EN × light/dark, wide/narrow,
pointer/keyboard. Separately, hover, focus-visible, active, disabled, loading, error, empty and
reduced motion. Check hit area, baseline, plain text contrast ≥4.5:1, large texts/significant
boundaries ≥3:1, visibility focus. Do not declare availability by one automatic contrast test.

Add stable state fixtures, component regressions and reference screenshots; compare real pixels,
not just jsdom/tsc. Check links, scroll, screen-reader labels, popup boundaries, no horizontal
overflow.

## Documentation and local delivery

Update the design rules, theme source/export, icon generation instructions, message parts
contract and compatibility notes. Run the necessary tests/typecheck/license checks, collect web
and Electron; update the local runtime only after verification, with backup before migrating and
saving user data. Leave the old local kit available for rollback. No push/publish.

## Order and limitations

22 → 23 → 24 → 25 → 26 → 27 → 28. Acceptance accompanies each stage. Approval palette on real
controls/sidebar/chat prior to mass use. Do not connect all Gravity libraries “for
completeness”: the map identifies candidates, and the dependence appears only under the
realizable scenario and compatible backends. Global Census, the replacement of Tan
peerStack/Better Auth and new product functions are not included in the visual cycle. Data
changes are allowed for honest message chronology, with separate migration/replay/rollback
checks.
