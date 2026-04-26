// SPDX-License-Identifier: MIT
//
// Reads battery percentages directly from a ZMK split keyboard dongle's
// vendor HID interface and renders them as two stacked lines in the
// GNOME panel — modeled after macOS-style multi-device battery menulets.
//
// Discovery: scans /sys/class/hidraw/* for an interface whose
// report_descriptor starts with the Vendor Usage Page prefix
// 0x06 0x00 0xFF (matching the firmware patch in firmware/battery_hid.c).
// Each input report is 3 bytes: [report_id=0x01, left%, right%], with
// 0xFF reserved as "unknown" sentinel.

import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

// Make Gio.File.load_contents_async() return a Promise so the discovery
// path can stay non-blocking (sync file IO is flagged by shexli /
// extensions.gnome.org reviewers as it stalls the GNOME Shell main loop).
Gio._promisify(Gio.File.prototype, "load_contents_async");

// 0x1d50:0x615e is OpenMoko's allocation for ZMK Project — many ZMK
// keyboards (totem, corne, sofle, lily58, …) share this VID:PID, so
// this extension works across them out of the box. Edit here if your
// dongle uses different IDs.
const VENDOR_ID = 0x1d50;
const PRODUCT_ID = 0x615e;
const REPORT_ID = 0x01;
const REPORT_LEN = 3;
const UNKNOWN = 0xff;
const VENDOR_USAGE_PAGE_PREFIX = [0x06, 0x00, 0xff];

const RETRY_SECONDS = 2;

const fmtPct = (level) => (level === UNKNOWN ? "—" : `${level}%`);

const menuIconForLevel = (level) => {
    if (level === UNKNOWN) return "battery-missing-symbolic";
    if (level < 10) return "battery-empty-symbolic";
    if (level < 30) return "battery-low-symbolic";
    if (level < 60) return "battery-good-symbolic";
    return "battery-full-symbolic";
};

const expectedHidId = () => {
    const vid = VENDOR_ID.toString(16).toUpperCase().padStart(8, "0");
    const pid = PRODUCT_ID.toString(16).toUpperCase().padStart(8, "0");
    return `HID_ID=0003:${vid}:${pid}`;
};

