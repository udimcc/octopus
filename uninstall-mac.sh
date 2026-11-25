#!/bin/sh
# Uninstall Octopus on macOS for the current user (counterpart of uninstall.sh): remove the
# CLI symlink, the Claude skill (if Octopus-managed) and ~/Applications/Octopus.app. Your DATA
# dir (~/.local/share/octopus) is LEFT UNTOUCHED; its path is printed so you can remove it by
# hand. Quit Octopus first. Honors OCTOPUS_APPS_DIR like install-mac.sh.

set -eu

APPS_DIR="${OCTOPUS_APPS_DIR:-$HOME/Applications}"
APP_DIR="$APPS_DIR/Octopus.app"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/octopus"
CLI_SYMLINK="$HOME/.local/bin/octopus-cli"
SKILL_DEST="$HOME/.claude/skills/octopus"

# Only remove the symlink if it points into our app bundle.
if [ -L "$CLI_SYMLINK" ]; then
  TARGET=$(readlink "$CLI_SYMLINK")
  case "$TARGET" in
    "$APP_DIR"/*) rm -f "$CLI_SYMLINK"; echo "Removed CLI $CLI_SYMLINK" ;;
    *) echo "note: $CLI_SYMLINK does not point into $APP_DIR — left as-is." ;;
  esac
fi

# Only remove the skill dir if it is ours (carries the installer's marker file).
if [ -f "$SKILL_DEST/.octopus-managed" ]; then
  rm -rf "$SKILL_DEST"
  echo "Removed Claude skill $SKILL_DEST"
fi

if [ -d "$APP_DIR" ]; then
  rm -rf "$APP_DIR"
  echo "Removed $APP_DIR"
fi

echo
echo "Your data was NOT removed: $DATA_DIR"
echo "Delete it manually if you want a clean slate:  rm -rf \"$DATA_DIR\""
