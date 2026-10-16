#!/usr/bin/env bash
# Claude בטלפון: הסרה (לינוקס).
#   uninstall.sh              שואל אם למחוק גם הגדרות ונתונים
#   uninstall.sh --keep-data  משאיר את agent/data ו-agent/config.json
#   uninstall.sh --all        מוחק הכל בלי לשאול
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
MODE="${1:-ask}"
"$DIR/stop.sh" >/dev/null 2>&1 || true
if command -v systemctl >/dev/null; then
  systemctl --user disable claudephone.service >/dev/null 2>&1 || true
  rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/claudephone.service"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/claudephone.desktop" "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/claudephone.desktop"
DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
rm -f "$DESK/claudephone.desktop"

DEL=0
case "$MODE" in
  --all) DEL=1 ;;
  --keep-data) DEL=0 ;;
  *) read -r -p "למחוק גם את ההגדרות והנתונים (טוקן ימות, קוד הכניסה, היסטוריית המשימות וההקלטות)? [y/N] " a; case "$a" in y|Y|כ|כן) DEL=1 ;; esac ;;
esac
if [ "$DEL" = 1 ]; then
  rm -rf "$DIR"
  echo "התוכנה והנתונים הוסרו."
else
  find "$DIR" -mindepth 1 -maxdepth 1 ! -name agent -exec rm -rf {} +
  find "$DIR/agent" -mindepth 1 -maxdepth 1 ! -name data ! -name config.json -exec rm -rf {} +
  echo "התוכנה הוסרה. ההגדרות והנתונים נשארו ב-$DIR/agent"
fi
