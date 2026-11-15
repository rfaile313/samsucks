#!/usr/bin/env bash
# Build, sign, install and launch the app on the TV configured in .env.
#   ./scripts/deploy.sh               release build
#   ./scripts/deploy.sh --dev         dev build: perf overlay, logs + remote control via tools/devserver.mjs
#   ./scripts/deploy.sh --build-only  just produce build/app (no TV needed)
#   ./scripts/deploy.sh --no-run      install but don't launch
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/.env" ] || { echo "No .env yet. Run ./scripts/setup.sh first." >&2; exit 1; }
set -a; source "$ROOT/.env"; set +a

DEV=0; RUN=1; INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=1 ;;
    --no-run) RUN=0 ;;
    --build-only) INSTALL=0 ;;
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
  # A classic script that runs before the modules: it reports errors the module-based
  # logger never sees, such as a module that fails to load or parse.
  if [ -n "${DEV_HOST:-}" ]; then
    HOOK="<script>(function(){var u='http://${DEV_HOST}/log';function send(l,m){try{var x=new XMLHttpRequest();x.open('POST',u,true);x.send(JSON.stringify([{t:Date.now(),level:l,msg:m}]));}catch(e){}}window.addEventListener('error',function(e){var t=e.target||{};send('error','early: '+(e.message||'failed to load '+(t.tagName||'?')+' '+(t.src||t.href||'?'))+(e.filename?' @ '+e.filename+':'+e.lineno:''));},true);send('log','html loaded '+location.href+' '+navigator.userAgent);})();</script>"
    HOOK="$HOOK" perl -pi -e 's|<meta charset="utf-8">|$&$ENV{HOOK}|' "$OUT/index.html"
  fi
else
  rm -rf "$OUT/js/dev"
  sed -i.bak "s/^export const VERSION = .*/export const VERSION = '$VERSION';/" "$OUT/js/config.js" && rm "$OUT/js/config.js.bak"
fi
# Chromium 69 (Tizen 5.5, the 2020 TVs) refuses to load ES modules from the app's
# file:// origin, so with esbuild available (setup.sh fetches it) the modules are
# bundled into one classic script. Otherwise the modules are shipped as they are,
# preloaded up front so the TV fetches them in parallel instead of discovering
# the import graph one level at a time.
ESBUILD="${ESBUILD:-$ROOT/build/esbuild}"; [ -x "$ESBUILD" ] || ESBUILD="$(command -v esbuild || true)"
if [ -n "$ESBUILD" ]; then
  EXTERNAL=""; [ "$DEV" = 1 ] || EXTERNAL="--external:./dev/remote.js"
  "$ESBUILD" "$OUT/js/main.js" --bundle --format=iife --target=chrome69 $EXTERNAL --log-level=warning --outfile="$OUT/js/bundle.js"
  find "$OUT/js" -name '*.js' ! -name bundle.js -delete && find "$OUT/js" -type d -empty -delete
  sed -i.bak 's|<script type="module" src="js/main.js"></script>|<script src="js/bundle.js"></script>|' "$OUT/index.html" && rm "$OUT/index.html.bak"
  KIND=bundled
else
  PRELOADS=$(cd "$OUT" && find js -name '*.js' | sort | sed 's|.*|<link rel="modulepreload" href="&">|' | tr '\n' ' ')
  sed -i.bak "s|</head>|$PRELOADS</head>|" "$OUT/index.html" && rm "$OUT/index.html.bak"
  KIND=modules
fi
echo "built $([ "$DEV" = 1 ] && echo dev || echo release) $VERSION ($KIND) → build/app"
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
if [ "$KIND" = modules ]; then
  PLATFORM=$("$SDB" -s "$TARGET" capability 2>/dev/null | sed -n 's/^platform_version://p')
  case "$PLATFORM" in 2.*|3.*|4.*|5.*)
    echo "Tizen $PLATFORM can't load ES modules from the app's file:// origin. Run ./scripts/setup.sh to fetch esbuild, then deploy again." >&2; exit 1 ;;
  esac
fi

"$TIZEN" install -n "$WGT" -t "$DEVICE" | grep -E 'install completed|Installed|error|fail' || true
if [ "$RUN" = 1 ]; then "$TIZEN" run -p "$APP_ID" -t "$DEVICE" | tail -1; fi
