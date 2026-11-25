#!/bin/sh
# Install Octopus on macOS for the current user. Run from inside the extracted release
# directory (octopus-<version>/), i.e. after `tar xzf Octopus-<version>-darwin-<arch>.tar.gz`.
# The Linux installer is install.sh; this is its macOS counterpart and mirrors its layout rules.
#
# What it does:
#   - copies Octopus.app to ~/Applications/Octopus.app (atomic replace),
#   - clears the bundle's extended attributes, incl. com.apple.quarantine (the app is ad-hoc
#     signed, not notarized, so Gatekeeper would otherwise refuse a downloaded copy), and
#     verifies its signature before replacing the live install,
#   - symlinks ~/.local/bin/octopus-cli to Octopus.app/Contents/Resources/octopus-cli, and
#   - copies the Claude Code skill to ~/.claude/skills/octopus (replace-in-place).
#
# It deliberately does NOT touch your DATA dir (~/.local/share/octopus): tasks, sessions and
# settings survive install, upgrade and uninstall. No root required. The in-app updater runs this
# script non-interactively (no TTY) from a staged copy of a newer release, then relaunches
# ~/Applications/Octopus.app. Keep its flags, exit codes and layout stable, as for install.sh.
#
# The replace is atomic, as in install.sh: the app is staged into "Octopus.app.new", the live
# bundle is renamed to ".old", ".new" is renamed into place and ".old" is deleted. A failure
# before the swap leaves the live install untouched. Runs non-interactively (no prompts).
#
# Override the destination folder with OCTOPUS_APPS_DIR (default: ~/Applications).

set -eu

# --- resolve locations --------------------------------------------------------
SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PAYLOAD="$SRC_DIR/Octopus.app"
SKILL_SRC="$SRC_DIR/claude-skill/octopus"

APPS_DIR="${OCTOPUS_APPS_DIR:-$HOME/Applications}"
APP_DIR="$APPS_DIR/Octopus.app"
BIN_DIR="$HOME/.local/bin"
# octopus-cli lives inside the bundle's Resources (Contents/MacOS may only hold Mach-O files).
CLI_LAUNCHER="$APP_DIR/Contents/Resources/octopus-cli"
CLI_SYMLINK="$BIN_DIR/octopus-cli"
SKILL_DEST="$HOME/.claude/skills/octopus"

if [ "$(uname -s)" != Darwin ]; then
  echo "error: install-mac.sh is for macOS; on Linux run ./install.sh." >&2
  exit 1
fi

if [ ! -x "$PAYLOAD/Contents/MacOS/Octopus" ]; then
  echo "error: $PAYLOAD not found — run this script from inside the extracted release dir." >&2
  exit 1
fi

if [ ! -x "$PAYLOAD/Contents/Resources/octopus-cli" ] || [ ! -f "$SKILL_SRC/SKILL.md" ]; then
  echo "error: octopus-cli or claude-skill/octopus missing in $SRC_DIR — incomplete release dir." >&2
  exit 1
fi

# --- install (atomic replace) -------------------------------------------------
echo "Installing Octopus to $APP_DIR ..."
NEW_DIR="$APP_DIR.new"
OLD_DIR="$APP_DIR.old"

STAGING=1
cleanup() {
  if [ "$STAGING" = 1 ]; then
    rm -rf "$NEW_DIR"
    # Interrupted between the two swap renames: put the previous install back.
    if [ ! -e "$APP_DIR" ] && [ -e "$OLD_DIR" ]; then
      mv "$OLD_DIR" "$APP_DIR" || true
    fi
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# Stale leftovers from an earlier interrupted run (see install.sh).
if [ ! -e "$APP_DIR" ] && [ -e "$OLD_DIR" ]; then
  mv "$OLD_DIR" "$APP_DIR" || true
fi
rm -rf "$NEW_DIR" "$OLD_DIR"

mkdir -p "$APPS_DIR"
# ditto preserves the bundle's symlinks, modes and code signature.
ditto "$PAYLOAD" "$NEW_DIR"
# Clear every extended attribute: com.apple.quarantine (a quarantined, non-notarized app is
# blocked by Gatekeeper as "damaged") and the FinderInfo / fileprovider attributes a synced
# folder (Egnyte) adds, which make the bundle fail its signature check. Best-effort.
xattr -cr "$NEW_DIR" 2>/dev/null || true

if [ ! -x "$NEW_DIR/Contents/MacOS/Octopus" ]; then
  echo "error: staged copy is missing $NEW_DIR/Contents/MacOS/Octopus; install aborted, existing install untouched." >&2
  exit 1
fi

# A bundle damaged in transit (e.g. a sync that dropped the framework symlinks) must never
# replace a working install.
if ! codesign --verify --deep --strict "$NEW_DIR" 2>&1; then
  echo "error: $NEW_DIR fails its signature check (incomplete or damaged copy); install aborted, existing install untouched." >&2
  exit 1
fi

# Swap. Both renames are within the same parent dir, so they are atomic.
if [ -e "$APP_DIR" ]; then
  mv "$APP_DIR" "$OLD_DIR"
fi
if ! mv "$NEW_DIR" "$APP_DIR"; then
  echo "error: could not move the new install into place; restoring the previous install." >&2
  if [ -e "$OLD_DIR" ]; then
    mv "$OLD_DIR" "$APP_DIR" || echo "error: restore failed; previous install is at $OLD_DIR." >&2
  fi
  exit 1
fi
STAGING=0
# The new app is live. Everything below is best-effort: warn, never fail the install.
rm -rf "$OLD_DIR" || echo "warning: could not remove $OLD_DIR" >&2

echo "Installed $APP_DIR"

# --- link the CLI onto PATH ---------------------------------------------------
if { mkdir -p "$BIN_DIR" && ln -sf "$CLI_LAUNCHER" "$CLI_SYMLINK"; }; then
  echo "CLI symlinked at $CLI_SYMLINK -> $CLI_LAUNCHER"
else
  echo "warning: could not link $CLI_SYMLINK" >&2
fi

# --- Claude Code skill (replace in place) -------------------------------------
install_skill() {
  rm -rf "$SKILL_DEST" && mkdir -p "$SKILL_DEST" && cp -R "$SKILL_SRC/." "$SKILL_DEST/"
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

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *)
    echo
    echo "note: $BIN_DIR is not on your PATH. Add this to your shell profile:"
    echo "    export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo
echo "Done. Run: open \"$APP_DIR\""
