#!/usr/bin/env bash
# Installer for the ZMK split battery GNOME Shell extension on Ubuntu.
# Run from the repo root: ./install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
UUID="zmk-split-battery@bogamie.github.io"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo ">> udev: install hidraw access rule"
sudo install -m 0644 "$REPO_DIR/udev/99-zmk-split-battery.rules" /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger

echo ">> extension: copy to $EXT_DIR"
mkdir -p "$EXT_DIR"
cp -r "$REPO_DIR/extension/." "$EXT_DIR/"

echo ">> extension: enable"
gnome-extensions enable "$UUID" || true

echo
echo "Done. Reload GNOME Shell to pick up the new extension:"
echo "  - X11: press Alt+F2, type 'r', press Enter"
echo "  - Wayland: log out and log back in"
echo
echo "Status:        gnome-extensions info $UUID"
echo "Live logs:     journalctl --user -f /usr/bin/gnome-shell"
