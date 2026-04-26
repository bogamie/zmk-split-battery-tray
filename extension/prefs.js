// SPDX-License-Identifier: MIT

import Adw from "gi://Adw";
import Gio from "gi://Gio";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class SplitBatteryPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: "General",
            icon_name: "preferences-system-symbolic",
        });
        window.add(page);

        const display = new Adw.PreferencesGroup({
            title: "Display",
        });
        page.add(display);

        const swapRow = new Adw.SwitchRow({
            title: "Swap left and right",
            subtitle:
                "Flip this if your halves appear reversed (ZMK assigns slot indices by pairing order).",
        });
        settings.bind(
            "swap-lr",
            swapRow,
            "active",
            Gio.SettingsBindFlags.DEFAULT,
        );
        display.add(swapRow);

        const hideRow = new Adw.SwitchRow({
            title: "Hide when disconnected",
            subtitle:
                "Remove the panel indicator while the keyboard is unplugged.",
        });
        settings.bind(
            "hide-when-disconnected",
            hideRow,
            "active",
            Gio.SettingsBindFlags.DEFAULT,
        );
        display.add(hideRow);
    }
}
