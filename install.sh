#!/bin/sh
# Install Octopus for the current user. Run from inside the extracted release
# directory (octopus-<version>/), i.e. after `tar xzf Octopus-<version>-x86_64.tar.gz`.
#
# What it does:
#   - copies the app payload to a per-user PROGRAM dir (replace-in-place), and
#   - symlinks a launcher into ~/.local/bin so `octopus` runs from anywhere,
#   - symlinks the `octopus-cli` launcher (shipped next to the binary) into ~/.local/bin, and
#   - copies the Claude Code skill to ~/.claude/skills/octopus (replace-in-place).
#
# It deliberately does NOT touch your DATA dir (~/.local/share/octopus): your tasks,
# sessions and settings survive install, upgrade, and uninstall. Version compatibility
# of that data is handled by the app itself (schema migrations), not by this script.
#
# No root required; nothing is installed system-wide (this is not an apt package).

set -eu

# --- resolve locations --------------------------------------------------------
# Directory this script lives in (the extracted release dir).
SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PAYLOAD="$SRC_DIR/linux-unpacked"
ICON_SRC="$SRC_DIR/icon.png"
SKILL_SRC="$SRC_DIR/claude-skill/octopus"

# Program dir: where the app files live. Distinct from the DATA dir on purpose.
PROGRAM_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/octopus-app"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$PROGRAM_DIR/octopus"
SYMLINK="$BIN_DIR/octopus"
# octopus-cli sits next to the binary (it cannot live inside app.asar and be exec'd).
CLI_LAUNCHER="$PROGRAM_DIR/octopus-cli"
CLI_SYMLINK="$BIN_DIR/octopus-cli"
# Claude Code user-level skill dir.
SKILL_DEST="$HOME/.claude/skills/octopus"

# Desktop integration: launcher icon theme entry + .desktop file.
# StartupWMClass="octopus" matches the WM_CLASS Electron sets for this app
# (package.json "name" and electron-builder.yml's executableName are both "octopus";
# verified live with `xprop WM_CLASS` against a running build).
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
ICON_DIR="$DATA_HOME/icons/hicolor/512x512/apps"
ICON_DEST="$ICON_DIR/octopus.png"
APPS_DIR="$DATA_HOME/applications"
DESKTOP_FILE="$APPS_DIR/octopus.desktop"
WM_CLASS="octopus"

if [ ! -x "$PAYLOAD/octopus" ]; then
  echo "error: $PAYLOAD/octopus not found — run this script from inside the extracted release dir." >&2
  exit 1
fi

if [ ! -x "$PAYLOAD/octopus-cli" ] || [ ! -f "$SKILL_SRC/SKILL.md" ]; then
  echo "error: octopus-cli or claude-skill/octopus missing in $SRC_DIR — incomplete release dir." >&2
  exit 1
fi

if [ ! -f "$ICON_SRC" ]; then
  echo "error: $ICON_SRC not found — run this script from inside the extracted release dir." >&2
  exit 1
fi

# --- install (replace in place) ----------------------------------------------
echo "Installing Octopus to $PROGRAM_DIR ..."
rm -rf "$PROGRAM_DIR"
mkdir -p "$PROGRAM_DIR"
cp -a "$PAYLOAD/." "$PROGRAM_DIR/"

# --- link launcher onto PATH --------------------------------------------------
mkdir -p "$BIN_DIR"
ln -sf "$LAUNCHER" "$SYMLINK"

echo "Installed. Launcher symlinked at $SYMLINK -> $LAUNCHER"

ln -sf "$CLI_LAUNCHER" "$CLI_SYMLINK"
echo "CLI symlinked at $CLI_SYMLINK -> $CLI_LAUNCHER"

# --- Claude Code skill (replace in place) -------------------------------------
if [ ! -e "$SKILL_DEST" ] || [ -f "$SKILL_DEST/.octopus-managed" ]; then
  rm -rf "$SKILL_DEST"
  mkdir -p "$SKILL_DEST"
  cp -a "$SKILL_SRC/." "$SKILL_DEST/"
  echo "Claude skill installed at $SKILL_DEST"
else
  echo "warning: $SKILL_DEST exists and is not Octopus-managed — skill not installed." >&2
fi

# --- desktop integration (icon + launcher entry) ------------------------------
mkdir -p "$ICON_DIR"
cp "$ICON_SRC" "$ICON_DEST"

mkdir -p "$APPS_DIR"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Octopus
Comment=IDE for running multiple development tasks in parallel
Exec="$SYMLINK"
Icon=octopus
Terminal=false
Categories=Development;
StartupWMClass=$WM_CLASS
EOF

echo "Desktop entry installed at $DESKTOP_FILE"

# Nudge desktop environments to notice the new icon without a logout: touch the
# hicolor theme dir's mtime (what `xdg-icon-resource install` does), best-effort.
# Deliberately NOT `gtk-update-icon-cache`/`update-desktop-database`: those write
# user-level icon-theme.cache/mimeinfo.cache files that uninstall can't cleanly
# remove, and a stale hicolor icon-theme.cache can hide icons OTHER apps add
# there later.
touch -c "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true

# Warn if ~/.local/bin is not on PATH so `octopus` actually resolves.
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *)
    echo
    echo "note: $BIN_DIR is not on your PATH. Add this to your shell profile:"
    echo "    export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo
echo "Done. Run: octopus"
