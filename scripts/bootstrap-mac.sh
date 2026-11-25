#!/bin/sh
# Bootstrap a macOS dev checkout: install node_modules + native modules + Electron through the
# corporate Artifactory instead of the air-gapped Linux mirror that .npmrc / package-lock.json
# point at. macOS only. Safe to re-run (skips the install when node_modules is already complete;
# pass --force to reinstall).
#
# Why it is needed (none of this changes the Linux setup):
#   - The lockfile's `resolved` URLs and .npmrc point at rt-isp.israel.final, which a Mac on the
#     corporate network cannot reach. npm's `replace-registry-host=always` rewrites only the HOST
#     of each lockfile URL (the /artifactory/api/npm/npm-remote/ path is kept), so the registry
#     is set to the bare mirror host. package-lock.json is not modified (verified at the end).
#   - TLS is intercepted by the corporate proxy, and .npmrc's cafile
#     (/etc/ssl/certs/ca-certificates.crt) does not exist on macOS: a CA bundle is exported
#     from the macOS keychains (+ any existing $NODE_EXTRA_CA_CERTS) for npm and Node.
#   - postinstall (scripts/rebuild-natives.mjs) and electron's install.js fetch Node headers,
#     the better-sqlite3 prebuild and the Electron zip; their mirrors are redirected via env.
#
# Usage:  scripts/bootstrap-mac.sh [--force]
# Env:    OCTOPUS_MAC_ARTIFACTORY  mirror base (default https://artifactory.final.co.il/artifactory)

set -eu

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h | --help)
      sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg (usage: $0 [--force])" >&2
      exit 2
      ;;
  esac
done

if [ "$(uname -s)" != Darwin ]; then
  echo "error: bootstrap-mac.sh is for macOS only; on Linux just run \`npm ci\` (see README)." >&2
  exit 1
fi

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT"

# --- Node 20.x ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found on PATH. Install Node 20: brew install node@20" >&2
  echo "       then: export PATH=\"$(brew --prefix 2>/dev/null || echo /opt/homebrew)/opt/node@20/bin:\$PATH\"" >&2
  exit 1
fi
NODE_VERSION=$(node -v)
case "$NODE_VERSION" in
  v20.*) : ;;
  *)
    echo "error: Node 20.x required (electron-vite 3.1 / Electron 33 pins, see CLAUDE.md); found $NODE_VERSION." >&2
    echo "       brew install node@20 && export PATH=\"$(brew --prefix 2>/dev/null || echo /opt/homebrew)/opt/node@20/bin:\$PATH\"" >&2
    exit 1
    ;;
esac
echo "Node $NODE_VERSION ($(command -v node))"

# --- CA bundle from the macOS keychains --------------------------------------
CACHE_DIR="$HOME/Library/Caches/octopus-dev"
BUNDLE="$CACHE_DIR/ca-bundle.pem"
mkdir -p "$CACHE_DIR"
TMP_BUNDLE="$BUNDLE.tmp.$$"
security find-certificate -a -p \
  /Library/Keychains/System.keychain \
  /System/Library/Keychains/SystemRootCertificates.keychain >"$TMP_BUNDLE"
# Keep whatever extra CAs the user already trusts (e.g. a company bundle), unless it is ours.
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ "$NODE_EXTRA_CA_CERTS" != "$BUNDLE" ] &&
  [ -f "$NODE_EXTRA_CA_CERTS" ]; then
  cat "$NODE_EXTRA_CA_CERTS" >>"$TMP_BUNDLE"
fi
mv "$TMP_BUNDLE" "$BUNDLE"
echo "CA bundle: $BUNDLE ($(grep -c 'BEGIN CERTIFICATE' "$BUNDLE") certs)"

# --- mirror overrides ----------------------------------------------------------
ART="${OCTOPUS_MAC_ARTIFACTORY:-https://artifactory.final.co.il/artifactory}"
ART="${ART%/}"
# scheme://host/ only: replace-registry-host keeps each lockfile URL's path.
REGISTRY_HOST=$(printf '%s\n' "$ART" | sed -E 's#^(https?://[^/]+).*#\1/#')

export NODE_EXTRA_CA_CERTS="$BUNDLE"
export npm_config_cafile="$BUNDLE"
export npm_config_registry="$REGISTRY_HOST"
export npm_config_replace_registry_host=always
export npm_config_disturl="$ART/nodejs-clients-remote"
# Electron's zip: .npmrc's `electron_mirror` reaches electron's install.js as
# npm_config_electron_mirror, which @electron/get reads FIRST. npm re-exports it from .npmrc even
# if the same variable is set in the env (env names normalize to the different key
# `electron-mirror`); only a command-line `--electron_mirror=` outranks it, so npm ci gets that.
export ELECTRON_MIRROR="$ART/github-remote/electron/electron/releases/download/"
export OCTOPUS_NODE_DISTURL="$ART/nodejs-clients-remote"
export OCTOPUS_BSQ3_BINARY_HOST="$ART/github-remote/WiseLibs/better-sqlite3/releases/download"
# better-sqlite3's own install script (prebuild-install, before our postinstall replaces its
# binary with the Electron one) would otherwise try github.com.
export npm_config_better_sqlite3_binary_host_mirror="$OCTOPUS_BSQ3_BINARY_HOST"

# --- install -------------------------------------------------------------------
installed() {
  [ -f node_modules/.package-lock.json ] &&
    [ ! package-lock.json -nt node_modules/.package-lock.json ] &&
    [ -f node_modules/node-pty/build/Release/pty.node ] &&
    [ -x node_modules/node-pty/build/Release/spawn-helper ] &&
    [ -f node_modules/better-sqlite3/build/Release/better_sqlite3.node ] &&
    [ -x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ]
}

if [ "$FORCE" = 0 ] && installed; then
  echo "node_modules is complete (natives + Electron.app present); skipping npm ci (--force to redo)."
else
  echo "Running npm ci via $REGISTRY_HOST ..."
  npm ci --electron_mirror="$ELECTRON_MIRROR"
  if ! installed; then
    echo "error: npm ci finished but native modules or Electron.app are missing." >&2
    exit 1
  fi
fi

if ! git diff --quiet -- package-lock.json; then
  echo "error: package-lock.json changed during install — the mac overrides must not rewrite it." >&2
  echo "       Inspect with \`git diff package-lock.json\`, then \`git checkout package-lock.json\`." >&2
  exit 1
fi

cat <<EOF

Bootstrap complete. \`npm run dev\`, \`npm run build\`, \`npm test\` and \`npm run build:unpack:mac\`
need no network and no extra env. Only re-fetching natives (\`npm run rebuild:natives\`) or a
manual npm install needs the overrides; re-run this script instead, or export these (and pass
--electron_mirror="\$ELECTRON_MIRROR" to npm install / npm ci):

  export NODE_EXTRA_CA_CERTS="$BUNDLE"
  export npm_config_cafile="$BUNDLE"
  export npm_config_registry="$REGISTRY_HOST"
  export npm_config_replace_registry_host=always
  export npm_config_disturl="$npm_config_disturl"
  export ELECTRON_MIRROR="$ELECTRON_MIRROR"
  export OCTOPUS_NODE_DISTURL="$OCTOPUS_NODE_DISTURL"
  export OCTOPUS_BSQ3_BINARY_HOST="$OCTOPUS_BSQ3_BINARY_HOST"
EOF
