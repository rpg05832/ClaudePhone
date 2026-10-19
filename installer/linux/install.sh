#!/usr/bin/env bash
# Claude בטלפון: התקנה ועדכון בלינוקס (כל ההפצות, x64 ו-arm64, מחשב עם מסך או שרת).
#
# התקנה ראשונה (בלי sudo):
#   curl -fsSL https://github.com/shmuel-sinay/ClaudePhone/releases/latest/download/install.sh | bash
# עדכון: התוכנה מריצה את הסקריפט הזה בעצמה (--from-file), או שמריצים שוב את אותה פקודה.
#
# מתקין לתיקייה ~/.local/share/claudephone (או CLAUDEPHONE_DIR), רושם שירות systemd של המשתמש שמפעיל את הסוכן
# עם הפעלת המחשב, ופותח את אשף ההגדרה. ההגדרות והנתונים (agent/data, agent/config.json) נשמרים בעדכון.
set -euo pipefail
USER="${USER:-$(id -un)}"

REPO="${CLAUDEPHONE_REPO:-shmuel-sinay/ClaudePhone}"
APP_DIR="${CLAUDEPHONE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/claudephone}"
SERVICE=claudephone
FROM_FILE=""
VERSION=""
QUIET=0
NO_START=0
LOG=""

usage() {
  cat <<'EOF'
Claude בטלפון: התקנה ועדכון בלינוקס

שימוש: install.sh [אפשרויות]
  --from-file FILE   התקנה מקובץ ClaudePhone-linux-<arch>-<version>.tar.gz שכבר הורד
  --version X.Y.Z    גרסה מסוימת (ברירת מחדל: האחרונה)
  --repo OWNER/NAME  מאגר ה-Releases (ברירת מחדל: rpg05832/ClaudePhone)
  --dir PATH         תיקיית ההתקנה (ברירת מחדל: ~/.local/share/claudephone)
  --no-start         לא להפעיל את הסוכן בסוף
  --quiet            בלי פתיחת דפדפן ובלי הודעות (עדכון מתוך התוכנה)
  --log FILE         כתיבת הפלט גם לקובץ
  --help             העזרה הזו
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from-file) FROM_FILE="$2"; shift 2 ;;
    --version) VERSION="${2#v}"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --dir) APP_DIR="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    --quiet) QUIET=1; shift ;;
    --log) LOG="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "אפשרות לא מוכרת: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -n "$LOG" ]; then mkdir -p "$(dirname "$LOG")"; exec > >(tee -a "$LOG") 2>&1; fi
say() { [ "$QUIET" = 1 ] || echo "== $*"; }
die() { echo "שגיאה: $*" >&2; exit 1; }

# ---------- בדיקות ----------
[ "$(uname -s)" = "Linux" ] || die "הסקריפט הזה מיועד ללינוקס. ב-Windows מתקינים את ClaudePhone-Setup.exe"
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "מעבד $(uname -m) לא נתמך (נדרש x64 או arm64)" ;;
esac
if ldd --version 2>&1 | grep -qi musl; then die "הפצה מבוססת musl (כמו Alpine) לא נתמכת. נדרשת הפצה רגילה (Ubuntu, Debian, Fedora וכו')"; fi
if [ "$(id -u)" = 0 ] && [ "$QUIET" != 1 ]; then echo "הערה: ההתקנה רצה כמשתמש root. אם אפשר, עדיף להתקין כמשתמש רגיל (בלי sudo)."; fi
command -v tar >/dev/null || die "חסרה התוכנה tar"

