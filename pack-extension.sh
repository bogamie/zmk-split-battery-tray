#!/usr/bin/env bash
# Pack the extension into a zip ready for upload to
# https://extensions.gnome.org/upload/
#
# The zip's root must contain metadata.json — gnome-extensions pack
# handles the layout and schema compilation for us.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$REPO_DIR/extension"
OUT_DIR="$REPO_DIR/dist"

mkdir -p "$OUT_DIR"

gnome-extensions pack \
    --force \
    --schema="$SRC_DIR/schemas/org.gnome.shell.extensions.zmk-split-battery.gschema.xml" \
    --extra-source="stylesheet.css" \
    --podir="" \
    --out-dir="$OUT_DIR" \
    "$SRC_DIR"

echo
echo "Done. Upload to https://extensions.gnome.org/upload/"
ls -la "$OUT_DIR"/*.shell-extension.zip
