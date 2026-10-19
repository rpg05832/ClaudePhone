// שיחות ענן (Claude Code בדפדפן): שליחת הודעה לסשן קיים מהטלפון, בפקודה `claude -p "<הודעה>" --cloud <session-id>`.
// זה חד-כיווני: ההודעה נכנסת לתור של הסשן, והתשובה נראית בו (באתר, באפליקציה או ב-Desktop). דורש התחברות לחשבון claude.ai.
import { execFile } from 'node:child_process';

export interface CloudSession { id: string; name: string }

export class CloudError extends Error {}

/** מזהה סשן מתוך קישור (claude.ai/code/session_...) או מזהה חשוף. null אם לא נראה כמו סשן. */
export function parseSessionId(raw: string): string | null {
  const m = String(raw ?? '').trim().match(/(?:^|\/)((?:session|cse)_[A-Za-z0-9]{10,60})(?:[/?#]|$)/);
  return m ? m[1] : null;
}

export interface CloudOptions {
  sessions: () => { name: string; url?: string; id?: string }[];
  claudeExe: () => string;
  /** מריץ את הפקודה (נדרס בבדיקות). */
  run?: (exe: string, args: string[]) => Promise<{ code: number; out: string }>;
}

function runClaude(exe: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(res => execFile(exe, args, { windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) =>
    res({ code: err ? ((err as any).code ?? 1) : 0, out: `${stdout}\n${stderr}`.trim() })));
}

export class CloudSessions {
  constructor(private o: CloudOptions) {}

  list(): CloudSession[] {
    const out: CloudSession[] = [];
    for (const s of this.o.sessions()) {
      const id = parseSessionId(s.id ?? s.url ?? '');
      const name = String(s.name ?? '').trim();
      if (id && name && !out.some(x => x.id === id)) out.push({ id, name });
    }
    return out;
  }

  async send(id: string, message: string): Promise<void> {
    const text = message.trim();
    if (!text) throw new CloudError('ההודעה ריקה');
    if (!this.list().some(s => s.id === id)) throw new CloudError('השיחה לא ברשימה');
    const r = await (this.o.run ?? runClaude)(this.o.claudeExe(), ['-p', text, '--cloud', id]);
    if (r.code !== 0) {
      if (/archived/i.test(r.out)) throw new CloudError('השיחה בארכיון ואינה מקבלת הודעות');
      if (/not found/i.test(r.out)) throw new CloudError('השיחה לא נמצאה בחשבון');
      if (/auth|login|claude\.ai/i.test(r.out)) throw new CloudError('Claude לא מחובר לחשבון. יש להריץ claude auth login במחשב');
      throw new CloudError('השליחה לשיחת הענן נכשלה');
    }
  }
}
