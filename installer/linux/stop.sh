#!/usr/bin/env bash
# Claude בטלפון: עצירת הסוכן (לינוקס). מקביל ל-stop.ps1 ב-Windows.
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
if command -v systemctl >/dev/null && systemctl --user cat claudephone.service >/dev/null 2>&1; then
  systemctl --user stop claudephone.service 2>/dev/null || true
fi
# מופע שהופעל בלי systemd: לפי קובץ ה-pid, רק אם זה באמת הסוכן שלנו
PIDF="$DIR/agent/data/agent.pid"
if [ -f "$PIDF" ]; then
  PID="$(tr -dc '0-9' < "$PIDF")"
  if [ -n "$PID" ] && [ -r "/proc/$PID/cmdline" ] && tr '\0' ' ' < "/proc/$PID/cmdline" | grep -q "agent.mjs"; then
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$PID" 2>/dev/null || true
  fi
fi
exit 0
