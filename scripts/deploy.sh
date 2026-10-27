#!/usr/bin/env bash
# Build, sign, install and launch the app on the TV configured in .env.
#   ./scripts/deploy.sh               release build
#   ./scripts/deploy.sh --dev         dev build: perf overlay, logs + remote control via tools/devserver.mjs
#   ./scripts/deploy.sh --build-only  just produce build/app (no TV needed)
#   ./scripts/deploy.sh --no-run      install but don't launch
#   ./scripts/deploy.sh --bundle      one classic script instead of ES modules (needed on Tizen 6.0)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/.env" ] || { echo "No .env yet. Run ./scripts/setup.sh first." >&2; exit 1; }
set -a; source "$ROOT/.env"; set +a

DEV=0; RUN=1; INSTALL=1; BUNDLE=0
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=1 ;;
    --no-run) RUN=0 ;;
    --build-only) INSTALL=0 ;;
    --bundle) BUNDLE=1 ;;
  esac
done

# --- build: the app is plain JS modules, so building is a copy ---------------
OUT="$ROOT/build/app"
rm -rf "$OUT" && mkdir -p "$ROOT/build"
cp -R "$ROOT/app" "$OUT"
VERSION=$(sed -n 's/.*widget.* version="\([^"]*\)".*/\1/p' "$ROOT/app/config.xml")
if [ "$DEV" = 1 ]; then
  PLEX_URL=""; [ "${DEV_SKIP_LOGIN:-0}" = 1 ] && PLEX_URL="${PLEX_SERVER_URL:-}"
  cat > "$OUT/js/config.js" <<EOF
export const DEV = true;
export const DEV_HOST = '${DEV_HOST:-}';
export const DEV_PLEX_URL = '$PLEX_URL';
export const VERSION = '$VERSION';
EOF
  # A classic script that runs before any module, so import/link failures (which
  # happen before util/log.js exists) still reach the devserver.
  cat > "$OUT/dev-early.js" <<EOF
(function () {
  function send(msg) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', 'http://${DEV_HOST:-}/log');
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(JSON.stringify([{ t: Date.now(), level: 'error', msg: '[early] ' + msg }]));
    } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) send('failed to load ' + (t.src || t.href));
    else send((e.message || 'error') + ' ' + (e.filename || '') + ':' + (e.lineno || '') + ' ' + ((e.error && e.error.stack) || ''));
  }, true);
  window.addEventListener('unhandledrejection', function (e) { send('unhandled rejection ' + ((e.reason && e.reason.stack) || e.reason)); });
  send('page loaded ' + navigator.userAgent);
})();
EOF
  sed -i.bak 's|<link rel="stylesheet"|<script src="dev-early.js"></script><link rel="stylesheet"|' "$OUT/index.html" && rm "$OUT/index.html.bak"
else
  rm -rf "$OUT/js/dev"
  sed -i.bak "s/^export const VERSION = .*/export const VERSION = '$VERSION';/" "$OUT/js/config.js" && rm "$OUT/js/config.js.bak"
fi
if [ "$BUNDLE" = 1 ]; then
  # Tizen 6.0 (Chromium 76) won't load module scripts from file://, so ship one
  # classic script instead.
  # Release builds have no js/dev/; its import is behind `if (DEV)`, so leave it unresolved.
  EXTERNAL=""; [ "$DEV" = 1 ] || EXTERNAL="--external:./dev/remote.js"
  npx --yes esbuild@0.24.0 "$OUT/js/main.js" --bundle --format=iife --target=chrome76 \
    $EXTERNAL --log-level=warning --outfile="$OUT/bundle.js"
  rm -rf "$OUT/js"
  sed -i.bak 's|<script type="module" src="js/main.js"></script>|<script src="bundle.js"></script>|' "$OUT/index.html" && rm "$OUT/index.html.bak"
else
  # Preload every module up front so the TV fetches them in parallel instead of
  # discovering the import graph one level at a time.
  PRELOADS=$(cd "$OUT" && find js -name '*.js' | sort | sed 's|.*|<link rel="modulepreload" href="&">|' | tr '\n' ' ')
  sed -i.bak "s|</head>|$PRELOADS</head>|" "$OUT/index.html" && rm "$OUT/index.html.bak"
fi
echo "built $([ "$DEV" = 1 ] && echo dev || echo release) $VERSION → build/app"
[ "$INSTALL" = 1 ] || exit 0

# --- package, sign, install, launch -------------------------------------------
TIZEN_STUDIO="${TIZEN_STUDIO:-$HOME/tizen-studio}"
SDB="$TIZEN_STUDIO/tools/sdb"
TIZEN="$TIZEN_STUDIO/tools/ide/bin/tizen"
TARGET="$TV_IP:${TV_SDB_PORT:-26101}"
APP_ID=$(sed -n 's/.*tizen:application id="\([^"]*\)".*/\1/p' "$ROOT/app/config.xml")

rm -f "$ROOT"/build/*.wgt
"$TIZEN" package -t wgt -s "${TIZEN_SIGN_PROFILE:-samsucks}" -o "$ROOT/build" -- "$OUT" >/dev/null
# The package is named after the app ("SamSUCKS - Better Plex.wgt"); the installer chokes on spaces.
WGT="$ROOT/build/samsucks.wgt"
mv "$(ls "$ROOT"/build/*.wgt | head -1)" "$WGT"

"$SDB" connect "$TARGET" >/dev/null
DEVICE=$("$SDB" devices | awk -v t="$TARGET" '$1 == t { print $3 }')
[ -n "$DEVICE" ] || { echo "Can't reach the TV at $TARGET. Is it on, with Developer Mode pointing at this computer?" >&2; exit 1; }

"$TIZEN" install -n "$WGT" -t "$DEVICE" | grep -E 'install completed|Installed|error|fail' || true
if [ "$RUN" = 1 ]; then "$TIZEN" run -p "$APP_ID" -t "$DEVICE" | tail -1; fi
