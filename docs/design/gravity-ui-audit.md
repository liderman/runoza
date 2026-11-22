# Gravity UI: A study for the Runóza visual cycle

13.11.2026 This is an audit of the source and reference books with a live inspection of the
examples, not a statement that all the states of each screen have already been checked or
corrected. Implementation plan: [22-28](visual-refresh-plan.md).

## Verified database

- Installed UIKit **8.0.0**, Navigation **8.0.0**, AIKit **3.4.0**, Icons **2.23.1**, i18n **1.8.0**. APIs are checked by local docs and `.d.ts`.
- All **42 articles** (General Basics and Component Guides) are obtained from the Design section. Local Research Index: `work/design-research/articles.json`.
- The review catalog of the installed UIKit contains **65 items**, including hooks/subcomponents; AIKit - 54 components across the five levels of Atomic Design. These are not 65 independent new dependencies. [Application Map](gravity-ui-map.md).
- The library catalog and llms.txt were studied. The component site shows UIKit 7.47.1 and Navigation 6.3.1 in places; the example from the site is not an API truth for v8. There are also discrepancies between online llms and v8 (in particular Table): the priority of installed docs.
- In the browser, the Dashboard before/after menu disclosure and the Task tracker with Favorites disclosure/curtailment are viewed.
- The article AIKit, local AssistantMessage/ThinkingMessageGroup/ToolMessage and the scheme of the current renderer Runóza are studied. The article explains the model; API is taken from 3.4.0.

## The basis of composition

[Basics](https://gravity-ui.com/ru/design/branding/basics),
[Color](https://gravity-ui.com/ru/design/branding/color),
[Typography](https://gravity-ui.com/ru/design/branding/typography),
[Radius](https://gravity-ui.com/ru/design/branding/corner-radius),
[Branding](https://gravity-ui.com/ru/design/branding/branding),
[Grid](https://gravity-ui.com/ru/design/branding/grid-and-container),
[Spacing](https://gravity-ui.com/ru/design/branding/module).

Application to the product: semantic tokens set the color role; components do not receive
arbitrary individual colors. The general spacing scale relies on a 4 px module with rare 2 px
refinements. Header, body text and signature have different roles and weights, instead of
ubiquitous bold. Sidebar and overlay should not be considered columns of page content. Radies
are changed by a common system, not a set of inconsistent values across screens.

## Discrepancies found in the sources

| Place. | Observation | Decision |
|---|---|---|
| AppShell logo | `logo.wrapper` creates a flat button | Staff `iconSrc`/`text`/href Logo; hover is not similar to the selected item |
| BrandLogo/style.css | One wide PNG, crop background, compact shows a fragment of an old letter; general invert | Separate mark/wordmark; separate treatment of monochrome inscription; color sign not inverted |
| Names. | Runoza is not stressed in title/aria/connect | Display Runóza; package names, env keys, protocol IDs saved |
| RunózaApp/connect | Absent preference turns into light. | Dark fallback, explicit light remains light |
| Sidebar | Default density, branches, two-line headers, and large groups | Compact density or compact Disclosure/List on the official example |
| RunActivity/CodeActivity | Reasoning and Actions After Aggregated Text | Ordered message parts and renderer AIKit |
| Deployment of reasoning | Embedded Disclosure is automatically linked to the startup state | Stable manual disclosure; empty reasoning does not create an element |
| Settings/Schedules | Many Cards and Long Linear Forms | Semantic sections, Divider/Accordion for additional settings; field state reconciliation |
| Status of loading | Multiple screens show just the text "Download..." | Skeleton for known geometry; local progress, without changing the entire page during mutation |
| CSS | There are app-owned sizes, old-brand crop and separate geometry rules | Remove unnecessary after switching to API components; leave only reasonable geometry |

These are the initial candidates for fixing, and in particular, the sidebar variant and the
exact background shades are selected after comparing in real UI, rather than in a table.

## What to take from examples

[Home page, Dashboard and Task tracker](https://gravity-ui.com/ru). Dashboard uses separate
Logo icon and text slots; wrapper is not a Button menu item. Task tracker uses Disclosure for
partitions, body text of secondary color, compact lines without a decorative line of wood. The
rows measured in this particular example are 28 px, the Disclosure header is 26 px. This is an
observation, not a universal norm: touch targets and selected Navigation density are checked
separately. With Runóza, the project has its own action, so simply copying the behavior of
Favorites will disrupt navigation.

## AIKit and progress

[AIKit](https://gravity-ui.com/ru/blog/gravityui-aikit): The SDK does not manage product data;
the message can consist of text/thinking/tool parts, and the renderer is extended. Installed
3.4.0 already supports grouped thinking with stable disclosure and group division by text/tools.

In the current ChatWorkspace, the finished message goes to MessageList, and the progress is
added through the assistant footer. Backend separately accumulates string content and reasoning.
From these aggregates, you can not reliably restore the original order between tool calls. So
step 24 involves a contract, storage and replay, rather than sorting existing UI blocks by
approximate timestamp.

## Theme Generator and New Brand

[Temizator](https://gravity-ui.com/ru/themes) verified via UI: Colors → Edit → Advanced,
individual light/dark backgrounds, brand, contrast, hover, selection and links, preview controls
and CSS/JSON export. CSS is indeed downloaded and stored in
`work/design-research/gravity-generated-theme.css`; successful receipt of JSON in this session
is not confirmed, import back is not yet verified.

First candidate: light `#ffffff` background, dark `#212121`; light `#0f766e` accent, dark
`#7acbb8`, white/dark text on the corresponding button. This is a comparison preparation, not
approved production palette. The shades of the sidebar and neutral primary action will be
refined to "like Codex, without excess turquoise." Export contains Google Fonts imports and
changes shades: for self-hosted product, remove external fonts and check all semantics alias
UIKit 8s private.

Send originals: mark 1254×1254 RGBA; wordmark 2172×724 with alpha. Storage:
`assets/branding/runoza-{mark,wordmark}-source.png`. They are copied byte-byte. This is an audit
of the preparatory stage from 13.11; the subsequent implementation of the brand and icons is
described in [theme.md](theme.md). On a small scale, you need to check the transparent
fields/edges, optical size and contrast on both surfaces. Adaptation of the inscription should
not repaint the ray.

## Limits of research

The complete directory is disassembled according to its intended purpose; it does not state
manually all possible props and states of each library; it reads its installed docs/types before
changing the component; the presence of a package in the directory is not a reason for
installation; the main criterion is scripts and measurable visual acceptance, not the number of
components used.
