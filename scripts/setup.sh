#!/usr/bin/env bash
# One-time setup: installs Samsung's command-line tools, finds your TV, creates a
# signing certificate and writes .env. Safe to run again; finished steps are skipped.
#   ./scripts/setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$ROOT/.env"
TIZEN_VERSION=6.1

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\n  \033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

get_env() { [ -f "$ENV" ] && sed -n "s/^$1=//p" "$ENV" | tail -1 || true; }
set_env() {
  if grep -q "^$1=" "$ENV"; then KEY="$1" VAL="$2" perl -pi -e 's/^\Q$ENV{KEY}\E=.*/$ENV{KEY}=$ENV{VAL}/' "$ENV"
  else printf '%s=%s\n' "$1" "$2" >> "$ENV"; fi
}

# --- 1. Tizen command-line tools ----------------------------------------------
bold "1/4  Samsung Tizen tools"
case "$(uname -s)" in
  Darwin) INSTALLER="web-cli_Tizen_Studio_${TIZEN_VERSION}_macos-64.bin" ;;
  Linux) INSTALLER="web-cli_Tizen_Studio_${TIZEN_VERSION}_ubuntu-64.bin" ;;
  *) fail "Only macOS and Linux are supported (on Windows, use WSL)." ;;
esac
[ -f "$ENV" ] || cp "$ROOT/.env.example" "$ENV"
TIZEN_STUDIO="$(get_env TIZEN_STUDIO)"; TIZEN_STUDIO="${TIZEN_STUDIO/\$HOME/$HOME}"; TIZEN_STUDIO="${TIZEN_STUDIO:-$HOME/tizen-studio}"
TIZEN="$TIZEN_STUDIO/tools/ide/bin/tizen"
SDB="$TIZEN_STUDIO/tools/sdb"
PM="$TIZEN_STUDIO/package-manager/package-manager-cli.bin"

if [ -x "$TIZEN" ]; then
  ok "already installed in $TIZEN_STUDIO"
else
  echo "  Downloading $INSTALLER (~270 MB)…"
  TMP="$(mktemp -d)"
  curl -fL --progress-bar -o "$TMP/$INSTALLER" "https://download.tizen.org/sdk/Installer/tizen-studio_${TIZEN_VERSION}/$INSTALLER"
  chmod +x "$TMP/$INSTALLER"
  "$TMP/$INSTALLER" --accept-license "$TIZEN_STUDIO" >/dev/null
  rm -rf "$TMP"
  ok "installed in $TIZEN_STUDIO"
fi

PACKAGES="cert-add-on TV-SAMSUNG-Public-WebAppDevelopment TV-SAMSUNG-Extension-Tools Certificate-Manager"
INSTALLED=$("$PM" show-pkgs 2>/dev/null | awk '$1 == "i" { print $2 }')
MISSING=""
for p in $PACKAGES; do echo "$INSTALLED" | grep -qx "$p" || MISSING="$MISSING $p"; done
if [ -n "$MISSING" ]; then
  echo "  Installing Samsung TV extensions (a few minutes)…"
  "$PM" install --accept-license $MISSING >/dev/null
fi
ok "Samsung TV extensions"

# --- 2. Find the TV -------------------------------------------------------------
bold "2/4  Finding your TV"
if [ "$(uname -s)" = Darwin ]; then
  IFACE=$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')
  MY_IP=$(ipconfig getifaddr "${IFACE:-en0}" 2>/dev/null || true)
else
  MY_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
fi
[ -n "$MY_IP" ] || fail "Couldn't work out this computer's IP address. Are you on Wi-Fi or Ethernet?"
ok "this computer is $MY_IP"

tv_info() { curl -s -m 2 "http://$1:8001/api/v2/" 2>/dev/null || true; }
field() { sed -n "s/.*\"$1\" *: *\"\([^\"]*\)\".*/\1/p" <<<"$2" | head -1; }

