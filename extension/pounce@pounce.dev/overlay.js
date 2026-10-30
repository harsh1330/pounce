// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Harsh
// pounce overlay: hint boxes and codes over the screen, a draggable search card with the top
// suggestions, keyboard handling, and clicks on the daemon's request. The daemon ranks,
// positions and decides; this file draws and reports what the user typed or chose.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BAR_WIDTH = 580;
const DEFAULT_STYLE = {
    theme: 'system', accent: '#ff8a1f', show_boxes: false, box_style: 'tint',
    hint_size: 'medium', dim_screen: false, suggestions: 5,
};
const HINT_FONT = {small: '0.62em', medium: '0.72em', large: '0.9em'};

function rgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}, ${alpha})`;
}

function readableOn(hex) {
    // Dark text on light accents (yellow), light text on dark ones.
    const n = parseInt(hex.slice(1), 16);
    const lum = 0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255);
    return lum > 150 ? '#16161a' : '#ffffff';
}

function isDark(theme) {
    if (theme !== 'system')
        return theme === 'dark';
    const scheme = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'})
        .get_string('color-scheme');
    return scheme === 'prefer-dark';
}
const CONFIG = GLib.build_filenamev([GLib.get_user_config_dir(), 'pounce', 'overlay.json']);

// Where the user dragged the search card, as an offset from the focused window's top-left,
// so it comes back in the same place on any window.
function loadBarOffset() {
    try {
        const [, bytes] = GLib.file_get_contents(CONFIG);
        const offset = JSON.parse(new TextDecoder().decode(bytes)).bar_offset;
        return Array.isArray(offset) && offset.length === 2 ? offset : null;
    } catch {
        return null;
    }
}

function saveBarOffset(offset) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(CONFIG), 0o700);
        GLib.file_set_contents(CONFIG, JSON.stringify({bar_offset: offset}));
    } catch (e) {
        logError(e, 'pounce: saving bar position');
    }
}

// The pounce custom shortcut (e.g. "<Super>b"), so pressing it again closes the overlay:
// while our grab holds the keyboard, GNOME doesn't run the shortcut itself.
function pounceShortcut() {
    const listSchema = 'org.gnome.settings-daemon.plugins.media-keys';
    const itemSchema = `${listSchema}.custom-keybinding`;
    for (const path of new Gio.Settings({schema_id: listSchema}).get_strv('custom-keybindings')) {
        const item = new Gio.Settings({schema_id: itemSchema, path});
        const command = item.get_string('command');
        if (command === 'pounce' || command.endsWith('/pounce'))
            return parseAccelerator(item.get_string('binding'));
    }
    return null;
}

function parseAccelerator(accel) {
    const mods = [...accel.matchAll(/<(\w+)>/g)].map(m => m[1].toLowerCase());
    const key = accel.replace(/<\w+>/g, '');
    // Key codes, not names: Clutter.keyval_name is missing on GNOME 42. Both cases, since
    // Shift turns b into B.
    const syms = new Set([key, key.toLowerCase(), key.toUpperCase()]
        .map(k => Clutter[`KEY_${k}`]).filter(sym => sym !== undefined));
    return syms.size ? {syms, mods: new Set(mods)} : null;
}

function matchesShortcut(ev, shortcut) {
    if (!shortcut)
        return false;
    // Compare key symbols, not text: Ctrl turns letters into control characters, and
    // keys like space or F12 have no text at all.
    if (!shortcut.syms.has(ev.get_key_symbol()))
        return false;
    const state = ev.get_state();
    const M = Clutter.ModifierType;
    const has = {
        super: (state & (M.SUPER_MASK | M.MOD4_MASK)) !== 0,
        ctrl: (state & M.CONTROL_MASK) !== 0,
        alt: (state & M.MOD1_MASK) !== 0,
        shift: (state & M.SHIFT_MASK) !== 0,
    };
    const m = shortcut.mods;
    const want = {
        super: m.has('super') || m.has('mod4'),
        ctrl: m.has('ctrl') || m.has('control') || m.has('primary'),
        alt: m.has('alt') || m.has('mod1'),
        shift: m.has('shift'),
    };
    return Object.keys(want).every(k => want[k] === has[k]);
}

function vbox(props) {
    // GNOME 48 gave St.BoxLayout an `orientation` and deprecated `vertical`.
    const box = new St.BoxLayout(props);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

// The shell loads stylesheet.css once at login; reload it so Reload picks up style edits too.
function reloadStylesheet(extensionDir) {
    const file = extensionDir.get_child('stylesheet.css');
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    theme.unload_stylesheet(file);
    theme.load_stylesheet(file);
}

export class Overlay {
    constructor(emit, extensionDir) {
        reloadStylesheet(extensionDir);
        this._dir = extensionDir;
        this._emit = emit;
        this._layer = null;
        this._pointer = null;
    }

    focus() {
        // The focused window plus every visible window on this workspace, bottom to top,
        // with the rectangles the daemon needs to place each toolkit's coordinates.
        const focused = global.display.focus_window;
        const rect = r => [r.x, r.y, r.width, r.height];
        const workspace = global.workspace_manager.get_active_workspace();
        // DESKTOP: Ubuntu's desktop icons live in a full-screen desktop-type window.
        const kinds = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG,
            Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY, Meta.WindowType.DESKTOP];
        const windows = global.display.sort_windows_by_stacking(workspace.list_windows())
            .filter(w => !w.minimized && w.showing_on_its_workspace() &&
                kinds.includes(w.get_window_type()))
            .map(w => {
                const frame = w.get_frame_rect();
                return {
                    pid: w.get_pid(),
                    title: w.get_title() ?? '',
                    // desktop-file id, for Settings → Apps to skip
                    app_id: Shell.WindowTracker.get_default().get_window_app(w)?.get_id() ?? '',
                    frame: rect(frame),
                    buffer: rect(w.get_buffer_rect()),
                    client: rect(w.frame_rect_to_client_rect(frame)),
                    focused: w === focused,
                };
            });
        // Popup surfaces (menus, popovers) with their real on-screen position: toolkits report
        // menu items where they asked the popup to go, but the compositor may slide it.
        const popupKinds = [Meta.WindowType.DROPDOWN_MENU, Meta.WindowType.POPUP_MENU,
            Meta.WindowType.MENU, Meta.WindowType.COMBO];
        const popups = global.get_window_actors()
            .map(a => a.meta_window)
            .filter(w => w && popupKinds.includes(w.get_window_type()))
            .map(w => ({
                pid: w.get_pid(),
                frame: rect(w.get_frame_rect()),
                buffer: rect(w.get_buffer_rect()),
            }));
        return JSON.stringify({
            overview: Main.overview.visible,
            screen: [0, 0, global.stage.width, global.stage.height],
            windows,
            popups,
        });
    }

    show(data) {
        this.hide(); // a new session replaces whatever was up
        try {
            this._layer = new HintLayer(data, {
                query: text => this._emit('Query', new GLib.Variant('(us)', [data.session, text])),
                choose: (id, right = false) => {
                    this.hide();
                    this._emit(right ? 'ChooseRight' : 'Choose',
                        new GLib.Variant('(ui)', [data.session, id]));
                },
                close: () => {
                    this.hide();
                    this._emit('Closed', new GLib.Variant('(u)', [data.session]));
                },
                openSettings: () => {
                    this.hide();
                    this._emit('OpenSettings', new GLib.Variant('(u)', [data.session]));
                },
            }, this._dir);
        } catch (e) {
            this._layer = null;
            this._emit('Closed', new GLib.Variant('(u)', [data.session]));
            throw e;
        }
    }

    update(data) {
        if (data.kind === 'click') {
            this.click(data.x, data.y, data.button); // the daemon re-checked the target
            return;
        }
        // Late messages from an earlier session are dropped; nothing here opens a new one.
        if (!this._layer || data.session !== this._layer.session)
            return;
        if (data.kind === 'elements')
            this._layer.setElements(data);
        else
            this._layer.setMatches(data);
    }

    hide() {
        this._layer?.destroy();
        this._layer = null;
    }

    click(x, y, button = Clutter.BUTTON_PRIMARY) {
        // Called by the daemon after it re-checked the target's position.
        if (!this._pointer) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        }
        const [ox, oy] = global.get_pointer();
        const now = GLib.get_monotonic_time();
        this._pointer.notify_absolute_motion(now, x, y);
        this._pointer.notify_button(now, button, Clutter.ButtonState.PRESSED);
        this._pointer.notify_button(now + 1000, button, Clutter.ButtonState.RELEASED);
        // Put the pointer back where the user left it.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            this._pointer?.notify_absolute_motion(GLib.get_monotonic_time(), ox, oy);
            return GLib.SOURCE_REMOVE;
        });
    }

    // @dev-start
    screenshot(path) {
        // Dev aid (extension.js gates it): verify box alignment against the real UI.
        return new Promise((resolve, reject) => {
            const stream = Gio.File.new_for_path(path).replace(
                null, false, Gio.FileCreateFlags.PRIVATE, null);
            new Shell.Screenshot().screenshot(false, stream, (shooter, result) => {
                try {
                    shooter.screenshot_finish(result);
                    resolve();
                } catch (e) {
                    reject(e);
                } finally {
                    stream.close(null);
                }
            });
        });
    }
    // @dev-end

    destroy() {
        this.hide();
        this._pointer = null;
    }
}

class HintLayer {
    constructor(data, cb, extensionDir) {
        this._dir = extensionDir;
        this._style = {...DEFAULT_STYLE, ...(data.style ?? {})};
        this._dark = isDark(this._style.theme);
        this.session = data.session;
        this._cb = cb;
        this._shortcut = pounceShortcut();
        this._boxes = new Map();
        this._codes = new Map();
        this._elements = new Map();
        this._ids = [];
        this._sel = -1;
        this._grab = null;

        this._root = new St.Widget({
            reactive: true,
            x: 0, y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        try {
            this._build(data);
            this.setElements(data);
            Main.layoutManager.uiGroup.add_child(this._root);
            // Grab last, once everything that could fail has run, so an error can't leave
            // the keyboard grabbed. The grab takes keys without changing the focused window.
            this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});
            if (!(this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD))
                throw new Error('could not grab the keyboard');
            global.stage.set_key_focus(this._entry.clutter_text);
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    _build(data) {
        const st = this._style;
        this._root.add_style_class_name(this._dark ? 'pounce-dark' : 'pounce-light');
        if (st.dim_screen)
            this._root.set_style('background-color: rgba(0, 0, 0, 0.28);');
        this._hints = new St.Widget({x: 0, y: 0});
        this._root.add_child(this._hints);
        this._root.connect('button-press-event', () => {
            this._cb.close();
            return Clutter.EVENT_STOP;
        });

        // Search card: [icon] [query............] [count]
        //              top suggestions
        //              status                               key hints
        this._bar = vbox({style_class: 'pounce-panel', width: BAR_WIDTH});
        const top = new St.BoxLayout({style_class: 'pounce-row'});
        top.add_child(new St.Icon({
            gicon: this._pawIcon(st.accent),
            style_class: 'pounce-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._entry = new St.Entry({
            style_class: 'pounce-entry',
            hint_text: 'Type to pounce…  or a hint code',
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        top.add_child(this._entry);
        this._count = new St.Label({style_class: 'pounce-count', y_align: Clutter.ActorAlign.CENTER});
        this._count.set_style(`background-color: ${rgba(st.accent, 0.18)}; color: ${st.accent};`);
        top.add_child(this._count);
        const gear = new St.Button({
            style_class: 'pounce-gear',
            child: new St.Icon({icon_name: 'emblem-system-symbolic', style_class: 'pounce-gear-icon'}),
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'pounce settings',
        });
        gear.connect('clicked', () => this._cb.openSettings());
        top.add_child(gear);
        this._bar.add_child(top);
        this._bar.add_child(new St.Widget({style_class: 'pounce-divider', x_expand: true}));
        this._list = vbox({style_class: 'pounce-list'});
        this._bar.add_child(this._list);
        const bottom = new St.BoxLayout({style_class: 'pounce-row'});
        this._status = new St.Label({style_class: 'pounce-status', y_align: Clutter.ActorAlign.CENTER});
        bottom.add_child(this._status);
        bottom.add_child(new St.Label({
            style_class: 'pounce-keys',
            text: 'Enter click  ·  Shift+Enter right-click  ·  Tab next  ·  Esc close',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._bar.add_child(bottom);
        this._root.add_child(this._bar);
        this._tag = new St.Label({style_class: 'pounce-tag', visible: false});
        this._tag.set_style(`background-color: ${st.accent}; color: ${readableOn(st.accent)};`);
        this._root.add_child(this._tag);

        this._placeBar(data.anchor);
        this._setupDrag();
        this._entry.clutter_text.connect('text-changed', () => this._cb.query(this._entry.get_text()));
        this._entry.clutter_text.connect('key-press-event', (_a, ev) => {
            try {
                return this._onKey(ev);
            } catch (e) {
                // The keyboard is grabbed: a broken handler must never leave the user stuck.
                logError(e, 'pounce: key handler');
                this._cb.close();
                return Clutter.EVENT_STOP;
            }
        });
    }

    _pawIcon(accent) {
        // The paw mark, recoloured to the accent.
        try {
            const [, bytes] = this._dir.get_child('icons').get_child('pounce-mark.svg').load_contents(null);
            const svg = new TextDecoder().decode(bytes).replaceAll('#ff8a1f', accent);
            return Gio.BytesIcon.new(new GLib.Bytes(new TextEncoder().encode(svg)));
        } catch {
            return Gio.ThemedIcon.new('system-search-symbolic');
        }
    }

    _boxStyle(selected) {
        const st = this._style;
        if (selected) {
            return `border: 3px solid ${st.accent}; border-radius: 6px; ` +
                `background-color: ${rgba(st.accent, 0.26)}; box-shadow: 0 0 12px ${rgba(st.accent, 0.55)};`;
        }
        if (!st.show_boxes)
            return 'border-width: 0; background-color: transparent;';
        const fill = st.box_style === 'tint' ? rgba(st.accent, 0.10) : 'transparent';
        return `border: 2px solid ${rgba(st.accent, 0.75)}; border-radius: 6px; background-color: ${fill};`;
    }

    _codeStyle(hit) {
        const st = this._style;
        const bg = this._dark ? '#16161a' : '#ffffff';
        const fg = this._dark ? st.accent : '#16161a';
        return `font-size: ${HINT_FONT[st.hint_size]}; background-color: ${hit ? st.accent : bg}; ` +
            `color: ${hit ? readableOn(st.accent) : fg}; border: 1px solid ${rgba(st.accent, 0.8)};`;
    }

    _placeBar(anchor) {
        // On the focused window's monitor (not the one under the pointer), at the saved spot.
        const area = anchor
            ? new Mtk.Rectangle({x: anchor[0], y: anchor[1], width: anchor[2], height: anchor[3]})
            : null;
        const index = area ? global.display.get_monitor_index_for_rect(area) : -1;
        const monitor = Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
        this._frame = anchor
            ? {x: anchor[0], y: anchor[1], width: anchor[2], height: anchor[3]}
            : monitor;
        const offset = loadBarOffset();
        const x = offset ? this._frame.x + offset[0]
            : this._frame.x + Math.max(0, (this._frame.width - BAR_WIDTH) / 2);
        const y = offset ? this._frame.y + offset[1] : this._frame.y + 12;
        this._bar.set_position(
            Math.round(Math.min(Math.max(x, monitor.x), monitor.x + monitor.width - BAR_WIDTH)),
            Math.round(Math.min(Math.max(y, monitor.y), monitor.y + monitor.height - 80)));
    }

    _setupDrag() {
        // Drag the card anywhere; the spot is remembered relative to the window.
        this._bar.reactive = true;
        this._bar.connect('button-press-event', (_a, ev) => {
            if (ev.get_button() === Clutter.BUTTON_PRIMARY) {
                const [px, py] = ev.get_coords();
                this._drag = {dx: px - this._bar.x, dy: py - this._bar.y};
            }
            return Clutter.EVENT_STOP; // a press on the card must not close the overlay
        });
        this._root.connect('motion-event', (_a, ev) => {
            if (!this._drag)
                return Clutter.EVENT_PROPAGATE;
            const [px, py] = ev.get_coords();
            this._bar.set_position(Math.round(px - this._drag.dx), Math.round(py - this._drag.dy));
            return Clutter.EVENT_STOP;
        });
        this._root.connect('button-release-event', () => {
            if (!this._drag)
                return Clutter.EVENT_PROPAGATE;
            this._drag = null;
            saveBarOffset([this._bar.x - this._frame.x, this._bar.y - this._frame.y]);
            return Clutter.EVENT_STOP;
        });
    }

    setElements(data) {
        this._hints.destroy_all_children();
        this._boxes.clear();
        this._codes.clear();
        this._elements.clear();
        for (const el of data.elements ?? []) {
            const [x, y, w, h] = el.box;
            const box = new St.Widget({
                style_class: 'pounce-box',
                style: this._boxStyle(false),
                x, y, width: w, height: h,
                visible: false,
            });
            this._hints.add_child(box);
            this._boxes.set(el.id, box);
            this._elements.set(el.id, el);
            // Code in the box's corner: the way to pick icon-only controls.
            const code = new St.Label({
                style_class: 'pounce-code',
                style: this._codeStyle(false),
                text: el.code.toUpperCase(),
                x: x - 4,
                y: y - 6,
                visible: false,
            });
            this._hints.add_child(code);
            this._codes.set(el.id, code);
        }
        this._setStatus(data.status);
        this._cb.query(this._entry.get_text()); // the daemon answers with matches
    }

    setMatches(data) {
        if (data.query !== this._entry.get_text())
            return; // typed more since; a fresher answer is on its way
        const selected = this._ids[this._sel];
        this._ids = (data.ids ?? []).filter(id => this._boxes.has(id));
        const shown = new Set(this._ids);
        for (const [id, box] of this._boxes) {
            box.visible = shown.has(id);
            this._codes.get(id).visible = box.visible;
        }
        this._setStatus(data.status);
        this._markCodes(data.code_prefix);
        const n = this._ids.length;
        this._count.text = n ? `${n}` : 'no match';
        if (n)
            this._count.remove_style_class_name('pounce-count-empty');
        else
            this._count.add_style_class_name('pounce-count-empty');
        // Same query re-answered (another window finished loading): keep the selection.
        const keep = data.query === this._lastQuery ? this._ids.indexOf(selected) : -1;
        this._lastQuery = data.query;
        this._select(keep >= 0 ? keep : (n ? 0 : -1));
    }

    _select(index) {
        this._boxes.get(this._ids[this._sel])?.set_style(this._boxStyle(false));
        this._sel = index;
        this._renderList();
        const box = this._boxes.get(this._ids[index]);
        if (!box) {
            this._tag.visible = false;
            return;
        }
        box.set_style(this._boxStyle(true));
        const el = this._elements.get(this._ids[index]);
        this._tag.text = el.label || el.role;
        this._tag.visible = true;
        const naturalHeight = this._tag.get_preferred_size()[3];
        this._tag.set_position(Math.round(box.x), Math.round(Math.max(0, box.y - naturalHeight - 2)));
    }

    _renderList() {
        this._list.destroy_all_children();
        const n = this._ids.length;
        const rows = this._style.suggestions;
        this._list.visible = n > 0 && rows > 0;
        // A window of `rows` rows that keeps the selection in view.
        const start = Math.max(0, Math.min(this._sel - 2, n - rows));
        for (let i = start; i < Math.min(n, start + rows); i++) {
            const el = this._elements.get(this._ids[i]);
            const row = new St.BoxLayout({
                style_class: 'pounce-item',
                style: i === this._sel ? `background-color: ${rgba(this._style.accent, 0.22)};` : '',
                reactive: true,
                track_hover: true,
            });
            row.add_child(new St.Label({
                style_class: 'pounce-item-code',
                style: `color: ${this._style.accent}; background-color: ${rgba(this._style.accent, 0.14)};`,
                text: el.code.toUpperCase(),
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(new St.Label({
                style_class: el.label ? 'pounce-item-label' : 'pounce-item-label pounce-item-unnamed',
                text: el.label || '(no name)',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(new St.Label({
                style_class: 'pounce-item-role',
                text: el.via === 'click' ? `${el.role} · click` : el.role,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            // Act on release, so the click the daemon sends doesn't overlap the user's own.
            row.connect('button-press-event', () => Clutter.EVENT_STOP);
            row.connect('button-release-event', (_a, ev) => {
                const right = ev.get_button() === Clutter.BUTTON_SECONDARY;
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._cb.choose(el.id, right); // deferred: choosing destroys this row
                    return GLib.SOURCE_REMOVE;
                });
                return Clutter.EVENT_STOP;
            });
            this._list.add_child(row);
        }
    }

    _markCodes(prefix) {
        // Light up the part of each code already typed.
        const typed = (prefix ?? '').toUpperCase();
        for (const [id, label] of this._codes) {
            const code = this._elements.get(id).code.toUpperCase();
            if (typed && code.startsWith(typed)) {
                // Typed part solid, the rest faded, on an accent-filled tag.
                label.set_style(this._codeStyle(true));
                label.clutter_text.set_markup(
                    `<b>${typed}</b><span alpha="55%">${code.slice(typed.length)}</span>`);
            } else {
                label.set_style(this._codeStyle(false));
                label.text = code;
            }
        }
    }

    _onKey(ev) {
        if (matchesShortcut(ev, this._shortcut)) {
            this._cb.close(); // the same hotkey toggles the overlay off
            return Clutter.EVENT_STOP;
        }
        const key = ev.get_key_symbol();
        const shift = (ev.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const n = this._ids.length;
        if (key === Clutter.KEY_Escape) {
            this._cb.close();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            const id = this._ids[this._sel];
            if (id !== undefined)
                this._cb.choose(id, shift); // Shift+Enter: right-click
            return Clutter.EVENT_STOP;
        }
        if (n && (key === Clutter.KEY_Down || (key === Clutter.KEY_Tab && !shift))) {
            this._select((this._sel + 1) % n);
            return Clutter.EVENT_STOP;
        }
        if (n && (key === Clutter.KEY_Up || key === Clutter.KEY_ISO_Left_Tab ||
                  (key === Clutter.KEY_Tab && shift))) {
            this._select((this._sel - 1 + n) % n);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _setStatus(text) {
        // Messages only ("Reading windows…", accessibility off); counts live in the pill.
        this._status.text = text ?? '';
        this._status.visible = Boolean(text);
    }

    destroy() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._root?.destroy();
        this._root = null;
    }
}
