// גישה ל-API של הסוכן + עדכון חי (SSE). כל שינוי במאגר מגיע כאירוע "change", וכל רכיב מושך מחדש.
import { useEffect, useState, useCallback, useSyncExternalStore } from 'react';

let version = 0;
const listeners = new Set<() => void>();
let connected = false;

function startEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('change', () => { version++; listeners.forEach(l => l()); });
  es.onopen = () => { connected = true; listeners.forEach(l => l()); };
  es.onerror = () => { connected = false; listeners.forEach(l => l()); };
}
startEvents();

function subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); }
export function useLiveVersion(): number { return useSyncExternalStore(subscribe, () => version); }
export function useLiveConnected(): boolean { return useSyncExternalStore(subscribe, () => connected); }

export interface ApiState<T> { data: T | null; error: string | null; loading: boolean; reload: () => void; }

export function useApi<T>(path: string | null): ApiState<T> {
  const v = useLiveVersion();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN(x => x + 1), []);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    fetch('/api' + path, { credentials: 'same-origin' })
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `שגיאה ${r.status}`);
        return body as T;
      })
      .then(d => { if (alive) { setData(d); setError(null); setLoading(false); } })
      .catch(e => { if (alive) { setError(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, [path, v, n]);
  return { data, error, loading, reload };
}

// ---------- טיפוסים (מראה של מה שהסוכן מחזיר) ----------

export type TaskState = 'draft' | 'awaiting_transcript' | 'queued' | 'running' | 'awaiting_permission' | 'awaiting_answer'
  | 'stop_requested' | 'done' | 'failed' | 'cancelled' | 'needs_review';

export interface Task {
  id: string; num: number; projectId: string; projectName?: string | null; conversationId: string | null; state: TaskState;
  source: string; prompt: string; resultText: string | null; resultSummary: string | null; error: string | null;
  heard: boolean; model?: string | null; createdAt: string; updatedAt: string; hasRecording?: boolean;
}

export interface Conversation {
  id: string; projectId: string | null; projectName: string | null; title: string;
  source: 'phone' | 'desktop' | 'cli' | 'vscode' | 'sdk' | 'cowork' | 'unknown'; createdAt: string | null; lastActiveAt: string;
  coworkProject?: string | null; archived?: boolean;
  active: boolean; canContinue: boolean; blockedReason: string | null; inHistory: boolean;
}

export interface HistoryMessage { role: 'user' | 'assistant' | 'tool'; at: string | null; text: string; tool?: { name: string; input: string } }

export interface PermissionRequest {
  id: string; taskId: string; taskNum?: number | null; projectName?: string | null; toolName: string; summary: string;
  input: any; createdAt: string; expiresAt: string; decision: string | null; decidedAt: string | null; decidedVia: string | null; explanation: string | null;
}

export interface Project {
  id: string; name: string; spokenName: string; path: string; phoneEnabled: boolean;
  permissions: { editInsideProject: boolean; runCommands: boolean }; createdAt: string; conversations: number; lastActiveAt: string | null;
}

export interface Overview {
  mode?: 'setup' | 'running';
  health: Record<string, any>;
  settings: { editMode: 'readonly' | 'edit' | 'auto'; voice: string; rate: number; notify: 'on' | 'off'; model: string; effort: string };
  update?: UpdateState | null;
  counts: { pending: number; active: number; unheard: number };
}

export interface UpdateState {
  enabled: boolean; disabledReason: string | null; repo: string; current: string | null; latest: string | null; available: boolean;
  notes: string | null; publishedAt: string | null; pageUrl: string | null; checkedAt: string | null; error: string | null;
  phase: 'idle' | 'checking' | 'downloading' | 'installing' | 'failed'; progress: number | null; auto: boolean;
}

export interface ProjectsLocationInfo {
  parent: string; exists: boolean;
  inside: { id: string; name: string; path: string }[];
  suggestions: { path: string; label: string; exists: boolean; current: boolean }[];
}

export interface PhoneLogEntry { callId: string; phone: string; at: string; kind: string; detail: string | null }

/** פעולה מהלוח (שלב 4): POST עם כותרת ההגנה. זורק שגיאה עם ההודעה מהסוכן. */
export async function act<T = any>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch('/api' + path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-cp': '1' }, body: JSON.stringify(body),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `שגיאה ${r.status}`);
  return b as T;
}