TV_IP="$(get_env TV_IP)"
INFO=""
[ -n "$TV_IP" ] && INFO=$(tv_info "$TV_IP")
if [ -z "$INFO" ]; then
  echo "  Scanning ${MY_IP%.*}.0/24 for Samsung TVs (make sure the TV is on)…"
  FOUND=()
  TMP="$(mktemp -d)"
  for i in $(seq 1 254); do
    ( r=$(tv_info "${MY_IP%.*}.$i"); grep -q '"type" *: *"Samsung SmartTV"' <<<"$r" && echo "$r" > "$TMP/${MY_IP%.*}.$i" ) &
  done
  wait
  for f in "$TMP"/*; do [ -e "$f" ] && FOUND+=("$(basename "$f")"); done
  [ ${#FOUND[@]} -gt 0 ] || { rm -rf "$TMP"; fail "No Samsung TV found on your network. Is it on, and on the same network as this computer?"; }
  if [ ${#FOUND[@]} -eq 1 ]; then
    TV_IP="${FOUND[0]}"
  else
    echo "  Found ${#FOUND[@]} TVs:"
    for n in "${!FOUND[@]}"; do echo "    $((n + 1))) ${FOUND[$n]}  $(field name "$(cat "$TMP/${FOUND[$n]}")")"; done
    read -rp "  Which one? [1] " PICK
    TV_IP="${FOUND[$(( ${PICK:-1} - 1 ))]}"
  fi
  INFO=$(cat "$TMP/$TV_IP")
  rm -rf "$TMP"
fi
TV_NAME=$(field name "$INFO"); TV_MODEL=$(field modelName "$INFO")
ok "$TV_NAME ($TV_MODEL) at $TV_IP"
set_env TV_IP "$TV_IP"
set_env TV_MODEL "$TV_MODEL"

DEV_MODE=$(field developerMode "$INFO"); DEV_IP=$(field developerIP "$INFO")
if [ "$DEV_MODE" != 1 ] || [ "$DEV_IP" != "$MY_IP" ]; then
  if [ "$DEV_MODE" = 1 ]; then echo "  Developer Mode is on, but it points at $DEV_IP instead of this computer."
  else echo "  Developer Mode is off."; fi
  cat <<EOF

  On the TV:
    1. Press Home and open Apps.
    2. On the Apps screen, type 1 2 3 4 5 on the remote.
       (No number keys? Press the 123 button for the on-screen keypad.
        Nothing happened? Try again a little faster.)
    3. Turn Developer mode On, and enter this computer's IP: $MY_IP
    4. Choose OK, then restart the TV: hold the Power button until it turns off and back on.

  Then run ./scripts/setup.sh again.
EOF
  exit 1
fi
ok "Developer Mode is on and points at this computer"

# --- 3. Signing certificate -----------------------------------------------------
bold "3/4  Signing certificate"
PROFILE="$(get_env TIZEN_SIGN_PROFILE)"; PROFILE="${PROFILE:-samsucks}"
set_env TIZEN_SIGN_PROFILE "$PROFILE"
if "$TIZEN" security-profiles list 2>/dev/null | grep -q "^$PROFILE "; then
  ok "profile '$PROFILE' already exists"
else
  PW="$(get_env TIZEN_CERT_PASSWORD)"
  # Not tr < /dev/urandom | head: tr dies of SIGPIPE, and pipefail turns that into exit 141.
  [ -n "$PW" ] || PW=$(openssl rand -hex 12)
  set_env TIZEN_CERT_PASSWORD "$PW"
  "$TIZEN" certificate -a "$PROFILE" -p "$PW" -f "$PROFILE" >/dev/null
  "$TIZEN" security-profiles add -n "$PROFILE" -a "$HOME/tizen-studio-data/keystore/author/$PROFILE.p12" -p "$PW" >/dev/null
  ok "created profile '$PROFILE' (password saved in .env)"
fi
"$TIZEN" cli-config "profiles.path=$HOME/tizen-studio-data/profile/profiles.xml" >/dev/null

# --- 4. Connect -------------------------------------------------------------------
bold "4/4  Connecting to the TV"
"$SDB" connect "$TV_IP:26101" >/dev/null 2>&1 || true
"$SDB" devices | grep -q "^$TV_IP:26101" || fail "The TV didn't accept the connection. Restart the TV and run this again."
ok "connected"

printf '\n\033[1mAll set.\033[0m Install SamSUCKS on your TV with:\n\n    ./scripts/deploy.sh\n\n'
