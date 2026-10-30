// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Harsh
// D-Bus shim for pounce. Keeps the bus name and object stable; the UI lives in overlay.js.
//
// Only the pounce daemon (owner of dev.pounce.Daemon) may drive the overlay, and signals go
// to it alone: otherwise any session-bus client could draw boxes, read what the user types
// into the overlay, or make it click. Dev tools (Reload, DebugScreenshot) work only while
// ~/.config/pounce/dev exists, and release builds leave them out (tools/build_extension.py
// drops the @dev blocks and converts the imports for GNOME 42-44).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Overlay} from './overlay.js';

const IFACE = `
<node>
  <interface name="dev.pounce.Shell">
    <method name="GetFocus"><arg type="s" direction="out" name="json"/></method>
    <method name="Show"><arg type="s" direction="in" name="json"/></method>
    <method name="Update"><arg type="s" direction="in" name="json"/></method>
    <method name="Click"><arg type="d" direction="in" name="x"/><arg type="d" direction="in" name="y"/></method>
    <method name="Hide"/>
    <!-- @dev-start -->
    <method name="Reload"/>
    <method name="DebugScreenshot"><arg type="s" direction="out" name="path"/></method>
    <!-- @dev-end -->
    <signal name="Query"><arg type="u" name="session"/><arg type="s" name="text"/></signal>
    <signal name="Choose"><arg type="u" name="session"/><arg type="i" name="id"/></signal>
    <signal name="Closed"><arg type="u" name="session"/></signal>
  </interface>
</node>`;

const PATH = '/dev/pounce/Shell';
const DAEMON = 'dev.pounce.Daemon';

// @dev-start
function devMode() {
    return GLib.file_test(
        GLib.build_filenamev([GLib.get_user_config_dir(), 'pounce', 'dev']), GLib.FileTest.EXISTS);
}
// @dev-end

export default class PounceExtension extends Extension {
    enable() {
        this._impl = null;
        this._daemon = null; // unique bus name of the pounce daemon
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, PATH);
        this._nameId = Gio.bus_own_name_on_connection(
            Gio.DBus.session, 'dev.pounce.Shell', Gio.BusNameOwnerFlags.NONE, null, null);
        this._watchId = Gio.bus_watch_name_on_connection(
            Gio.DBus.session, DAEMON, Gio.BusNameWatcherFlags.NONE,
            (_c, _n, owner) => {
                this._daemon = owner;
            },
            () => {
                this._daemon = null;
                this._impl?.hide(); // nobody left to act on choices
            });
        this._impl = new Overlay((signal, variant) => this._emit(signal, variant), this.dir);
    }

    disable() {
        this._impl?.destroy();
        this._impl = null;
        Gio.bus_unwatch_name(this._watchId);
        Gio.bus_unown_name(this._nameId);
        this._dbus.unexport();
        this._dbus = null;
    }

    // @dev-start
    async _reload() {
        // GJS caches modules by path (a query string doesn't help), so import a fresh copy
        // of overlay.js on every load; that's what lets Reload pick up edits.
        const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'pounce-shell']);
        GLib.mkdir_with_parents(dir, 0o700);
        const copy = Gio.File.new_for_path(
            GLib.build_filenamev([dir, `overlay-${GLib.get_monotonic_time()}.js`]));
        this.dir.get_child('overlay.js').copy(copy, Gio.FileCopyFlags.OVERWRITE, null, null);
        try {
            const {Overlay} = await import(copy.get_uri());
            this._impl?.destroy();
            this._impl = new Overlay((signal, variant) => this._emit(signal, variant), this.dir);
        } finally {
            copy.delete(null);
        }
    }
    // @dev-end

    _emit(signal, variant) {
        if (!this._daemon)
            return;
        // Unicast: what the user types into the overlay goes to the daemon only.
        Gio.DBus.session.emit_signal(this._daemon, PATH, 'dev.pounce.Shell', signal, variant);
    }

    _fromDaemon(invocation) {
        if (this._daemon && invocation.get_sender() === this._daemon)
            return true;
        invocation.return_dbus_error('org.freedesktop.DBus.Error.AccessDenied',
            'only the pounce daemon may call this');
        return false;
    }

    // @dev-start
    _devOnly(invocation) {
        if (devMode())
            return true;
        invocation.return_dbus_error('org.freedesktop.DBus.Error.AccessDenied',
            'dev tools are off (create ~/.config/pounce/dev)');
        return false;
    }
    // @dev-end

    _run(invocation, fn) {
        try {
            fn();
            invocation.return_value(null);
        } catch (e) {
            logError(e, 'pounce');
            invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', String(e));
        }
    }

    GetFocusAsync(_params, invocation) {
        if (!this._fromDaemon(invocation))
            return;
        const json = this._impl ? this._impl.focus() : 'null';
        invocation.return_value(new GLib.Variant('(s)', [json]));
    }

    ShowAsync([json], invocation) {
        if (this._fromDaemon(invocation))
            this._run(invocation, () => this._impl?.show(JSON.parse(json)));
    }

    UpdateAsync([json], invocation) {
        if (this._fromDaemon(invocation))
            this._run(invocation, () => this._impl?.update(JSON.parse(json)));
    }

    ClickAsync([x, y], invocation) {
        if (this._fromDaemon(invocation))
            this._run(invocation, () => this._impl?.click(x, y));
    }

    HideAsync(_params, invocation) {
        if (this._fromDaemon(invocation))
            this._run(invocation, () => this._impl?.hide());
    }

    // @dev-start
    ReloadAsync(_params, invocation) {
        if (!this._devOnly(invocation))
            return;
        this._reload().then(
            () => invocation.return_value(null),
            e => invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', String(e)));
    }

    DebugScreenshotAsync(_params, invocation) {
        if (!this._devOnly(invocation))
            return;
        const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'pounce']);
        GLib.mkdir_with_parents(dir, 0o700);
        const path = GLib.build_filenamev([dir, 'shot.png']);
        this._impl.screenshot(path).then(
            () => invocation.return_value(new GLib.Variant('(s)', [path])),
            e => invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', String(e)));
    }
    // @dev-end
}
