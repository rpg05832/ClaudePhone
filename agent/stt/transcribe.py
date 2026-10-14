# -*- coding: utf-8 -*-
# תהליך תמלול קבוע: טוען את מודל ivrit-ai פעם אחת ומתמלל קבצים לפי בקשה.
# פרוטוקול: שורת JSON בקלט {"id": "...", "path": "..."} -> שורת JSON בפלט {"id": "...", "text": "...", "seconds": n}
# או {"id": "...", "error": "..."}. שורה ראשונה בפלט: {"ready": true, "load_seconds": n}.
import sys, io, json, time, os

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')

model_name = sys.argv[1] if len(sys.argv) > 1 else 'ivrit-ai/whisper-large-v3-turbo-ct2'

def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()

def local_model_dir(name):
    """המודל מהמטמון של Hugging Face, בתיקייה עם קבצים רגילים.

    במטמון, הקבצים של המודל הם קישורים סמליים (symlinks). כשהתוכנה מופעלת על ידי קובץ ההתקנה (Inno Setup),
    Windows חוסם מעבר בקישורים כאלה (הגנת RedirectionGuard שעוברת לתהליכי הבן), והטעינה נכשלת ב-"Unable to open file".
    לכן יוצרים תיקייה משלנו עם קישורים קשיחים (hardlinks) לאותם קבצים: בלי מקום נוסף בדיסק, ובלי קישורים סמליים.
    בלי מודל במטמון (או לא ב-Windows) מחזירים את השם, ו-faster-whisper מוריד אותו כרגיל.
    """
    if os.path.isdir(name):
        return name
    try:
        from huggingface_hub import snapshot_download
        snap = snapshot_download(name, local_files_only=True)
    except Exception:  # noqa: BLE001
        return name
    if os.name != 'nt':
        return snap
    base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
    dest = os.path.join(base, 'ClaudePhone', 'models', name.replace('/', '--'), os.path.basename(snap))
    os.makedirs(dest, exist_ok=True)
    for f in os.listdir(snap):
        src = os.path.join(snap, f)
        target = os.path.join(dest, f)
        if os.path.exists(target) and os.path.getsize(target) > 0:
            continue
        real = src
        if os.path.islink(src):
            link = os.readlink(src)            # קריאת היעד בלי לעבור דרך הקישור
            if link.startswith('\\\\?\\'):
                link = link[4:]
            real = os.path.normpath(link if os.path.isabs(link) else os.path.join(snap, link))
        try:
            if os.path.exists(target):
                os.remove(target)
            os.link(real, target)
        except OSError:
            import shutil
            shutil.copyfile(real, target)
    return dest

try:
    t0 = time.time()
    from faster_whisper import WhisperModel
    model = WhisperModel(local_model_dir(model_name), device='cpu', compute_type='int8')
    emit({'ready': True, 'load_seconds': round(time.time() - t0, 1)})
except Exception as e:  # noqa: BLE001
    emit({'ready': False, 'error': f'{type(e).__name__}: {e}'})
    sys.exit(1)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req_id = None
    try:
        req = json.loads(line)
        req_id = req.get('id')
        t1 = time.time()
        segments, info = model.transcribe(req['path'], language='he', beam_size=5, vad_filter=True)
        text = ' '.join(s.text.strip() for s in segments).strip()
        emit({'id': req_id, 'text': text, 'seconds': round(time.time() - t1, 1), 'duration': round(info.duration, 1)})
    except Exception as e:  # noqa: BLE001
        emit({'id': req_id, 'error': f'{type(e).__name__}: {e}'})
