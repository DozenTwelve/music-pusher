#!/usr/bin/env bash
#
# Preflight check for music-pusher. Verifies that everything the app shells out
# to is installed and reachable BEFORE you try to run it. Safe to run anytime.
#
#   npm run check
#   # or: bash scripts/doctor.sh
#
# Exits non-zero if a hard requirement is missing, so it's also usable in CI.

set -uo pipefail

# Move to repo root (this script lives in <root>/scripts).
cd "$(dirname "$0")/.."

# --- pretty output -----------------------------------------------------------
if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; DIM=''; RESET=''
fi

FAILURES=0
WARNINGS=0

ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; WARNINGS=$((WARNINGS + 1)); }
fail() { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1";  FAILURES=$((FAILURES + 1)); }
hint() { printf '      %s%s%s\n' "$DIM" "$1" "$RESET"; }
head() { printf '\n%s\n' "$1"; }

# --- load .env overrides so we check the SAME binaries the app will use -------
# We only read the bin/path vars; nothing is executed from the file.
BEET_BIN=beet; EXIFTOOL_BIN=exiftool; FFMPEG_BIN=ffmpeg; FFPROBE_BIN=ffprobe
RAW_DIR=""; LIBRARY_DIR=""; PORT=3000
ENV_PRESENT=0
if [ -f .env ]; then
  ENV_PRESENT=1
  # shellcheck disable=SC1091
  while IFS='=' read -r key value; do
    case "$key" in
      BEET_BIN|EXIFTOOL_BIN|FFMPEG_BIN|FFPROBE_BIN|RAW_DIR|LIBRARY_DIR|PORT)
        # strip surrounding quotes and inline whitespace
        value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
        printf -v "$key" '%s' "$value"
        ;;
    esac
  done < <(grep -E '^[A-Z_]+=' .env)
fi

# Expand a leading ~ the way the app's config does.
expand_home() { case "$1" in "~") printf '%s' "$HOME";; "~/"*) printf '%s/%s' "$HOME" "${1#\~/}";; *) printf '%s' "$1";; esac; }

# Resolve a binary: absolute/relative path -> must be executable; bare name -> must be on PATH.
resolve_bin() {
  local val; val="$(expand_home "$1")"
  case "$val" in
    */*) [ -x "$val" ] && printf '%s' "$val" && return 0; return 1 ;;
    *)   command -v "$val" 2>/dev/null && return 0; return 1 ;;
  esac
}

printf '%smusic-pusher doctor%s\n' "$GREEN" "$RESET"
printf '%schecking host prerequisites…%s\n' "$DIM" "$RESET"

# --- Node.js -----------------------------------------------------------------
head "Runtime"
if command -v node >/dev/null 2>&1; then
  NODE_RAW="$(node -v)"                # e.g. v18.19.0
  NODE_MAJOR="${NODE_RAW#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
    ok "Node.js $NODE_RAW"
  else
    fail "Node.js $NODE_RAW — need 18 or newer"
    hint "Install a current Node: https://nodejs.org  (or use nvm)"
  fi
else
  fail "Node.js not found"
  hint "Install Node 18+: https://nodejs.org  (or use nvm)"
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm -v)"
else
  fail "npm not found (comes with Node.js)"
fi

# --- external binaries the app spawns ----------------------------------------
head "External tools (required)"

check_tool() {
  local label="$1" value="$2" apt="$3" brew="$4" resolved
  if resolved="$(resolve_bin "$value")"; then
    ok "$label — $resolved"
  else
    fail "$label not found (looked for: $value)"
    hint "Debian/Ubuntu: $apt"
    hint "macOS:         $brew"
  fi
}

check_tool "ffmpeg"   "$FFMPEG_BIN"   "sudo apt install ffmpeg" "brew install ffmpeg"
check_tool "ffprobe"  "$FFPROBE_BIN"  "sudo apt install ffmpeg (bundled)" "brew install ffmpeg (bundled)"
check_tool "exiftool" "$EXIFTOOL_BIN" "sudo apt install libimage-exiftool-perl" "brew install exiftool"

if BEET_PATH="$(resolve_bin "$BEET_BIN")"; then
  if "$BEET_PATH" version >/dev/null 2>&1; then
    ok "beets — $BEET_PATH ($("$BEET_PATH" version 2>/dev/null | head -1))"
  else
    warn "beets found at $BEET_PATH but 'beet version' failed"
    hint "Check your beets install / Python env."
  fi
else
  fail "beets not found (looked for: $BEET_BIN)"
  hint "Install in a venv, then set BEET_BIN in .env:"
  hint "  python3 -m venv ~/.venvs/beets && ~/.venvs/beets/bin/pip install beets"
fi

# --- process manager (only needed for production) ----------------------------
head "Process manager (production)"
if command -v pm2 >/dev/null 2>&1; then
  ok "pm2 $(pm2 -v 2>/dev/null)"
else
  warn "pm2 not found — needed only to run in production"
  hint "npm install -g pm2   (dev mode via 'npm run dev' works without it)"
fi

# --- configuration -----------------------------------------------------------
head "Configuration"
if [ "$ENV_PRESENT" -eq 1 ]; then
  ok ".env present"
else
  warn ".env not found — using built-in defaults"
  hint "cp .env.example .env   then edit RAW_DIR / LIBRARY_DIR / BEET_BIN"
fi

check_dir() {
  local label="$1" raw="$2" dir
  [ -z "$raw" ] && { warn "$label unset — will fall back to ./data"; return; }
  dir="$(expand_home "$raw")"
  if [ -d "$dir" ]; then
    if [ -w "$dir" ]; then ok "$label $dir (writable)"; else fail "$label $dir exists but is NOT writable"; fi
  else
    warn "$label $dir does not exist yet — it'll be created on first use"
  fi
}
check_dir "RAW_DIR    " "$RAW_DIR"
check_dir "LIBRARY_DIR" "$LIBRARY_DIR"
hint "Reminder: LIBRARY_DIR is only reported by /api/health. The real import"
hint "target is beets' own 'directory:' — keep both, and Navidrome, in sync."

# --- build -------------------------------------------------------------------
head "Client build"
if [ -f client/dist/index.html ]; then
  ok "client built (client/dist present)"
else
  warn "client not built yet"
  hint "npm run build   (required before 'npm start' / pm2 in production)"
fi

# --- summary -----------------------------------------------------------------
head "Summary"
if [ "$FAILURES" -gt 0 ]; then
  printf '%s✗ %d required check(s) failed%s' "$RED" "$FAILURES" "$RESET"
  [ "$WARNINGS" -gt 0 ] && printf ', %d warning(s)' "$WARNINGS"
  printf '\nFix the ✗ items above, then re-run: npm run check\n'
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  printf '%s✓ all required tools present%s, %d warning(s) — review the ! items above.\n' "$GREEN" "$RESET" "$WARNINGS"
  exit 0
else
  printf '%s✓ everything looks good. You are ready to import.%s\n' "$GREEN" "$RESET"
  exit 0
fi
