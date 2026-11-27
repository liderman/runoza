# Chat usability correction after alpha.13

The reported long MCP investigation stopped at the shipped 64-call ceiling. The
composer also repeated the plan and run diagnostics below the scroll viewport.
Expanding that fixed plan displaced the conversation. Tool calls were rendered as
individual rows, with repeated change-review controls.

## Behavior changes

- `max_agent_steps=0` means no call ceiling. Positive administrator budgets, durable
  counters, cancellation, deadlines, permission checks and loop protection remain.
- Migration 046 replaces settings equal to the old default 64 with zero and leaves
  other configured limits and historical run snapshots unchanged.
- MCP search descriptions are bounded to 480 characters per result. Full descriptions
  and schemas remain available through exact schema lookup. Prompt version v3 directs
  the agent to reuse evidence, update its plan and synthesize findings.
- A stopped latest task has an explicit continuation action. It appends a new user
  request with the existing history; it does not retry an earlier branch or replay
  external actions automatically, and it preserves an unsent draft.
- Plans and completed-run diagnostics live in the history. Tool/reasoning sequences
  are grouped; pending approvals and uncertain outcomes remain visible. Change-review
  controls for an action live inside its details.
- Context and queue are dialogs; the composer remains bounded even with a long draft
  or many attachments. Execute / Plan only exposes the existing read-only planning
  behavior clearly. Expanding history stops automatic following of the latest output.

## Visual verification

Used synthetic data on an isolated local server: 70 MCP calls with interleaved
reasoning, an eight-step plan, a historical limit error and a subsequent response.
Chrome and native macOS Electron were launched and operated through the UI.

- Wide light/Russian and dark/English screens: one collapsed action group, one plan,
  compact composer, visible input and readable diagnostic controls.
- Expanded all actions and plan: history scrolls without resizing the composer;
  return-to-latest still works.
- Chrome responsive mode at 375 × 812: controls wrap, the plan stays in history,
  context opens in a bounded dialog, and there is no horizontal layout overflow.
- Native Electron: expanded plan, history scrolling, context and queue entry points;
  both languages/themes. Test-device login used only the disposable test account.
- Explicit continuation: one new response in the same conversation; an unsent draft
  remains in the browser composer. The provider was a deterministic fixture, so this
  verifies the workflow, not the quality of a real model's investigation.

Screenshots and diagnostic logs are kept in ignored local release artifacts. The
user's conversation contents were not copied into tracked tests or documentation.
