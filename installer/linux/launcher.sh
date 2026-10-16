#!/usr/bin/env bash
# Claude בטלפון: מפעיל (לינוקס). מקביל ל-launcher.vbs ב-Windows.
#   launcher.sh --open     מפעיל את הסוכן אם הוא כבוי, ופותח את לוח הבקרה (בשרת: מדפיס את הכתובת)
#   launcher.sh --no-open  רק מפעיל את הסוכן
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
NODE="$DIR/runtime/node"
AGENT="$DIR/agent/dist/agent.mjs"
MODE="${1:---open}"

if command -v systemctl >/dev/null && systemctl --user cat claudephone.service >/dev/null 2>&1; then
  systemctl --user start claudephone.service
else
  # בלי systemd: מופע ברקע. אם הסוכן כבר רץ, המופע החדש מזהה את זה ויוצא.
  (cd "$DIR/agent" && exec nohup "$NODE" --no-warnings --use-system-ca "$AGENT" --no-open) </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi

if [ "$MODE" = "--open" ]; then
  cd "$DIR/agent" && exec "$NODE" --no-warnings --use-system-ca "$AGENT" --open-only
fi
