#!/bin/sh
# Uninstall Octopus for the current user: remove the launcher symlink and the
# program dir. Your DATA dir (~/.local/share/octopus) is LEFT UNTOUCHED so tasks,
# sessions and settings survive a reinstall; the path is printed so you can remove
# it by hand if you truly want a clean slate.

set -eu

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
PROGRAM_DIR="$DATA_HOME/octopus-app"
DATA_DIR="$DATA_HOME/octopus"
SYMLINK="$HOME/.local/bin/octopus"
ICON_DEST="$DATA_HOME/icons/hicolor/512x512/apps/octopus.png"
APPS_DIR="$DATA_HOME/applications"
DESKTOP_FILE="$APPS_DIR/octopus.desktop"

CLI_SYMLINK="$HOME/.local/bin/octopus-cli"
SKILL_DEST="$HOME/.claude/skills/octopus"

# Only remove the symlink if it points into our program dir (don't clobber a
# same-named binary the user put there themselves).
if [ -L "$SYMLINK" ]; then
  TARGET=$(readlink "$SYMLINK")
  case "$TARGET" in
    "$PROGRAM_DIR"/*) rm -f "$SYMLINK"; echo "Removed launcher $SYMLINK" ;;
    *) echo "note: $SYMLINK does not point into $PROGRAM_DIR — left as-is." ;;
  esac
fi

if [ -L "$CLI_SYMLINK" ]; then
  TARGET=$(readlink "$CLI_SYMLINK")
  case "$TARGET" in
    "$PROGRAM_DIR"/*) rm -f "$CLI_SYMLINK"; echo "Removed CLI $CLI_SYMLINK" ;;
    *) echo "note: $CLI_SYMLINK does not point into $PROGRAM_DIR — left as-is." ;;
  esac
fi

# Only remove the skill dir if it is ours (carries the install.sh marker file).
if [ -f "$SKILL_DEST/.octopus-managed" ]; then
  rm -rf "$SKILL_DEST"
  echo "Removed Claude skill $SKILL_DEST"
fi

if [ -d "$PROGRAM_DIR" ]; then
  rm -rf "$PROGRAM_DIR"
  echo "Removed program dir $PROGRAM_DIR"
fi

# --- desktop integration (icon + launcher entry) ------------------------------
if [ -f "$DESKTOP_FILE" ]; then
  rm -f "$DESKTOP_FILE"
  echo "Removed desktop entry $DESKTOP_FILE"
fi

if [ -f "$ICON_DEST" ]; then
  rm -f "$ICON_DEST"
  echo "Removed icon $ICON_DEST"
fi

# Nudge desktop environments to notice the icon is gone: touch the hicolor theme
# dir's mtime (what `xdg-icon-resource uninstall` does), best-effort. Deliberately
# NOT `gtk-update-icon-cache`/`update-desktop-database` — see install.sh.
touch -c "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true

echo
echo "Your data was NOT removed: $DATA_DIR"
echo "Delete it manually if you want a clean slate:  rm -rf \"$DATA_DIR\""
