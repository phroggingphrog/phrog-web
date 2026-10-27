#!/usr/bin/env bash
# Portable install / release / rollback for the phrog-web user service.
# Usage: scripts/phrog-web-service.sh <status|render|install|release|rollback> [--no-restart]
# release/rollback refuse to run unless the unit's WorkingDirectory is APP_DIR (use `install` first).
# Env overrides: APP_DIR (default: repo root of this script), NODE (default: `command -v node`),
#   UNIT_NAME (phrog-web.service), HEALTH_URL (http://127.0.0.1:8890/health), HEALTH_TIMEOUT (30s)
# Never runs `pnpm install`; node_modules must already exist in APP_DIR.
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE="${NODE:-$(command -v node || true)}"
UNIT_NAME="${UNIT_NAME:-phrog-web.service}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8890/health}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-30}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TEMPLATE="$APP_DIR/deploy/units/phrog-web.service"
# Same filesystem as dist/ (atomic mv) and already git-ignored.
REL_DIR="$APP_DIR/node_modules/.cache/phrog-web-release"
NO_RESTART=0

die() { echo "error: $*" >&2; exit 1; }
sc() { systemctl --user "$@"; }

cmd="${1:-status}"; [ $# -gt 0 ] && shift
for a in "$@"; do
  case "$a" in
    --no-restart) NO_RESTART=1 ;;
    *) die "unknown argument '$a' (only --no-restart is accepted)" ;;
  esac
done

# Refuse to mutate APP_DIR/dist unless the unit actually runs from APP_DIR.
require_unit_target() {
  local wd want got
  wd="$(sc show "$UNIT_NAME" -p WorkingDirectory --value 2>/dev/null || true)"
  [ -n "$wd" ] || die "$UNIT_NAME has no WorkingDirectory (not installed? run 'install')"
  want="$(realpath -e "$APP_DIR")" || die "APP_DIR $APP_DIR does not exist"
  got="$(realpath -e "$wd" 2>/dev/null)" || die "unit WorkingDirectory $wd does not exist"
  [ "$want" = "$got" ] || die "$UNIT_NAME runs from $got but APP_DIR is $want; run 'install' from the intended checkout first (or set APP_DIR)"
}

main_pid() { sc show "$UNIT_NAME" -p MainPID --value 2>/dev/null || echo 0; }

render() {
  [ -n "$NODE" ] || die "node not found; set NODE=/path/to/node"
  sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@NODE@|$NODE|g" "$TEMPLATE"
}

# Healthy = unit active, a NEW main PID (not the pre-restart process), and expected health JSON.
health() {
  local old_pid="$1" i body pid
  for ((i = 0; i < HEALTH_TIMEOUT; i++)); do
    pid="$(main_pid)"
    if [ "$(sc show "$UNIT_NAME" -p ActiveState --value 2>/dev/null)" = active ] \
      && [ "${pid:-0}" != 0 ] && [ "$pid" != "$old_pid" ] \
      && body="$(curl -fsS -m 3 "$HEALTH_URL" 2>/dev/null)" \
      && grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$body" \
      && grep -Eq '"service"[[:space:]]*:[[:space:]]*"phrog-web"' <<<"$body"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# NB: called from `if`/`&&`, where set -e is disabled, so every step must `|| return 1`.
restart_and_check() {
  [ "$NO_RESTART" = 1 ] && { echo "skipping restart (--no-restart)"; return 0; }
  local old_pid
  old_pid="$(main_pid)"
  sc restart "$UNIT_NAME" || return 1
  health "$old_pid"
}

swap_back() { # dist <-> previous
  [ -d "$REL_DIR/dist.prev" ] || die "no previous build at $REL_DIR/dist.prev"
  rm -rf "$REL_DIR/dist.swap"
  mv "$APP_DIR/dist" "$REL_DIR/dist.swap"
  mv "$REL_DIR/dist.prev" "$APP_DIR/dist"
  mv "$REL_DIR/dist.swap" "$REL_DIR/dist.prev"
}

case "$cmd" in
  status)
    echo "app_dir=$APP_DIR node=$NODE unit=$UNIT_NAME"
    sc show "$UNIT_NAME" -p ActiveState,SubState,NRestarts,WorkingDirectory,MainPID --no-pager || true
    [ -f "$REL_DIR/rev.prev" ] && echo "previous_rev=$(cat "$REL_DIR/rev.prev")"
    [ -d "$REL_DIR/dist.prev" ] && echo "rollback_available=yes" || echo "rollback_available=no"
    curl -fsS -m 3 "$HEALTH_URL" && echo || echo "health: DOWN"
    ;;
  render)
    render
    ;;
  install)
    [ -f "$TEMPLATE" ] || die "missing $TEMPLATE"
    mkdir -p "$UNIT_DIR" "$REL_DIR"
    tmp="$(mktemp)"; render >"$tmp"
    if [ -f "$UNIT_DIR/$UNIT_NAME" ] && ! cmp -s "$tmp" "$UNIT_DIR/$UNIT_NAME"; then
      cp "$UNIT_DIR/$UNIT_NAME" "$REL_DIR/$UNIT_NAME.bak"
      echo "existing unit differs; backed up to $REL_DIR/$UNIT_NAME.bak"
    fi
    install -m 0644 "$tmp" "$UNIT_DIR/$UNIT_NAME"; rm -f "$tmp"
    sc daemon-reload
    sc enable "$UNIT_NAME"
    echo "installed $UNIT_DIR/$UNIT_NAME (enabled; NOT restarted — use 'release' or systemctl --user restart)"
    ;;
  release)
    cd "$APP_DIR"
    require_unit_target
    [ -d node_modules ] || die "node_modules missing (install deps first; this script will not)"
    [ -x node_modules/.bin/tsc ] || die "node_modules/.bin/tsc missing"
    mkdir -p "$REL_DIR"
    rm -rf "$REL_DIR/dist.next"
    node_modules/.bin/tsc --outDir "$REL_DIR/dist.next"
    "$NODE" --check "$REL_DIR/dist.next/index.js"
    rev="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    if [ -d dist ]; then
      rm -rf "$REL_DIR/dist.prev"
      mv dist "$REL_DIR/dist.prev"
      { cat "$REL_DIR/rev.cur" 2>/dev/null || echo unknown; } >"$REL_DIR/rev.prev"
    else
      rm -rf "$REL_DIR/dist.prev" "$REL_DIR/rev.prev"   # no current build: nothing valid to roll back to
    fi
    mv "$REL_DIR/dist.next" dist
    echo "$rev" >"$REL_DIR/rev.cur"
    if restart_and_check; then
      echo "release $rev OK"
    else
      echo "health check FAILED after release $rev; rolling back" >&2
      if [ -d "$REL_DIR/dist.prev" ]; then
        swap_back
        restart_and_check && echo "rolled back to previous build (healthy)" || echo "rollback ALSO unhealthy; inspect: journalctl --user -u $UNIT_NAME" >&2
      fi
      exit 1
    fi
    ;;
  rollback)
    require_unit_target
    swap_back
    [ -f "$REL_DIR/rev.prev" ] && cp "$REL_DIR/rev.prev" "$REL_DIR/rev.cur"
    restart_and_check && echo "rollback OK" || die "unhealthy after rollback; journalctl --user -u $UNIT_NAME"
    ;;
  *) die "unknown command '$cmd' (status|render|install|release|rollback)" ;;
esac
