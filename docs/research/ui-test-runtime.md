# UI test runtime

Vitest/jsdom uses real Gravity UI components and user-event. Gravity Navigation is tested
through its ESM input: CJS requires CSS is not handled by jsdom loader. File isolation is saved,
maxWorkers=2: parallel transformation of all Gravity graphs on a local computer with
Chrome/Electron/Compose running resulted in timeouts. This is not a replacement for browser
performance checks. Last component run: 64 PASS; about 110 seconds at the current local booth.

ActionTooltip deliberately adds a key combination to the available button name when it opens.
Tests take this into account by additionally checking the appearance of the hint text when
hover. Tasks check the entered value before canceling, so as not to mistake closing the blank
form for correct protection of the draft. Canvas xterm and scrollTo are not implemented jsdom;
PTY / scrolling is checked in the real web / desktop. Do not add stubs that depict PTY.

Removed import UIKit fonts.css: it accesses Google Fonts, which is not suitable for offline
delivery and blocked by our CSP. Strict CSP is saved, using the existing system fallback font.
