# Changes

## 0.1.3 (3 November 2026)

- Fixed: Chrome with more than one profile got codes only in the profile picker. Its window
  title has the profile name appended, and it keeps extra nameless windows, so pounce didn't
  recognise the browser window.

## 0.1.2 (3 November 2026)

- Fixed: on X11, pressing the hotkey again didn't close the hints.
- Chrome, Chromium, Brave and Edge get codes on X11 too (`pounce setup` gives them the same
  flagged launcher as Electron apps).
- Fixed: the search window crashed on GTK 4.6 (Ubuntu 22.04, Pop!_OS 22.04) and stayed on screen.
- `pounce --version` and `pounced --version`; `pounce doctor` shows the version.
- The APT repository lists i386 and armhf, so multiarch systems no longer print a
  "doesn't support architecture" notice.

## 0.1.1 (3 November 2026)

- VS Code, Slack, Discord, Obsidian and other Electron apps get codes on X11 too.
  `pounce setup` gives each one a copy of its launcher that starts it with
  `--force-renderer-accessibility`; `pounce setup --undo` removes the copies and `pounce doctor`
  reports apps that still lack it. Run `pounce setup` once after updating, then restart those apps.
- If VS Code switches to "Screen Reader Optimized", add `"editor.accessibilitySupport": "off"` to
  its settings: codes keep working.

## 0.1.0 (30 October 2026)

First release.

- Two-letter codes on every visible window, the top bar, the dock and desktop icons.
- Search by name with aliases (`settings` also finds Preferences); Enter clicks, Shift+Enter
  right-clicks, Tab moves to the next match.
- Pounce Settings: theme, accent colour, which windows get codes, apps to skip, hotkey.
- `pounce setup`, `pounce setup --undo` and `pounce doctor`.
- GNOME 42 to 48, on Ubuntu 22.04 and 24.04 and Debian.
