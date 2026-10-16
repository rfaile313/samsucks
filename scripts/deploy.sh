#!/usr/bin/env bash
# Build, sign, install and launch the app on the TV configured in .env.
#   ./scripts/deploy.sh               release build
#   ./scripts/deploy.sh --dev         dev build: perf overlay, logs + remote control via tools/devserver.mjs
#   ./scripts/deploy.sh --build-only  just produce build/app (no TV needed)
#   ./scripts/deploy.sh --no-run      install but don't launch
#   ./scripts/deploy.sh --bundle      bundle into one classic script (automatic for TVs older than Tizen 6.5)
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

# --- connect first, so the build can match the TV's Tizen version --------------
TIZEN_STUDIO="${TIZEN_STUDIO:-$HOME/tizen-studio}"
SDB="$TIZEN_STUDIO/tools/sdb"
TIZEN="$TIZEN_STUDIO/tools/ide/bin/tizen"
TARGET="$TV_IP:${TV_SDB_PORT:-26101}"
if [ "$INSTALL" = 1 ]; then
  "$SDB" connect "$TARGET" >/dev/null
  DEVICE=$("$SDB" devices | awk -v t="$TARGET" '$1 == t { print $3 }')
  [ -n "$DEVICE" ] || { echo "Can't reach the TV at $TARGET. Is it on, with Developer Mode pointing at this computer?" >&2; exit 1; }
  # Tizen 6.0 and older refuse to load ES modules from the app's file:// origin.
  PLATFORM=$("$SDB" -s "$TARGET" capability | sed -n 's/^platform_version://p' | tr -d '\r')
  if awk -v v="$PLATFORM" 'BEGIN { exit !(v != "" && v + 0 < 6.5) }'; then BUNDLE=1; fi
fi

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
else
  rm -rf "$OUT/js/dev"
  sed -i.bak "s/^export const VERSION = .*/export const VERSION = '$VERSION';/" "$OUT/js/config.js" && rm "$OUT/js/config.js.bak"
fi
if [ "$BUNDLE" = 1 ]; then
  # Older TVs: one classic script, compiled down to Tizen 6.0's Chromium 76.
  # Release builds drop js/dev/, so leave its (never-taken) dynamic import alone.
  command -v npx >/dev/null || { echo "Bundling for this TV needs Node.js (npx). Install it and run this again." >&2; exit 1; }
  npx --yes esbuild@0.24 "$OUT/js/main.js" --bundle --format=iife --target=chrome76 \
    --log-level=warning --outfile="$OUT/bundle.js" $([ "$DEV" = 1 ] || echo "--external:./dev/*")
  rm -rf "$OUT/js"
  sed -i.bak 's|<script type="module" src="js/main.js"></script>|<script src="bundle.js"></script>|' "$OUT/index.html" && rm "$OUT/index.html.bak"
else
  # Preload every module up front so the TV fetches them in parallel instead of
  # discovering the import graph one level at a time.
  PRELOADS=$(cd "$OUT" && find js -name '*.js' | sort | sed 's|.*|<link rel="modulepreload" href="&">|' | tr '\n' ' ')
  sed -i.bak "s|</head>|$PRELOADS</head>|" "$OUT/index.html" && rm "$OUT/index.html.bak"
fi
echo "built $([ "$DEV" = 1 ] && echo dev || echo release)$([ "$BUNDLE" = 1 ] && echo ", bundled") $VERSION → build/app"
[ "$INSTALL" = 1 ] || exit 0

# --- package, sign, install, launch -------------------------------------------
APP_ID=$(sed -n 's/.*tizen:application id="\([^"]*\)".*/\1/p' "$ROOT/app/config.xml")

rm -f "$ROOT"/build/*.wgt
"$TIZEN" package -t wgt -s "${TIZEN_SIGN_PROFILE:-samsucks}" -o "$ROOT/build" -- "$OUT" >/dev/null
# The package is named after the app ("SamSUCKS - Better Plex.wgt"); the installer chokes on spaces.
WGT="$ROOT/build/samsucks.wgt"
mv "$(ls "$ROOT"/build/*.wgt | head -1)" "$WGT"

"$TIZEN" install -n "$WGT" -t "$DEVICE" | grep -E 'install completed|Installed|error|fail' || true
if [ "$RUN" = 1 ]; then "$TIZEN" run -p "$APP_ID" -t "$DEVICE" | tail -1; fi
