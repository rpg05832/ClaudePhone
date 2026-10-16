// מציג Markdown של Claude כמו באפליקציה: כותרות, רשימות, קוד, טבלאות, הדגשות וקישורים.
// בלי ספרייה חיצונית ובלי innerHTML: הכל נבנה כרכיבי React, ולכן טקסט מהמודל לא יכול להזריק HTML.
import { Fragment, type ReactNode } from 'react';

type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; start: number; items: string[] }
  | { t: 'quote'; text: string }
  | { t: 'hr' }
  | { t: 'table'; head: string[]; rows: string[][] };

/** פירוק לבלוקים. שורה ריקה מפרידה פסקאות; פריטי רשימה רצופים מצטרפים לרשימה אחת. */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  const para: string[] = [];
  const flush = () => { if (para.length) { out.push({ t: 'p', text: para.join('\n') }); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      flush();
      const buf: string[] = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push({ t: 'code', lang: fence[1] ?? '', text: buf.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { flush(); out.push({ t: 'h', level: h[1].length, text: h[2] }); i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push({ t: 'hr' }); i++; continue; }
    if (/^\s{0,3}\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s{0,3}\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(line); i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s{0,3}\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push({ t: 'table', head, rows });
      continue;
    }
    const ul = line.match(/^\s{0,3}[-*+]\s+(.*)$/);
    if (ul) {
      flush();
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s{0,3}[-*+]\s+(.*)$/);
        if (m) { items.push(m[1]); i++; }
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += '\n' + lines[i].trim(); i++; }   // המשך פריט
        else break;
      }
      out.push({ t: 'ul', items });
      continue;
    }
    const ol = line.match(/^\s{0,3}(\d+)[.)]\s+(.*)$/);
    if (ol) {
      flush();
      const items: string[] = []; const start = Number(ol[1]);
      while (i < lines.length) {
        const m = lines[i].match(/^\s{0,3}\d+[.)]\s+(.*)$/);
        if (m) { items.push(m[1]); i++; }
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += '\n' + lines[i].trim(); i++; }
        else break;
      }
      out.push({ t: 'ol', start, items });
      continue;
    }
    const q = line.match(/^\s{0,3}>\s?(.*)$/);
    if (q) {
      flush();
      const buf: string[] = [];
      while (i < lines.length) { const m = lines[i].match(/^\s{0,3}>\s?(.*)$/); if (!m) break; buf.push(m[1]); i++; }
      out.push({ t: 'quote', text: buf.join('\n') });
      continue;
    }
    para.push(line); i++;
  }
  flush();
  return out;
}

/** טקסט בתוך שורה: קוד, מודגש, נטוי, קישורים, שבירות שורה. */
export function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>)]+)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  const push = (s: string) => {
    const parts = s.split('\n');
    parts.forEach((p, idx) => { if (idx) nodes.push(<br key={`br${k++}`} />); if (p) nodes.push(p); });
  };
  while ((m = re.exec(text))) {
    if (m.index > last) push(text.slice(last, m.index));
    const key = `i${k++}`;
    if (m[1]) nodes.push(<code key={key} dir="ltr">{m[1].slice(1, -1)}</code>);
    else if (m[2] || m[3]) nodes.push(<strong key={key}>{inline(m[0].slice(2, -2))}</strong>);
    else if (m[4] || m[5]) nodes.push(<em key={key}>{inline(m[0].slice(1, -1))}</em>);
    else if (m[6]) nodes.push(<s key={key}>{inline(m[0].slice(2, -2))}</s>);
    else if (m[7]) nodes.push(<a key={key} href={m[9]} target="_blank" rel="noreferrer noopener">{m[8]}</a>);
    else if (m[10]) nodes.push(<a key={key} href={m[10]} target="_blank" rel="noreferrer noopener" dir="ltr">{m[10]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) push(text.slice(last));
  return nodes;
}

export default function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h': { const Tag = (`h${Math.min(b.level + 2, 6)}` as 'h3'); return <Tag key={i}>{inline(b.text)}</Tag>; }
          case 'p': return <p key={i}>{inline(b.text)}</p>;
          case 'code': return <pre key={i} dir="ltr" data-lang={b.lang || undefined}><code>{b.text}</code></pre>;
          case 'ul': return <ul key={i}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>;
          case 'ol': return <ol key={i} start={b.start}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ol>;
          case 'quote': return <blockquote key={i}>{inline(b.text)}</blockquote>;
          case 'hr': return <hr key={i} />;
          case 'table': return (
            <div key={i} className="table-wrap"><table>
              <thead><tr>{b.head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
              <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, x) => <td key={x}>{inline(c)}</td>)}</tr>)}</tbody>
            </table></div>
          );
          default: return <Fragment key={i} />;
        }
      })}
    </div>
  );
}
