#!/bin/sh
# Uninstall Octopus for the current user: remove the launcher symlink and the
# program dir. Your DATA dir (~/.local/share/octopus) is LEFT UNTOUCHED so tasks,
# sessions and settings survive a reinstall; the path is printed so you can remove
# it by hand if you truly want a clean slate.

set -eu

PROGRAM_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/octopus-app"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/octopus"
SYMLINK="$HOME/.local/bin/octopus"

# Only remove the symlink if it points into our program dir (don't clobber a
# same-named binary the user put there themselves).
if [ -L "$SYMLINK" ]; then
  TARGET=$(readlink "$SYMLINK")
  case "$TARGET" in
    "$PROGRAM_DIR"/*) rm -f "$SYMLINK"; echo "Removed launcher $SYMLINK" ;;
    *) echo "note: $SYMLINK does not point into $PROGRAM_DIR — left as-is." ;;
  esac
fi

if [ -d "$PROGRAM_DIR" ]; then
  rm -rf "$PROGRAM_DIR"
  echo "Removed program dir $PROGRAM_DIR"
fi

echo
echo "Your data was NOT removed: $DATA_DIR"
echo "Delete it manually if you want a clean slate:  rm -rf \"$DATA_DIR\""
