# Gravity UI: solution after alignment check

Date: 2026-11-11, local, no push.

## Causes of defects

1. SettingsLayout used regular Button for vertical navigation. In UIKit 8, Button has justifiable-content:center and text-align:center. This is the wrong component choice for this scenario.
2. In Settings trigger and model trigger was embedded Typography.Text. His own line-height violated the vertical geometry of Button, which centers plain text through its line height.
3. Previous visual verification was insufficient: functional scenarios and overall layout were checked, but centering signatures in hover/focus/open states was not an acceptance criterion.

## Corrections

- SettingsLayout uses regular Menu inline/MenuItem with select point highlighting and keyboard navigation.
- Settings trigger contains plain text. Only its own root class is given justifiable-content:flex-start: Button does not have a separate alignment prop or corresponding CSS token.
- Model trigger contains a regular span, which inherits a line-height button; its own class is responsible only for cropping the long signature. UIKit's internal classes are not overridden.
- Light/dark themes, open settings menu, active items, open and focused model selection. Deepseek/deepseek-v4.1-flash-1017 is used only in local fixture, without requesting this provider. The model has a button height and a text container 28 px, center offset 0 px. 375 px has no horizontal scroll.
- npm run check: PASS (typing, assembly, formatting, 7 unit tests, licenses) The server and protocols did not change; integrations were not re-run for this geometry fix.

Local Docker image reassembled; API and worker updated and healthy. /health/ready on port 53009 successful. Temporary UI stand complete. Push not executed.

## What Is Confirmed About Alternative Products

| Product/project | Confirmation | Boundaries of withdrawal |
|---|---|---|
| Codex App | An [OpenAI job posting](https://openai.com/careers/frontend-software-engineer-codex-app-san-francisco/) mentions React, TypeScript, and desktop UI | The public source leaves the choice of UI library unconfirmed. |
| Claude | No reliable public manifest client found | We do not attribute Claude Radix/shadcn in appearance or to alien clones. |
| Qwen Code Web Shell | [package.json](https://github.com/QwenLM/qwen-code/blob/main/packages/web-shell/package.json): radix-ui, tailwind-merge, class-variance-authority | Open coding product, not proof of the chat.qwen.ai stack |
| Kimi CLI Web | [Archived official package.json](https://github.com/MoonshotAI/kimi-cli/blob/main/web/package.json): Radix, Tailwind, shadcn, React | Historical published CLI web client, not proof of the current kimi.com stack |
| DeepSeek Harness | [Official UI Rules](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/web-styling.md): Own ui-theme/ui-primitives, Semantic Tokens, CSS Modules | Harness Rules, Not Manifesting a Public DeepSeek Chat |

## Decision

We leave Gravity UI. The defects found are due to our composition and verification process, not the inability to implement the desired interface. Moving to Radix/shadcn will require reassembling the visual layer, adaptability, themes and forms, and does not eliminate the need to check geometry. Revisit the library with reproducible blocking API constraints, availability or performance that cannot be addressed by public components and local composition.

## Rules for Further Acceptance of UI

- For each modified control, check normal, hover/focus, selected/open and disabled where applicable.
- Navigation points are aligned along the common left boundary; regular action buttons can remain centered.
- Do not invest Typography.Text in Button without substantiating the height of the string; simple signatures are transmitted by line.
- Check long EN/RU names and signatures, width 375 px, both themes, save a backlit state shot, not just a page without interaction.
- Successful assembly doesn't replace visual acceptance. Don't declare the entire UI tested in multiple successful scenarios.
