#!/usr/bin/env bash
# Build, sign, install and launch the app on the TV configured in .env.
#   ./scripts/deploy.sh               release build
#   ./scripts/deploy.sh --dev         dev build: perf overlay, logs + remote control via tools/devserver.mjs
#   ./scripts/deploy.sh --build-only  just produce build/app (no TV needed)
#   ./scripts/deploy.sh --no-run      install but don't launch
#   ./scripts/deploy.sh --target=tizen4  build for Tizen 4.0 TVs (2018, Chromium 56); combine with any flag above
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/.env" ] || { echo "No .env yet. Run ./scripts/setup.sh first." >&2; exit 1; }
set -a; source "$ROOT/.env"; set +a

DEV=0; RUN=1; INSTALL=1; BUILD_TARGET=""
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=1 ;;
    --no-run) RUN=0 ;;
    --build-only) INSTALL=0 ;;
    --target=*) BUILD_TARGET="${arg#--target=}" ;;
  esac
done
case "$BUILD_TARGET" in
  "" | tizen4) ;;
  *) echo "Unknown target: $BUILD_TARGET (supported: tizen4)" >&2; exit 1 ;;
esac

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
  # The tizen4 bundle needs js/dev: Chromium 56 cannot parse the import() in app.js
  # unless esbuild resolves it. It never runs, because app.js loads it only when DEV is true.
  [ "$BUILD_TARGET" = tizen4 ] || rm -rf "$OUT/js/dev"
  sed -i.bak "s/^export const VERSION = .*/export const VERSION = '$VERSION';/" "$OUT/js/config.js" && rm "$OUT/js/config.js.bak"
fi
if [ "$BUILD_TARGET" = tizen4 ]; then
  # Tizen 4.0 TVs run Chromium 56, which has no ES modules: bundle to one classic
  # script, lower newer syntax, and relax the minimum platform version.
  command -v esbuild >/dev/null || { echo "esbuild not found. Install it: brew install esbuild, or npm install -g esbuild" >&2; exit 1; }
  esbuild "$OUT/js/main.js" --bundle --format=iife --target=chrome56 --log-level=warning --outfile="$OUT/bundle.js"
  rm -rf "$OUT/js" && mkdir "$OUT/js" && mv "$OUT/bundle.js" "$OUT/js/main.js"
  sed -i.bak 's| type="module"||' "$OUT/index.html" && rm "$OUT/index.html.bak"
  sed -i.bak 's/required_version="[^"]*"/required_version="4.0"/' "$OUT/config.xml" && rm "$OUT/config.xml.bak"
else
  # Preload every module up front so the TV fetches them in parallel instead of
  # discovering the import graph one level at a time.
  PRELOADS=$(cd "$OUT" && find js -name '*.js' | sort | sed 's|.*|<link rel="modulepreload" href="&">|' | tr '\n' ' ')
  sed -i.bak "s|</head>|$PRELOADS</head>|" "$OUT/index.html" && rm "$OUT/index.html.bak"
fi
echo "built $([ "$DEV" = 1 ] && echo dev || echo release)${BUILD_TARGET:+ ($BUILD_TARGET)} $VERSION → build/app"
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