const SplitBatteryIndicator = GObject.registerClass(
    class SplitBatteryIndicator extends PanelMenu.Button {
        _init(settings) {
            // menuAlignment 0.5 => popup centered under the indicator
            super._init(0.5, "ZMK Split Battery");

            this._settings = settings;
            this.add_style_class_name("split-battery-indicator");

            const box = new St.BoxLayout({
                vertical: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: "split-battery-box",
            });

            const makeRow = (letter) => {
                const row = new St.BoxLayout({
                    vertical: false,
                    style_class: "split-battery-row",
                });
                const prefix = new St.Label({
                    text: letter,
                    y_align: Clutter.ActorAlign.CENTER,
                    x_align: Clutter.ActorAlign.START,
                    style_class: "split-battery-letter",
                });
                const label = new St.Label({
                    text: "—",
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: "split-battery-pct",
                });
                row.add_child(prefix);
                row.add_child(label);
                return { row, label };
            };

            const left = makeRow("L");
            const right = makeRow("R");
            this._leftLabel = left.label;
            this._rightLabel = right.label;
            box.add_child(left.row);
            box.add_child(right.row);
            this.add_child(box);

            // Section header that doubles as the connection status.
            this._headerItem = new PopupMenu.PopupSeparatorMenuItem(
                "Searching for dongle…",
            );

            const makeMenuRow = (prefixText) => {
                const item = new PopupMenu.PopupBaseMenuItem({
                    reactive: false,
                });
                item.add_style_class_name("split-battery-info-item");
                const icon = new St.Icon({
                    icon_name: menuIconForLevel(UNKNOWN),
                    style_class: "split-battery-menu-icon",
                });
                const prefix = new St.Label({
                    text: prefixText,
                    style_class: "split-battery-menu-prefix",
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const pct = new St.Label({
                    text: "—",
                    style_class: "split-battery-menu-pct",
                    y_align: Clutter.ActorAlign.CENTER,
                });
                item.add_child(icon);
                item.add_child(prefix);
                item.add_child(pct);
                return { item, icon, pct };
            };

            const leftRow = makeMenuRow("Left");
            const rightRow = makeMenuRow("Right");
            this._leftItem = leftRow.item;
            this._rightItem = rightRow.item;
            this._leftMenuIcon = leftRow.icon;
            this._rightMenuIcon = rightRow.icon;
            this._leftMenuPct = leftRow.pct;
            this._rightMenuPct = rightRow.pct;

            this.menu.addMenuItem(this._headerItem);
            this.menu.addMenuItem(this._leftItem);
            this.menu.addMenuItem(this._rightItem);

            this._left = UNKNOWN;
            this._right = UNKNOWN;
            this._stream = null;
            this._cancellable = new Gio.Cancellable();
            this._retryId = 0;
            this._destroyed = false;

            this._settingsHandlerId = this._settings.connect(
                "changed",
                () => this._applyVisibility(),
            );

            // Initial visibility: respect the "hide when disconnected"
            // setting until a dongle is actually opened.
            this._connected = false;
            this._applyVisibility();

            this._findAndOpen();
        }

        _setStatus(text) {
            this._headerItem.label.set_text(text);
        }

        _applyVisibility() {
            const hideOnDisconnect = this._settings.get_boolean(
                "hide-when-disconnected",
            );
            this.visible = this._connected || !hideOnDisconnect;
        }

        _refresh() {
            this._leftLabel.set_text(fmtPct(this._left));
            this._rightLabel.set_text(fmtPct(this._right));
            this._leftMenuPct.set_text(fmtPct(this._left));
            this._rightMenuPct.set_text(fmtPct(this._right));
            this._leftMenuIcon.set_icon_name(menuIconForLevel(this._left));
            this._rightMenuIcon.set_icon_name(menuIconForLevel(this._right));
        }

        async _loadBytes(path) {
            const file = Gio.File.new_for_path(path);
            const [contents] = await file.load_contents_async(
                this._cancellable,
            );
            return contents;
        }

        async _findHidraw() {
            const target = expectedHidId();
            const dir = Gio.File.new_for_path("/sys/class/hidraw");
            let enumerator;
            try {
                enumerator = dir.enumerate_children(
                    "standard::name",
                    Gio.FileQueryInfoFlags.NONE,
                    null,
                );
            } catch {
                return null;
            }
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (!name.startsWith("hidraw")) continue;

                let uevent;
                try {
                    const bytes = await this._loadBytes(
                        `/sys/class/hidraw/${name}/device/uevent`,
                    );
                    uevent = new TextDecoder().decode(bytes);
                } catch {
                    continue;
                }
                if (!uevent.includes(target)) continue;

                let desc;
                try {
                    desc = await this._loadBytes(
                        `/sys/class/hidraw/${name}/device/report_descriptor`,
                    );
                } catch {
                    continue;
                }
                if (desc.length < VENDOR_USAGE_PAGE_PREFIX.length) continue;
                const matches = VENDOR_USAGE_PAGE_PREFIX.every(
                    (b, i) => desc[i] === b,
                );
                if (matches) {
                    const nameMatch = uevent.match(/^HID_NAME=(.+)$/m);
                    const raw = nameMatch ? nameMatch[1].trim() : "";
                    // Strip the boilerplate "ZMK Project " prefix that
                    // ZMK adds to the USB iProduct string, so the menu
                    // header just reads e.g. "TOTEM". Cap length to
                    // avoid a hostile USB descriptor blowing up the
                    // menu layout.
                    const stripped = raw.replace(/^ZMK Project\s+/i, "");
                    const deviceName = (
                        stripped ||
                        raw ||
                        "ZMK keyboard"
                    ).slice(0, 64);
                    return { path: `/dev/${name}`, deviceName };
                }
            }
            return null;
        }

        _scheduleRetry() {
            if (this._destroyed || this._retryId) return;
            this._retryId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                RETRY_SECONDS,
                () => {
                    this._retryId = 0;
                    this._findAndOpen();
                    return GLib.SOURCE_REMOVE;
                },
            );
        }

        async _findAndOpen() {
            if (this._destroyed) return;
            const found = await this._findHidraw();
            if (this._destroyed) return;
            if (!found) {
                this._setStatus("Searching for dongle…");
                this._connected = false;
                this._applyVisibility();
                this._scheduleRetry();
                return;
            }
            const { path, deviceName } = found;
            try {
                const file = Gio.File.new_for_path(path);
                this._stream = file.read(this._cancellable);
            } catch (e) {
                console.error(
                    `zmk-split-battery: open ${path} failed: ${e}`,
                );
                this._setStatus(`Open failed: ${e.message}`);
                this._connected = false;
                this._applyVisibility();
                this._scheduleRetry();
                return;
            }
            this._setStatus(deviceName);
            this._connected = true;
            this._applyVisibility();
            this._readNext();
        }

        _readNext() {
            if (!this._stream || this._destroyed) return;
            this._stream.read_bytes_async(
                REPORT_LEN,
                GLib.PRIORITY_DEFAULT,
                this._cancellable,
                (src, res) => {
                    if (this._destroyed) return;
                    let bytes;
                    try {
                        bytes = src.read_bytes_finish(res);
                    } catch (e) {
                        if (
                            !e.matches?.(
                                Gio.IOErrorEnum,
                                Gio.IOErrorEnum.CANCELLED,
                            )
                        ) {
                            console.error(
                                `zmk-split-battery: read error: ${e}`,
                            );
                        }
                        this._closeStream();
                        this._setStatus("Disconnected, retrying…");
                        this._connected = false;
                        this._applyVisibility();
                        this._scheduleRetry();
                        return;
                    }
                    if (!bytes || bytes.get_size() === 0) {
                        this._closeStream();
                        this._setStatus("Disconnected, retrying…");
                        this._connected = false;
                        this._applyVisibility();
                        this._scheduleRetry();
                        return;
                    }
                    const data = bytes.get_data();
                    if (data.length >= REPORT_LEN && data[0] === REPORT_ID) {
                        const a = data[1];
                        const b = data[2];
                        const swap = this._settings.get_boolean("swap-lr");
                        this._left = swap ? b : a;
                        this._right = swap ? a : b;
                        this._refresh();
                    }
                    this._readNext();
                },
            );
        }

        _closeStream() {
            if (this._stream) {
                try {
                    this._stream.close(null);
                } catch {
                    // ignore
                }
                this._stream = null;
            }
        }

        destroy() {
            this._destroyed = true;
            if (this._retryId) {
                GLib.Source.remove(this._retryId);
                this._retryId = 0;
            }
            if (this._settingsHandlerId) {
                this._settings.disconnect(this._settingsHandlerId);
                this._settingsHandlerId = 0;
            }
            this._cancellable.cancel();
            this._closeStream();
            super.destroy();
        }
    },
);

export default class SplitBatteryExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new SplitBatteryIndicator(this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
