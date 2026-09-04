#!/bin/sh
# SQLite backup helper. Runs inside the `backup` sidecar (alpine + sqlite3), as uid 1000.
#
#   sh /backup.sh loop              daily at $BACKUP_HOUR_UTC (default 03:00 UTC), plus once at start
#   sh /backup.sh once              back up every $DATA_DIR/*.sqlite now and prune
#   sh /backup.sh snapshot <path>   consistent copy of the main database to <path> (used by ops `sql`)
#
# Uses the sqlite3 `.backup` API, which is safe against a live WAL database.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
BACKUP_DIR="${BACKUP_DIR:-$DATA_DIR/backups}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
BACKUP_HOUR_UTC="${BACKUP_HOUR_UTC:-3}"

log() { echo "$(date -u +%FT%TZ) $*"; }

main_db() {
  # Prefer surf.sqlite; otherwise the first *.sqlite in DATA_DIR.
  if [ -f "$DATA_DIR/surf.sqlite" ]; then echo "$DATA_DIR/surf.sqlite"; return; fi
  for f in "$DATA_DIR"/*.sqlite; do [ -f "$f" ] && { echo "$f"; return; }; done
  return 1
}

snapshot() {
  src="$1"; dest="$2"
  mkdir -p "$(dirname "$dest")"
  rm -f "$dest.tmp"
  sqlite3 "$src" ".backup '$dest.tmp'"
  mv -f "$dest.tmp" "$dest"
}

backup_once() {
  mkdir -p "$BACKUP_DIR"
  stamp="$(date -u +%F)"
  found=0
  for db in "$DATA_DIR"/*.sqlite; do
    [ -f "$db" ] || continue
    found=1
    name="$(basename "$db" .sqlite)"
    dest="$BACKUP_DIR/$name-$stamp.sqlite"
    if snapshot "$db" "$dest"; then
      log "backup ok: $dest ($(du -h "$dest" | cut -f1))"
    else
      log "backup FAILED: $db"
    fi
  done
  [ "$found" = 1 ] || log "no *.sqlite in $DATA_DIR yet"
  # Prune dated backups older than RETAIN_DAYS (never touches adhoc-*.sqlite older than a day either way).
  find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.sqlite' -mtime +"$RETAIN_DAYS" -print -delete 2>/dev/null |
    while read -r f; do log "pruned: $f"; done
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'adhoc-*.sqlite*' -mmin +60 -delete 2>/dev/null || true
}

seconds_until_next_run() {
  now="$(date -u +%s)"
  target=$(( now - now % 86400 + BACKUP_HOUR_UTC * 3600 ))
  [ "$target" -le "$now" ] && target=$(( target + 86400 ))
  echo $(( target - now ))
}

case "${1:-loop}" in
  once)
    backup_once
    ;;
  snapshot)
    [ -n "${2:-}" ] || { echo "usage: backup.sh snapshot <dest>" >&2; exit 2; }
    src="$(main_db)" || { log "no database found in $DATA_DIR"; exit 1; }
    snapshot "$src" "$2"
    log "snapshot of $src -> $2"
    ;;
  loop)
    log "backup sidecar started (retain ${RETAIN_DAYS}d, daily at ${BACKUP_HOUR_UTC}:00 UTC)"
    backup_once || log "initial backup failed"
    while :; do
      s="$(seconds_until_next_run)"
      log "next backup in ${s}s"
      sleep "$s"
      backup_once || log "backup run failed"
    done
    ;;
  *)
    echo "usage: backup.sh loop|once|snapshot <dest>" >&2
    exit 2
    ;;
esac
