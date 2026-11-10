#!/bin/sh
# Install Octopus for the current user. Run from inside the extracted release
# directory (octopus-<version>/), i.e. after `tar xzf Octopus-<version>-x86_64.tar.gz`.
#
# What it does:
#   - copies the app payload to a per-user PROGRAM dir (atomic replace),
#   - symlinks a launcher into ~/.local/bin so `octopus` runs from anywhere,
#   - symlinks the `octopus-cli` launcher (shipped next to the binary) into ~/.local/bin, and
#   - copies the Claude Code skill to ~/.claude/skills/octopus (replace-in-place).
#
# It deliberately does NOT touch your DATA dir (~/.local/share/octopus): your tasks,
# sessions and settings survive install, upgrade, and uninstall. Version compatibility
# of that data is handled by the app itself (schema migrations), not by this script.
#
# No root required; nothing is installed system-wide (this is not an apt package).
#
# The replace is atomic: the payload is staged into "$PROGRAM_DIR.new", then the live
# dir is renamed to ".old", ".new" is renamed into place, and ".old" is deleted. A
# failure before the swap leaves the live install untouched. Running it while Octopus
# is running is safe because the running app keeps its already-open files and is
# relaunched promptly by the in-app updater (do not rely on files lazily opened later
# staying valid: ".old" is deleted right after the swap). Octopus' in-app updater runs
# this script non-interactively while the app is running, then relaunches. Keep the
# script runnable non-interactively (no prompts, no tty needed), including by older
# Octopus builds that invoke it as `sh <dir>/install.sh` with cwd = <dir>.

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

# --- install (atomic replace) -------------------------------------------------
echo "Installing Octopus to $PROGRAM_DIR ..."
NEW_DIR="$PROGRAM_DIR.new"
OLD_DIR="$PROGRAM_DIR.old"

# Until the swap succeeds, any failure/interrupt removes the half-staged copy and
# leaves the live dir untouched.
STAGING=1
cleanup() {
  if [ "$STAGING" = 1 ]; then
    rm -rf "$NEW_DIR"
    # Interrupted between the two swap renames: put the previous install back.
    if [ ! -e "$PROGRAM_DIR" ] && [ -e "$OLD_DIR" ]; then
      mv "$OLD_DIR" "$PROGRAM_DIR" || true
    fi
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# Stale leftovers from an earlier interrupted run. If that run died between the swap
# renames, the live dir is missing and ".old" is the previous install: restore it first.
if [ ! -e "$PROGRAM_DIR" ] && [ -e "$OLD_DIR" ]; then
  mv "$OLD_DIR" "$PROGRAM_DIR" || true
fi
rm -rf "$NEW_DIR" "$OLD_DIR"

mkdir -p "$NEW_DIR"
cp -a "$PAYLOAD/." "$NEW_DIR/"

if [ ! -x "$NEW_DIR/octopus" ]; then
  echo "error: staged copy is missing an executable $NEW_DIR/octopus; install aborted, existing install untouched." >&2
  exit 1
fi

# Swap. Both renames are within the same parent dir, so they are atomic.
if [ -e "$PROGRAM_DIR" ]; then
  mv "$PROGRAM_DIR" "$OLD_DIR"
fi
if ! mv "$NEW_DIR" "$PROGRAM_DIR"; then
  echo "error: could not move the new install into place; restoring the previous install." >&2
  if [ -e "$OLD_DIR" ]; then
    mv "$OLD_DIR" "$PROGRAM_DIR" || echo "error: restore failed; previous install is at $OLD_DIR." >&2
  fi
  exit 1
fi
STAGING=0
# The new payload is live. Everything below is best-effort: a failure here warns but
# must not turn a successful install into a non-zero exit.
rm -rf "$OLD_DIR" || echo "warning: could not remove $OLD_DIR" >&2

# --- link launcher onto PATH --------------------------------------------------
{ mkdir -p "$BIN_DIR" && ln -sf "$LAUNCHER" "$SYMLINK"; } ||
  echo "warning: could not link $SYMLINK" >&2

echo "Installed. Launcher symlinked at $SYMLINK -> $LAUNCHER"

if { mkdir -p "$BIN_DIR" && ln -sf "$CLI_LAUNCHER" "$CLI_SYMLINK"; }; then
  echo "CLI symlinked at $CLI_SYMLINK -> $CLI_LAUNCHER"
else
  echo "warning: could not link $CLI_SYMLINK" >&2
fi

# --- Claude Code skill (replace in place) -------------------------------------
install_skill() {
  rm -rf "$SKILL_DEST" && mkdir -p "$SKILL_DEST" && cp -a "$SKILL_SRC/." "$SKILL_DEST/"
}
if [ ! -e "$SKILL_DEST" ] || [ -f "$SKILL_DEST/.octopus-managed" ]; then
  if install_skill; then
    echo "Claude skill installed at $SKILL_DEST"
  else
    echo "warning: could not install the Claude skill at $SKILL_DEST" >&2
  fi
else
  echo "warning: $SKILL_DEST exists and is not Octopus-managed — skill not installed." >&2
fi

# --- desktop integration (icon + launcher entry) ------------------------------
{ mkdir -p "$ICON_DIR" && cp "$ICON_SRC" "$ICON_DEST"; } ||
  echo "warning: could not install icon $ICON_DEST" >&2

write_desktop_file() {
  mkdir -p "$APPS_DIR" || return 1
  cat > "$DESKTOP_FILE" <<DESKTOP_EOF
[Desktop Entry]
Type=Application
Name=Octopus
Comment=IDE for running multiple development tasks in parallel
Exec="$SYMLINK"
Icon=octopus
Terminal=false
Categories=Development;
StartupWMClass=$WM_CLASS
DESKTOP_EOF
}
write_desktop_file || echo "warning: could not write $DESKTOP_FILE" >&2

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
