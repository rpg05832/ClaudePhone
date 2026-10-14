# -*- coding: utf-8 -*-
# תהליך תמלול קבוע: טוען את מודל ivrit-ai פעם אחת ומתמלל קבצים לפי בקשה.
# פרוטוקול: שורת JSON בקלט {"id": "...", "path": "..."} -> שורת JSON בפלט {"id": "...", "text": "...", "seconds": n}
# או {"id": "...", "error": "..."}. שורה ראשונה בפלט: {"ready": true, "load_seconds": n}.
import sys, io, json, time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')

model_name = sys.argv[1] if len(sys.argv) > 1 else 'ivrit-ai/whisper-large-v3-turbo-ct2'

def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()

try:
    t0 = time.time()
    from faster_whisper import WhisperModel
    model = WhisperModel(model_name, device='cpu', compute_type='int8')
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
