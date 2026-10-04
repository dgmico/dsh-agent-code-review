#!/usr/bin/env bash
# code-review agent preset — install / uninstall / status / verify.
#
# Writes one `insert` patch entry (the fragment preset-code-review.yml) into a
# DSH profile's user patch layer, so the profile composes the `code-review`
# agent preset. Re-running is idempotent: the block between the two sentinel
# comments is replaced wholesale, everything else in the file is preserved.
#
#   ./install.sh                 install into $DSH_HOME/profiles/$DSH_PROFILE (default: web)
#   ./install.sh uninstall       remove the block (backup first)
#   ./install.sh status          report whether the block is present
#   ./install.sh verify          validate the fragment and the installed profile
#   DSH_PROFILE=tui ./install.sh install
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRAGMENT="$ROOT/preset-code-review.yml"
SKILLS_DIR="$ROOT/skills"
PROFILE="${DSH_PROFILE:-web}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
TARGET="$DSH_HOME_DIR/profiles/$PROFILE/cordis.patch.yml"
BEGIN="# >>> code-review-agent"
END="# <<< code-review-agent"
STAMP="$(date +%Y%m%d-%H%M%S)"

info() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

render_fragment() { sed "s|__SKILLS_DIR__|$SKILLS_DIR|g" "$FRAGMENT"; }

strip_block() {
  awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1} skip!=1{print} $0==e{skip=0}'
}

backup_target() {
  [ -f "$TARGET" ] || return 0
  mkdir -p "$ROOT/backup"
  local copy="$ROOT/backup/$PROFILE-cordis.patch.yml.$STAMP"
  cp "$TARGET" "$TARGET.bak.$STAMP"
  cp "$TARGET" "$copy"
  info "backup: $TARGET.bak.$STAMP"
  info "backup: $copy"
}

require_target() {
  [ -f "$TARGET" ] || die "profile patch not found: $TARGET (create the profile first, or set DSH_PROFILE)"
}

validate_fragment() {
  command -v node >/dev/null 2>&1 || die "node is required to validate the fragment"
  node "$ROOT/verify.mjs" "$FRAGMENT" || die "fragment validation failed; nothing written"
}

# Rewrite the target atomically: strip any previous block, append the current one.
write_block() {
  local tmp mode
  tmp="$(mktemp "$TARGET.tmp.XXXXXX")"
  trap 'rm -f "$tmp"' RETURN
  mode="$(stat -f '%Lp' "$TARGET" 2>/dev/null || stat -c '%a' "$TARGET")"
  strip_block < "$TARGET" > "$tmp"
  if [ -s "$tmp" ]; then printf '\n' >> "$tmp"; fi
  render_fragment >> "$tmp"
  chmod "$mode" "$tmp"
  mv "$tmp" "$TARGET"
  trap - RETURN
}

cmd_install() {
  require_target
  validate_fragment
  if grep -qF "$BEGIN" "$TARGET"; then info "replacing the existing code-review block"; fi
  backup_target
  write_block
  info "installed: $TARGET"
  cmd_verify
}

cmd_uninstall() {
  require_target
  if ! grep -qF "$BEGIN" "$TARGET"; then
    info "nothing to do: $TARGET has no code-review block"
    return 0
  fi
  backup_target
  local tmp mode
  tmp="$(mktemp "$TARGET.tmp.XXXXXX")"
  mode="$(stat -f '%Lp' "$TARGET" 2>/dev/null || stat -c '%a' "$TARGET")"
  strip_block < "$TARGET" > "$tmp"
  chmod "$mode" "$tmp"
  mv "$tmp" "$TARGET"
  info "uninstalled: $TARGET (backups kept)"
}

cmd_status() {
  if [ ! -f "$TARGET" ]; then
    info "target missing: $TARGET"
    return 0
  fi
  if grep -qF "$BEGIN" "$TARGET"; then
    info "installed: $TARGET"
  else
    info "not installed: $TARGET"
  fi
}

cmd_verify() {
  validate_fragment
  require_target
  grep -qF "$BEGIN" "$TARGET" || die "the code-review block is not present in $TARGET"
  echo "installed file:"
  node "$ROOT/verify.mjs" "$TARGET" || die "the installed profile patch does not validate"
  local dsh_bin
  dsh_bin="$(command -v dsh || true)"
  if [ -z "$dsh_bin" ]; then
    info "note: dsh is not on PATH; skipped the composed-profile check"
    return 0
  fi
  local dump
  dump="$(DSH_HOME="$DSH_HOME_DIR" "$dsh_bin" --profile "$PROFILE" --dump-config 2>&1)" || {
    case "$dump" in
      *"managed exclusively by the Electron application"*)
        info "note: profile $PROFILE is app-managed, so the CLI cannot compose it."
        info "note: confirm the preset in the app (Settings → Agent presets), then re-run './install.sh verify'."
        return 0
        ;;
      *)
        printf '%s\n' "$dump" >&2
        die "dsh --dump-config failed for profile $PROFILE"
        ;;
    esac
  }
  printf '%s\n' "$dump" | grep -q 'preset-code-review' || die "the composed profile $PROFILE does not contain preset-code-review"
  info "composed profile $PROFILE contains preset-code-review"
}

case "${1:-install}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
  verify) cmd_verify ;;
  *) die "usage: $0 [install|uninstall|status|verify]" ;;
esac