fetch() {  # fetch URL OUT
  if command -v curl >/dev/null; then curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null; then wget -q -O "$2" "$1"
  else die "חסרה התוכנה curl או wget"; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------- הורדה ----------
if [ -z "$FROM_FILE" ]; then
  if [ -n "$VERSION" ]; then API="https://api.github.com/repos/$REPO/releases/tags/v$VERSION"; else API="https://api.github.com/repos/$REPO/releases/latest"; fi
  say "מחפש את הגרסה ב-$REPO"
  fetch "$API" "$TMP/release.json" || die "לא ניתן לקרוא את ה-Releases של $REPO (אין אינטרנט, או שהכתובת חסומה בסינון)"
  URL="$(grep -o '"browser_download_url": *"[^"]*ClaudePhone-linux-'"$ARCH"'-[0-9.]*\.tar\.gz"' "$TMP/release.json" | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
  [ -n "$URL" ] || die "בגרסה הזו אין קובץ התקנה ללינוקס $ARCH"
  NAME="${URL##*/}"
  say "מוריד $NAME"
  fetch "$URL" "$TMP/$NAME" || die "ההורדה נכשלה"
  if fetch "$URL.sha256" "$TMP/$NAME.sha256" 2>/dev/null; then
    WANT="$(grep -oE '[a-fA-F0-9]{64}' "$TMP/$NAME.sha256" | head -1 | tr 'A-F' 'a-f')"
    GOT="$(sha256sum "$TMP/$NAME" | cut -d' ' -f1)"
    [ "$WANT" = "$GOT" ] || die "הקובץ שהורד לא תואם לטביעת האצבע שפורסמה"
  fi
  FROM_FILE="$TMP/$NAME"
fi
[ -f "$FROM_FILE" ] || die "הקובץ לא נמצא: $FROM_FILE"

# ---------- פריסה ובדיקת החבילה ----------
say "פורס"
mkdir -p "$TMP/x"
tar -xzf "$FROM_FILE" -C "$TMP/x" || die "הקובץ פגום"
NEW="$TMP/x/claudephone"
[ -d "$NEW" ] || NEW="$TMP/x"
for f in runtime/node agent/dist/agent.mjs version.txt; do [ -e "$NEW/$f" ] || die "החבילה לא שלמה (חסר $f)"; done
NEWVER="$(tr -d '\r\n ' < "$NEW/version.txt")"

# ---------- עצירת הסוכן הקיים ----------
if [ -x "$APP_DIR/stop.sh" ]; then say "עוצר את הסוכן"; "$APP_DIR/stop.sh" >/dev/null 2>&1 || true; fi

# ---------- החלפת הקבצים (ההגדרות והנתונים נשמרים) ----------
say "מתקין לתיקייה $APP_DIR"
mkdir -p "$APP_DIR/agent"
for item in "$NEW"/* "$NEW"/.[!.]*; do
  [ -e "$item" ] || continue
  b="$(basename "$item")"
  [ "$b" = agent ] && continue
  rm -rf "$APP_DIR/$b"; mv "$item" "$APP_DIR/$b"
done
for item in "$NEW"/agent/* "$NEW"/agent/.[!.]*; do
  [ -e "$item" ] || continue
  b="$(basename "$item")"
  case "$b" in data|config.json) continue ;; esac
  rm -rf "$APP_DIR/agent/$b"; mv "$item" "$APP_DIR/agent/$b"
done
chmod +x "$APP_DIR"/*.sh "$APP_DIR/runtime/node" 2>/dev/null || true
[ -f "$APP_DIR/agent/bin/cloudflared" ] && chmod +x "$APP_DIR/agent/bin/cloudflared"
find "$APP_DIR/agent/node_modules/@anthropic-ai" -maxdepth 2 -name claude -type f -exec chmod +x {} + 2>/dev/null || true

# ---------- שירות systemd של המשתמש ----------
HAVE_SYSTEMD=0
if [ -z "${CLAUDEPHONE_NO_SERVICE:-}" ] && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  HAVE_SYSTEMD=1
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  SAFE_PATH="$(printf '%s' "$PATH" | tr -d '"\\')"
  cat > "$UNIT_DIR/$SERVICE.service" <<EOF
[Unit]
Description=Claude בטלפון (ClaudePhone agent)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/agent
ExecStart="$APP_DIR/runtime/node" --no-warnings --use-system-ca "$APP_DIR/agent/dist/agent.mjs" --no-open
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20
Environment=NODE_ENV=production
Environment=CLAUDEPHONE_SERVICE=1
Environment="PATH=$SAFE_PATH"

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE.service" >/dev/null 2>&1 || true
  # linger: הסוכן עולה עם הפעלת המחשב גם בלי שמישהו מתחבר (חשוב בשרת)
  if ! loginctl enable-linger "$USER" >/dev/null 2>&1; then
    [ "$QUIET" = 1 ] || echo "הערה: כדי שהסוכן יעלה גם בלי להתחבר למחשב, הרץ פעם אחת: sudo loginctl enable-linger $USER"
  fi
fi

if [ "$NO_START" = 1 ]; then say "הותקנה גרסה $NEWVER (לא הופעל)"; exit 0; fi

# ---------- הפעלה ----------
say "מפעיל את הסוכן"
if [ "$HAVE_SYSTEMD" = 1 ]; then
  systemctl --user restart "$SERVICE.service"
else
  (cd "$APP_DIR/agent" && CLAUDEPHONE_SERVICE= exec nohup "$APP_DIR/runtime/node" --no-warnings --use-system-ca "$APP_DIR/agent/dist/agent.mjs" --no-open) </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi

[ "$QUIET" = 1 ] && exit 0

echo
echo "הותקנה גרסה $NEWVER."
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  echo "פותח את אשף ההגדרה בדפדפן…"
  "$APP_DIR/launcher.sh" --open >/dev/null 2>&1 &
  echo "בהמשך: \"Claude בטלפון\" בתפריט היישומים פותח את לוח הבקרה."
else
  # שרת בלי מסך: הלוח מאזין רק למחשב עצמו (127.0.0.1). פותחים אותו ממחשב אחר דרך מנהרת SSH.
  TOKEN_FILE="$APP_DIR/agent/data/dashboard.token"
  for _ in $(seq 1 40); do [ -s "$TOKEN_FILE" ] && break; sleep 0.5; done
  PORT="$("$APP_DIR/runtime/node" -e 'const f=require("fs"),p=require("path"),d=process.argv[1];const r=x=>{try{return JSON.parse(f.readFileSync(p.join(d,x),"utf8").replace(/^\uFEFF/,""))}catch{return {}}};console.log((r("config.json").dashboard||{}).port||(r("config.example.json").dashboard||{}).port||7788)' "$APP_DIR/agent" 2>/dev/null || echo 7788)"
  TOKEN="$(tr -d '\r\n ' < "$TOKEN_FILE" 2>/dev/null || true)"
  HOST="$(hostname -f 2>/dev/null || hostname)"
  echo
  echo "זה מחשב בלי מסך. לפתיחת אשף ההגדרה ממחשב אחר:"
  echo "  1. במחשב שלך הרץ:   ssh -N -L $PORT:127.0.0.1:$PORT $USER@$HOST"
  echo "  2. פתח בדפדפן:      http://127.0.0.1:$PORT/?t=$TOKEN#/setup"
  echo
  echo "הכתובת הזו מופיעה גם בפקודה: $APP_DIR/launcher.sh --open"
fi
