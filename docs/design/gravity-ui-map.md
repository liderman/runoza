# Gravity UI map for Runóza

13.11.2026: Overview of the destination of all packets from [llms.txt](https://gravity-ui.com/llms.txt) and [Library Catalog](https://gravity-ui.com/ru/libraries).This is routing, not an obligation to install everything.

## Ecosystem

| Package @gravity-ui/... | Appointment/decision |
|---|---|
| uikit | Basic controls |
| aikit | Messages/streaming |
| navigation | Frame/navigation |
| icons | Functional badges |
| i18n | Localization |
| components | Additional widgets |
| table | Table admin, candidate |
| date-components | Calendar input, candidate |
| date-utils | Dates/zones |
| markdown-editor | Skills editor, candidate |
| illustrations | Empty fortunes, candidate |
| charts | Statistics, as required |
| yagr | Dense time series |
| chartkit | Several chart engines |
| dashkit | Transferable dashboard widgets |
| graph | Graph editor |
| timeline | Temporary visualization |
| dynamic-forms | Schematic shapes |
| dialog-fields | Another form model |
| data-source | Another data-layer |
| axios-wrapper | Another HTTP Layer |
| app-layout | HTML SPA shell |
| nodekit | Backend foundation |
| expresskit | Express foundation |
| page-constructor | Promotional pages |
| page-constructor-builder | Promo assembly |
| blog-constructor | Blog |
| farm | Preview deployments |
| playwright-tools | QA-utilities |
| eslint-config | Lint preset |
| prettier-config | Format preset |
| stylelint-config | CSS lint preset |
| tsconfig | TS preset |
| babel-preset | Babel preset |
| browserslist-config | Browser preset |
| webpack-i18n-assets-plugin | Webpack localization |

Implement alternative data/form/backend frameworks for visual unification is not required:
Query, Form/Zod and Fastify are saved. Canvas Timeline is not needed for the agent's text
passage. Charts/DashKit is only for real analytics, not for a small progress context. The theme
tool is on the site; no new runtime package is required to use the exported CSS.

## UIKit 8: the choice by task

- **Navigation and selection:** List/ListItemView, Menu, Tabs, Breadcrumbs, Select, RadioGroup/SegmentedRadioGroup.
- **Disclosure:** Disclosure is a standalone story/group; Accordion is related sections; do not create nested levels without benefit.
- **Layers:** Dialog is a transactional form; Drawer is an auxiliary dashboard; Sheet is a mobile script; Popup is a low-level base; Popover/HelpMark is an explanation. Distinguish between dismiss and loss of unsaved data.
- **Feedback:** Skeleton, Loader/Spin, Progress, Alert, Toaster, PlaceholderContainer.Progress with real measurable value only.
- **Forms:** TextInput, PasswordInput, TextArea, NumberInput, Checkbox, Switch, Slider, Stepper. The choice of component depends on the behavior of the save, not the appearance.
- **Actions:** Button, ActionsPanel, ActionTooltip, Hotkey, ClipboardButton. The main action is one; the explanation works from the keyboard, not just the hover.
- **Files:** FileDropZone/FilePreview, useFileInput/useDropZone.
- ** Hierarchy:** Text, Flex/Box/Container/Row/Col, Divider/Card, Label, DefinitionList.
- ** Profile:** Avatar/AvatarStack/User/UserLabel.

### Full index of the installed version

Listed below are all 65 INDEX.md entries, including auxiliary entrypoints. not all are
stand-alone user controls.

`Accordion`, `ActionsPanel`, `ActionTooltip`, `Alert`, `ArrowToggle`, `Avatar`, `AvatarStack`, `Breadcrumbs`, `Button`, `Card`, `Checkbox`, `ClipboardButton`, `ClipboardIcon`, `ColorPicker`, `controls/PasswordInput`, `controls/TextArea`, `controls/TextInput`, `CopyToClipboard`, `DefinitionList`, `Dialog`, `Disclosure`, `Divider`, `Drawer`, `FileDropZone`, `FilePreview`, `HelloPangeaDnd`, `HelpMark`, `Hotkey`, `Icon`, `Label`, `Link`, `List`, `ListItemView`, `Loader`, `Menu`, `Modal`, `NumberInput`, `Overlay`, `Pagination`, `Palette`, `PinInput`, `PlaceholderContainer`, `Popover`, `Popup`, `Portal`, `Progress`, `Radio`, `RadioGroup`, `SegmentedRadioGroup`, `Select`, `Select/hooks-public/useSelectOptions`, `Sheet`, `Skeleton`, `Slider`, `Spin`, `Stepper`, `Switch`, `tabs`, `Text`, `Toaster`, `Toc`, `Tooltip`, `User`, `UserLabel`, `Virtualizer`.

## AIKit 3.4.0

Use MessageList/AssistantMessage with ordered content parts, ThinkingMessageGroup for
neighboring steps, ToolMessage for tools, PromptInput or its hooks for composer, corresponding
attachment/action components. 54 components are organized into
atoms/molecules/organisms/templates/pages. Do not replace the entire ChatContainer if it
destroys the existing Router, durable SSE and server ACLs.

Local sources: `node_modules/@gravity-ui/uikit/build/docs/INDEX.md`,
`node_modules/@gravity-ui/aikit/build/docs/guides/COMPONENTS.md`,
`node_modules/@gravity-ui/navigation/build/esm/components/*/*.d.ts`.
