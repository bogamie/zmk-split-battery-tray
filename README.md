# zmk-split-battery-tray

A GNOME Shell top-bar indicator that shows the **left** and **right**
battery percentages of a [ZMK][zmk] split keyboard used in dongle
mode — modeled after macOS multi-device battery menulets.

The dongle's stock USB-HID interface only carries keyboard reports, so
this project ships **two pieces** that work together:

1. A small **firmware patch** (under `firmware/`) you drop into your
   [`zmk-config`][zmk-config]. It adds a second USB HID interface on
   the dongle that publishes the peripheral battery values.
2. A **GNOME Shell extension** (under `extension/`) that reads that
   interface and renders the values in the top bar.

[zmk]: https://zmk.dev
[zmk-config]: https://zmk.dev/docs/user-setup

## Compatibility

| Layer       | Compatibility                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Firmware C  | Any ZMK split keyboard with a dongle (totem, corne, sofle, lily58, …). No board-specific code.      |
| USB VID:PID | Defaults to `1d50:615e` (OpenMoko's allocation for ZMK Project — shared by most ZMK dongle builds). |
| Host        | Ubuntu / GNOME Shell 45+. Tested on GNOME 46 / X11.                                                 |

If your dongle uses different USB IDs, override `VENDOR_ID` /
`PRODUCT_ID` in `extension/extension.js` and the `idVendor` /
`idProduct` in `udev/99-zmk-split-battery.rules`.

## Why

Out-of-the-box ZMK can publish per-side battery levels over BLE
(via the `ZMK_SPLIT_BLE_CENTRAL_BATTERY_LEVEL_PROXY` BAS proxy), but
that path is dead when the host talks to the dongle over USB. Existing
host-side tools like [`kot149/zmk-battery-center`][center] and
[`mh4x0f/zmkBATx`][batx] both assume a direct PC ↔ keyboard BLE link
and don't fit the dongle workflow. This repo fills that gap.

[center]: https://github.com/kot149/zmk-battery-center
[batx]: https://github.com/mh4x0f/zmkBATx

## Architecture

```
┌─────────────┐  BLE   ┌────────────┐  BLE   ┌─────────────┐
│  Left half  │ ─────► │   Dongle   │ ◄───── │  Right half │
│ (peripheral)│        │  (central) │        │ (peripheral)│
└─────────────┘        └─────┬──────┘        └─────────────┘
                             │ USB
                             │   ┌─ HID interface 1: keyboard (existing)
                             ├───┤
                             │   └─ HID interface 2: vendor battery (added)
                             ▼
                       ┌──────────┐
                       │  Linux   │  /dev/hidrawN  ──┐
                       │  kernel  │                  │
                       └──────────┘                  │
                                                     ▼
                                              ┌─────────────┐
                                              │ GNOME Shell │
                                              │  extension  │
                                              └─────────────┘
```

The new HID interface emits a 3-byte input report whenever a peripheral
battery event fires inside the firmware:

| byte | meaning                                            |
| ---- | -------------------------------------------------- |
| 0    | report id (always `0x01`)                          |
| 1    | left battery percent — `0..100`, `0xFF` = unknown  |
| 2    | right battery percent — `0..100`, `0xFF` = unknown |

The extension finds the right `/dev/hidrawN` by scanning each HID
interface's `report_descriptor` for the Vendor Usage Page prefix
(`0x06 0x00 0xFF`) — no hardcoded path, survives device replug, and
lets multiple keyboards coexist.

## Install

### Firmware patch

Drop the two files in `firmware/` into your shield directory inside
your `zmk-config` repo:

```
config/boards/shields/<your-shield>/
├── battery_hid.c          # the HID descriptor + listener
├── CMakeLists.txt         # gates battery_hid.c on a Kconfig flag
└── (existing .conf, .overlay, Kconfig.defconfig — see below)
```

Then add the Kconfig option in `Kconfig.defconfig` (inside the dongle's
`if SHIELD_<YOUR_DONGLE>` block):

```kconfig
config ZMK_SPLIT_BATTERY_HID_REPORT
    bool "Expose left/right peripheral battery levels via a custom USB HID report"
    default y
    depends on ZMK_USB && ZMK_SPLIT_BLE_CENTRAL_BATTERY_LEVEL_FETCHING
```

And in your dongle's `.conf`:

```conf
CONFIG_ZMK_SPLIT_BLE_CENTRAL_BATTERY_LEVEL_FETCHING=y
CONFIG_USB_HID_DEVICE_COUNT=2
```

Commit, push, let GitHub Actions build, flash dongle + halves.

### Extension

```sh
./install.sh
```

That installs the udev rule, copies the extension into
`~/.local/share/gnome-shell/extensions/zmk-split-battery@bogamie.github.io/`,
and enables it. Reload GNOME Shell:

- **X11**: press `Alt+F2`, type `r`, hit Enter.
- **Wayland**: log out and back in.

## Repo layout

```
.
├── README.md
├── DESIGN.md                       — architecture notes
├── LICENSE                         — MIT
├── install.sh                      — one-shot setup
├── extension/                      — GNOME Shell extension
│   ├── metadata.json
│   ├── extension.js
│   └── stylesheet.css
├── firmware/                       — files to drop into your zmk-config
│   ├── battery_hid.c
│   └── CMakeLists.txt
└── udev/
    └── 99-zmk-split-battery.rules
```

## Customization

| Want to…                                  | Where                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Match a different USB VID/PID             | `extension/extension.js` (`VENDOR_ID` / `PRODUCT_ID`) and the udev rule            |
| Change the panel font size                | `extension/stylesheet.css` → `.split-battery-letter` / `.split-battery-pct` font-size |
| Change the menu device-name               | iProduct in firmware (`CONFIG_USB_DEVICE_PRODUCT`), or strip prefix in `extension.js` |
| Lower first-display latency               | `CONFIG_ZMK_BATTERY_REPORT_INTERVAL=30` in dongle `.conf`                          |

## Troubleshooting

| Symptom                                | Check                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Extension loaded but no values         | `ls /dev/hidraw*` after flash — does a new node appear? `cat /sys/class/hidraw/<N>/device/uevent`.   |
| `Searching for dongle…` won't go away  | Wait up to 60 s after first plug — battery events fire at the ZMK report interval.                   |
| Permission denied on `/dev/hidraw*`    | Re-run `sudo udevadm control --reload-rules && sudo udevadm trigger`, then replug dongle.            |
| Shell logs                             | `journalctl --user -f /usr/bin/gnome-shell`                                                          |

## Acknowledgments

- [ZMK firmware][zmk] (MIT) — the underlying split keyboard stack and
  battery event API consumed by the firmware patch.
- [`kot149/zmk-battery-center`][center] and [`mh4x0f/zmkBATx`][batx] —
  prior-art for ZMK battery monitoring on the desktop, both BLE-based.
  This project takes the dongle-USB path that neither covers.

## License

[MIT](./LICENSE) — see file. The firmware patch consumes ZMK and
Zephyr APIs but contains no copied code; ZMK itself is MIT and Zephyr
is Apache-2.0, both compatible.
