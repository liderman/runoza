# Runóza: Themes and Brand

A single theme source is `packages/ui/src/theme.css`, connected via `@runoza/ui/theme.css` to
the web and desktop connect. The basis is obtained from the official [Gravity generator](https://gravity-ui.com/ru/themes): background white / #212121, #0f766e / #7acbb8, contrast
white / black. The original research export is stored locally in `work/design-research/`.

The full set of private/semantic aliases is left consistent; selection is weakened, sidebar is
separated by a neutral surface. Statuses retain their color roles. Do not add hex colors to the
components. `--runoza-color-sidebar` is a proprietary surface token; Navigation and AIKit are
configured via public CSS variables. `.g-root.g-root_theme_*` selectors give priority over
automatically connected library styles. External Google Fonts imports removed: system fonts are
used. The dark theme of the original, explicit light remains.

The originals sent are unchanged in `assets/branding/`The interface has a separate sign and live
text **Runóza**: it is readable in both themes and does not require color inversion. npm/API IDs
and bundle IDs `runoza`The user profile directory remains `Runoza` The name of the new app
bundle. `Runóza`Navigation's logo uses `iconSrc`/`text`/`href`; Button is forbidden around it.

On macOS, execute `node scripts/generate-icons.mjs`: sips scales the original sign, iconutil
forms ICNS, the script packs PNG into the ICO and creates manifest. The common sign is 192 px,
the browser is 16/32/180/192/512, Electron is PNG/ICNS/ICO. When replacing the source, repeat
the generation and check the small dimensions, tab, connect and Dock. SVG vectoring and
redrawing are not performed.

## Decisions on components

- The compact Navigation shell is saved. For conversation groups, a flat list of staff items with separate transition and disclosure buttons was selected: the regular MenuGroup added decorative branches. The folded sidebar uses regular group popups.
- The established composer on TextArea is saved: it supports IME, keyboard, target/permissions/extensions, and drafts. Replacing the whole PromptInput does not offer the advantages of justifying re-binding these states.
- FileDropZone and FilePreview are used for downloads and selected attachments; S3 is still proxized by the server.
- NumberInput replaces text numerical settings; `null` remains an empty intermediate input. Deferred settings are Checkbox, immediate settings are Switch.
- The `@gravity-ui/table` table is rated: current user/audit lists do not require column sorting and cell editing. Keep current lists; legacy Table from UIKit 8 is not added. The model catalog is already virtualized.
- Date Components are not added: the scheduler uses local time, timezone and frequency, not the choice of a calendar day.
