# zmk-split-battery-tray — design

Goal: Ubuntu top-bar indicator showing left + right battery percentages
of a ZMK split keyboard used in dongle mode, while keeping the dongle
USB-HID workflow.

## Layout of work

| Concern  | Where                                                                       |
| -------- | --------------------------------------------------------------------------- |
| Firmware | `firmware/battery_hid.c` + `firmware/CMakeLists.txt`, dropped into a shield directory of the user's `zmk-config` |
| Host     | `extension/` (GNOME Shell extension), `udev/` (hidraw access), `install.sh` |

Firmware patch ships as two files the user copies into their config
repo. We do not maintain a separate Zephyr module because it would
complicate the GitHub Actions build path that ZMK users already have.

## Firmware patch

A second USB HID interface is registered on the dongle, alongside the
existing keyboard interface. The new interface carries one input report
(Report ID 1, 2 bytes) — left battery %, right battery %. Values are
0..100 with `0xFF` reserved as "unknown" sentinel.

Activation is gated on `CONFIG_ZMK_SPLIT_BATTERY_HID_REPORT`. The patch
also depends on `CONFIG_ZMK_SPLIT_BLE_CENTRAL_BATTERY_LEVEL_FETCHING=y`
(the source of the events we subscribe to) and bumps
`CONFIG_USB_HID_DEVICE_COUNT=2` so Zephyr reserves a second HID slot
that we bind via `device_get_binding("HID_1")`.

`SYS_INIT` priority is `APPLICATION 91` — late enough that ZMK's own
HID registration has already taken `HID_0`, early enough that
`usb_enable()` hasn't run yet.

## Host side

- `udev/99-zmk-split-battery.rules` matches the dongle's USB VID:PID
  and tags the hidraw nodes with `uaccess`, so the active session
  user has read permission without root.
- The GNOME Shell extension scans `/sys/class/hidraw/*/device/` for an
  interface whose `HID_ID` matches the configured VID:PID *and* whose
  `report_descriptor` starts with the Vendor Usage Page prefix
  (`0x06 0x00 0xFF`). That uniquely picks our interface even when the
  same VID:PID exposes multiple HID interfaces.
- It then `Gio.File.read()`s that node and consumes 3-byte reports
  asynchronously. State updates a two-line `St.BoxLayout` in the panel
  and a section header + per-side rows in the popup menu. The header
  text reflects the device name parsed from `HID_NAME` in the uevent.
- Reconnect logic: any open/read failure schedules a 2-second retry
  via `GLib.timeout_add_seconds`, surviving dongle replug.
