# Logo, cap and compact panels

Date: 2026-11-12 Local changes without push.

## Changes in changes

- Custom transparent PNG is saved without changing bytes in `apps/web/src/assets/runoza-logo.png`. Common BrandLogo is used in the side menu, mobile header and login page. In the folded menu, you can see a monogram; in a dark theme, CSS adapts contrast. The frame only hides the transparent fields of the source.
- Effort menu: secondary header, focus on selected level, neutral recommendation label. `Slider.tooltipDisplay="off"` removes reserve under tooltip; current level is already shown above slider. The margins are given by Gravity UI regular spacing tokens, without interference with internal classes.
- In the absence of reasoning, the block and the technical stub are not displayed. For a normal response without additional data, only the duration remains. The command log removes the redundant nested section "Execution of code"; actions are disclosed directly in the launch history. There is a separate spacing between the title and the output of the command.
- The menu of the models is limited to 28rem and the available window height with a margin of 120px. scroll the list; the filters of the providers are on top and scroll horizontally if necessary.
- On macOS, the conversation header and three actions are moved to the system header through the Gravity Portal. Status and handlers are not duplicated. Buttons are excluded from the draggable region; while listbox/menu/dialog is open, drag and drop hat is disabled so that it does not intercept clicks on the portals. The web remains the usual conversation header.

## Verification

Lint, package boundaries, TypeScript and web/desktop build passed. Hand-checking in macOS client and web: themes, effort menu, provider filter, list height limit, information button in the header, command history without a reasoning plug. Narrow web viewport 375×812 checked for no horizontal overflow and availability of the effort menu.

Only the web API was updated, the worker was not restarted: at the time of the update, there were active launches, no new migrations or dependencies, no changes to the Electron shell were required: the desktop uses a common server interface.

## Sources of solutions

- [Claude: Model Selection and Effort](https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings) - a separate compact level selection next to the model; Runoza's own visual hierarchy on the Gravity UI.
- [Electron: draggable regions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions) – Interactive elements in the drag and drop zone require `no-drag`.
- Established declarations and documentation Gravity UI UIKit 8.0.0 and Navigation 8.0.0: Slider, Label, Select.renderPopup, Portal, Logo.wrapper.


## 2026-11-12: application icon and conversation inset

Installed the user-provided transparent 1254×1254 PNG as the application icon, separate from the existing wordmark. Source: `apps/desktop/assets/icon-source.png`; derived PNG, multi-resolution ICO and macOS ICNS retain transparency. Web declares favicon and Apple touch icon links; desktop packaging selects ICNS/ICO/PNG for the target platform and includes the PNG for the running window/Dock. macOS packaged icon was byte-compared with the intended ICNS. Windows/Linux packaging has not been run.

The shared conversation scroll container now owns `padding-block: var(--g-spacing-4)` with border-box sizing. This supplies a 16px initial inset even when the toolbar is portalled into the desktop titlebar, without overriding AIKit internals or increasing the scroll container height.

Validation: typecheck, web build, macOS desktop package and package boundary check passed. Browser favicon endpoint returned HTTP 200 with the expected bytes. Visually checked the first message in desktop and web, light and dark themes. Local API and installed desktop bundle updated; worker left running. No push.
