// mend — a small patch tool. It reads one edit written in any of the four formats
// SPEC.md defines (a unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON edit
// objects) and applies it to the tree of text files rooted at the working directory.
// Either every edit lands or none of them does; what happened, or why not, is printed
// as SPEC.md section 2 prescribes. Node's standard library is all it uses.
//
// The tail of this file is the trial hand-over the kit ships: while MAKEFUN_ENV_URL
// is set, runner.ts drives; otherwise the command line below runs.

import * as fs from 'node:fs';
import * as path from 'node:path';

const FORMAT_NAMES: ReadonlySet<string> = new Set(['auto', 'unified', 'search-replace', 'v4a', 'json']);

/** Ends the whole run at once: exit 2 with this single line (SPEC section 2). */
class Fatal {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: a failure code and the path the failure is about. */
class Miss {
  readonly code: string;
  readonly where: string;
  constructor(code: string, where: string) {
    this.code = code;
    this.where = where;
  }
}

const isBlank = (s: string): boolean => s.trim().length === 0;

/** A patch read as lines (section 3): cut at \n, one trailing \r lifted off each
 *  line, and the empty piece behind a final \n is not a line. */
function patchRows(text: string): string[] {
  if (text.length === 0) return [];
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows.map((r) => (r.endsWith('\r') ? r.slice(0, -1) : r));
}

/** Section 3's safe path: relative, no backslash, no empty, dot or dot-dot segment. */
function pathOk(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

type Apply = (ov: Overlay) => void;

/** The tree as the edits leave it. `base` remembers what each path held on disk;
 *  `staged` holds the outcome of the edits that touched it (null: it is gone). */
class Overlay {
  private disk = new Map<string, string | null>();
  staged = new Map<string, string | null>();

  base(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (fs.statSync(p).isFile()) v = fs.readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p) as string | null;
  }

  current(p: string): string | null {
    return this.staged.has(p) ? (this.staged.get(p) as string | null) : this.base(p);
  }
}

// ---------------------------------------------------------------------------
// Files as rows, and finding rows at the three tiers (sections 3 and 5)
// ---------------------------------------------------------------------------

interface FileRows {
  rows: string[];
  sep: string;
  tail: boolean;
}

/** A file's rows, its own line break, and whether it ends with that break. */
function chop(text: string): FileRows {
  const at = text.indexOf('\n');
  const sep = at > 0 && text.charAt(at - 1) === '\r' ? '\r\n' : '\n';
  if (text === '') return { rows: [], sep, tail: false };
  const rows = text.split(sep);
  const tail = text.endsWith(sep);
  if (tail) rows.pop();
  return { rows, sep, tail };
}

function paste(f: FileRows): string {
  return f.rows.length === 0 ? '' : f.rows.join(f.sep) + (f.tail ? f.sep : '');
}

const cutTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const cutBoth = (s: string): string => cutTrail(s.replace(/^[ \t]+/, ''));
const indentOf = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/** A row as one tier reads it: exact, trailing blanks off, or both ends off. */
function foldRow(s: string, tier: number): string {
  if (tier === 0) return s;
  return tier === 1 ? cutTrail(s) : cutBoth(s);
}

/** Every 0-based start where the needle's rows match at this tier; overlaps count. */
function matchAt(rows: string[], needle: string[], tier: number): number[] {
  const hits: number[] = [];
  if (needle.length === 0 || needle.length > rows.length) return hits;
  const want = needle.map((r) => foldRow(r, tier));
  outer: for (let i = 0; i + needle.length <= rows.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (foldRow(rows[i + j]!, tier) !== want[j]) continue outer;
    }
    hits.push(i);
  }
  return hits;
}

/** The earliest tier with at least one match, and its starts; null when none has. */
function seek(rows: string[], needle: string[], strict: boolean): { tier: number; hits: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const hits = matchAt(rows, needle, tier);
    if (hits.length > 0) return { tier, hits };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hunk and chunk bodies: what replaces what (section 5)
// ---------------------------------------------------------------------------

/** One body line. `bare` is set when a `\` line follows it (no newline at the end). */
interface Piece {
  tag: 'keep' | 'drop' | 'add';
  s: string;
  bare: boolean;
}

/** A body's two sides: the old rows, and the new rows, each new row either shared
 *  with an old row (a context line, with its slot there) or fresh text. */
interface Pair {
  old: string[];
  parts: { s: string; shared: boolean; slot: number }[];
}

function toPair(items: Piece[]): Pair {
  const old: string[] = [];
  const parts: Pair['parts'] = [];
  for (const it of items) {
    if (it.tag === 'keep') {
      parts.push({ s: it.s, shared: true, slot: old.length });
      old.push(it.s);
    } else if (it.tag === 'drop') {
      old.push(it.s);
    } else {
      parts.push({ s: it.s, shared: false, slot: -1 });
    }
  }
  return { old, parts };
}

/** A fresh row re-indented for tier 2 (section 5): the old first row's indent is
 *  swapped for the file's, when the row carries it; blank rows never move. */
function shift(line: string, from: string, to: string): string {
  if (line === '' || line.trim() === '') return line;
  return line.startsWith(to) ? from + line.slice(to.length) : line;
}

/** The new rows as they land over a match at `at`: shared rows are the file's own. */
function render(rows: string[], at: number, pair: Pair, tier: number): string[] {
  const deep = tier === 2 && pair.old.length > 0;
  const f = deep ? indentOf(rows[at]!) : '';
  const p = deep ? indentOf(pair.old[0]!) : '';
  return pair.parts.map((part) => {
    if (part.shared) return rows[at + part.slot]!;
    return deep ? shift(part.s, f, p) : part.s;
  });
}

/** One unified hunk over a file's rows; answers how the row count moved. `head` is
 *  the hunk's A, `drift` what this section's earlier hunks already added or took. */
function runHunk(f: FileRows, pair: Pair, head: number, drift: number, strict: boolean, tailOff: boolean, label: string): number {
  if (pair.old.length === 0) {
    const at = Math.max(0, Math.min(head + drift, f.rows.length));
    const atEnd = at === f.rows.length;
    const added = pair.parts.map((part) => part.s);
    f.rows.splice(at, 0, ...added);
    if (atEnd) f.tail = !tailOff;
    return added.length;
  }
  const found = seek(f.rows, pair.old, strict);
  if (found === null) throw new Miss('no-match', label);
  const want = head - 1 + drift;
  let pick = found.hits[0]!;
  for (const h of found.hits) {
    if (Math.abs(h - want) < Math.abs(pick - want)) pick = h;
  }
  const atEnd = pick + pair.old.length === f.rows.length;
  const repl = render(f.rows, pick, pair, found.tier);
  f.rows.splice(pick, pair.old.length, ...repl);
  if (atEnd) f.tail = !tailOff;
  return pair.parts.length - pair.old.length;
}

/** One V4A chunk over a file's rows; answers the cursor just past what was written. */
function runChunk(f: FileRows, pair: Pair, anchor: string | null, cursor: number, atEof: boolean, strict: boolean, label: string): number {
  let from = cursor;
  if (anchor !== null) {
    let at: number | null = null;
    for (const tier of strict ? [0] : [0, 1, 2]) {
      for (let i = cursor; i < f.rows.length; i++) {
        if (foldRow(f.rows[i]!, tier) === foldRow(anchor, tier)) {
          at = i;
          break;
        }
      }
      if (at !== null) break;
    }
    if (at === null) throw new Miss('no-match', label);
    from = at + 1;
  }
  if (pair.old.length === 0) {
    const at = atEof ? f.rows.length : from;
    const added = pair.parts.map((part) => part.s);
    f.rows.splice(at, 0, ...added);
    return at + added.length;
  }
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const hits = matchAt(f.rows, pair.old, tier).filter((h) => h >= from && (!atEof || h + pair.old.length === f.rows.length));
    if (hits.length > 0) {
      const at = hits[0]!;
      const repl = render(f.rows, at, pair, tier);
      f.rows.splice(at, pair.old.length, ...repl);
      return at + repl.length;
    }
  }
  throw new Miss('no-match', label);
}

// ---------------------------------------------------------------------------
// Telling the four formats apart (section 4)
// ---------------------------------------------------------------------------

function sniff(rows: string[]): string | null {
  const first = rows.findIndex((r) => !isBlank(r));
  if (first < 0) return null;
  if (rows[first]!.trim() === '*** Begin Patch') return 'v4a';
  const ch = rows[first]!.trimStart().charAt(0);
  if (ch === '[' || ch === '{') return 'json';
  if (rows.some((r) => r.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  const uni = rows.some((r, i) => r.startsWith('diff --git ') || (r.startsWith('--- ') && (rows[i + 1] ?? '').startsWith('+++ ')));
  return uni ? 'unified' : null;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

interface HunkRec {
  head: number;
  items: Piece[];
  tailOff: boolean;
}

interface SecRec {
  pairA: string | null | undefined;
  pairB: string | null | undefined;
  renA: string | null | undefined;
  renB: string | null | undefined;
  gitA: string | null | undefined;
  gitB: string | null | undefined;
  make: boolean;
  del: boolean;
  hunks: HunkRec[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path a `--- ` or `+++ ` line names: past the four characters, up to a tab,
 *  trimmed, with the `a/` or `b/` prefix off; /dev/null reads as no file. */
function headPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** A hunk's body, from the line after its header; also where the body stopped. */
function readHunkBody(rows: string[], i: number, head: number): { rec: HunkRec; next: number } {
  const items: Piece[] = [];
  let j = i + 1;
  while (j < rows.length) {
    const r = rows[j]!;
    // Two lines end a body although they start with a body marker: a fresh section.
    if (r.startsWith('diff --git ')) break;
    if (r.startsWith('--- ') && (rows[j + 1] ?? '').startsWith('+++ ')) break;
    if (r.startsWith(' ')) items.push({ tag: 'keep', s: r.slice(1), bare: false });
    else if (r.startsWith('-')) items.push({ tag: 'drop', s: r.slice(1), bare: false });
    else if (r.startsWith('+')) items.push({ tag: 'add', s: r.slice(1), bare: false });
    else if (r.startsWith('\\')) {
      const last = items[items.length - 1];
      if (last) last.bare = true;
    } else if (r === '') items.push({ tag: 'keep', s: '', bare: false });
    else break;
    j++;
  }
  // Empty rows at the end of a body are not part of it.
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.tag === 'keep' && last.s === '') items.pop();
    else break;
  }
  let tailOff = false;
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.tag === 'keep' || it.tag === 'add') {
      tailOff = it.bare;
      break;
    }
  }
  return { rec: { head, items, tailOff }, next: j };
}

function readUnified(rows: string[], strict: boolean, moves: [string, string][]): Apply[] {
  const secs: SecRec[] = [];
  const fresh = (): SecRec => ({
    pairA: undefined,
    pairB: undefined,
    renA: undefined,
    renB: undefined,
    gitA: undefined,
    gitB: undefined,
    make: false,
    del: false,
    hunks: [],
  });
  let sec: SecRec | null = null;
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    if (r.startsWith('diff --git ')) {
      const m = GIT_RE.exec(r);
      if (m === null) throw new Fatal(`error: parse ${i + 1}`);
      sec = fresh();
      sec.gitA = m[1]!;
      sec.gitB = m[2]!;
      secs.push(sec);
      i++;
      continue;
    }
    if (r.startsWith('@@')) {
      if (sec === null) throw new Fatal(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(r);
      if (m === null) throw new Fatal(`error: parse ${i + 1}`);
      const { rec, next } = readHunkBody(rows, i, Number(m[1]));
      sec.hunks.push(rec);
      i = next;
      continue;
    }
    if (r.startsWith('--- ')) {
      const nxt = rows[i + 1];
      if (sec !== null && sec.hunks.length === 0) {
        // In a section's header the pair names the paths; without its `+++ ` line
        // the line after this one is the fault.
        if (nxt === undefined || !nxt.startsWith('+++ ')) throw new Fatal(`error: parse ${i + 2}`);
        sec.pairA = headPath(r);
        sec.pairB = headPath(nxt);
        i += 2;
        continue;
      }
      if (nxt !== undefined && nxt.startsWith('+++ ')) {
        sec = fresh();
        sec.pairA = headPath(r);
        sec.pairB = headPath(nxt);
        secs.push(sec);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (r.startsWith('+++ ')) {
        sec.pairB = headPath(r);
        i++;
        continue;
      }
      if (r.startsWith('rename from ')) {
        sec.renA = r.slice(12).trim();
        i++;
        continue;
      }
      if (r.startsWith('rename to ')) {
        sec.renB = r.slice(10).trim();
        i++;
        continue;
      }
      if (r.startsWith('new file mode')) {
        sec.make = true;
        i++;
        continue;
      }
      if (r.startsWith('deleted file mode')) {
        sec.del = true;
        i++;
        continue;
      }
    }
    i++;
  }
  return secs.map((s) => secApply(s, strict, moves));
}

/** The first of the names that is actually there; a header's /dev/null and a name
 *  never given both read as absent, as the section rules resolve them. */
function firstNamed(...vals: (string | null | undefined)[]): string | null {
  for (const v of vals) {
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

function secApply(sec: SecRec, strict: boolean, moves: [string, string][]): Apply {
  const oldP = firstNamed(sec.pairA, sec.renA, sec.gitA);
  const newP = firstNamed(sec.pairB, sec.renB, sec.gitB);
  const make = sec.make || oldP === null;
  const del = !make && (sec.del || newP === null);
  if (make) {
    const np = newP as string;
    return (ov) => {
      if (!pathOk(np)) throw new Miss('unsafe', np);
      if (ov.current(np) !== null) throw new Miss('exists', np);
      const plus: string[] = [];
      let bare = false;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.tag === 'add') {
            plus.push(it.s);
            bare = it.bare;
          }
        }
      }
      ov.staged.set(np, plus.length === 0 ? '' : plus.join('\n') + (bare ? '' : '\n'));
    };
  }
  if (del) {
    const op = oldP as string;
    return (ov) => {
      if (!pathOk(op)) throw new Miss('unsafe', op);
      if (ov.current(op) === null) throw new Miss('missing', op);
      ov.staged.set(op, null);
    };
  }
  if (oldP !== newP) {
    const op = oldP as string;
    const np = newP as string;
    return (ov) => {
      if (!pathOk(op)) throw new Miss('unsafe', op);
      if (!pathOk(np)) throw new Miss('unsafe', np);
      const before = ov.current(op);
      if (before === null) throw new Miss('missing', op);
      if (ov.current(np) !== null) throw new Miss('exists', np);
      const f = chop(before);
      let drift = 0;
      for (const h of sec.hunks) drift += runHunk(f, toPair(h.items), h.head, drift, strict, h.tailOff, op);
      ov.staged.set(np, paste(f));
      ov.staged.set(op, null);
      moves.push([op, np]);
    };
  }
  const op = oldP as string;
  return (ov) => {
    if (!pathOk(op)) throw new Miss('unsafe', op);
    const before = ov.current(op);
    if (before === null) throw new Miss('missing', op);
    const f = chop(before);
    let drift = 0;
    for (const h of sec.hunks) drift += runHunk(f, toPair(h.items), h.head, drift, strict, h.tailOff, op);
    ov.staged.set(op, paste(f));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

function readBlocks(rows: string[], strict: boolean): Apply[] {
  interface Block {
    where: string;
    old: string[];
    add: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < rows.length; j++) {
      if (rows[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Fatal(`error: parse ${s + 1}`);
    let rp = -1;
    for (let j = eq + 1; j < rows.length; j++) {
      if (rows[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rp = j;
        break;
      }
    }
    if (rp < 0) throw new Fatal(`error: parse ${s + 1}`);
    // The path is the nearest line above that is neither blank nor a code fence,
    // not reaching back past the previous block's end.
    let where: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const r = rows[j]!;
      if (isBlank(r)) continue;
      const t = r.trim();
      if (t.startsWith('```')) continue;
      where = t;
      break;
    }
    if (where === null) {
      if (prevPath === null) throw new Fatal(`error: parse ${s + 1}`);
      where = prevPath;
    }
    blocks.push({ where, old: rows.slice(s + 1, eq), add: rows.slice(eq + 1, rp) });
    prevPath = where;
    prevEnd = rp;
    i = rp + 1;
  }
  return blocks.map((b) => (ov: Overlay) => {
    if (!pathOk(b.where)) throw new Miss('unsafe', b.where);
    if (b.old.length === 0) {
      if (ov.current(b.where) !== null) throw new Miss('exists', b.where);
      ov.staged.set(b.where, b.add.length === 0 ? '' : b.add.join('\n') + '\n');
      return;
    }
    const before = ov.current(b.where);
    if (before === null) throw new Miss('missing', b.where);
    const f = chop(before);
    const found = seek(f.rows, b.old, strict);
    if (found === null) throw new Miss('no-match', b.where);
    if (found.hits.length > 1) throw new Miss('ambiguous', b.where);
    const pair: Pair = { old: b.old, parts: b.add.map((s) => ({ s, shared: false, slot: -1 })) };
    const repl = render(f.rows, found.hits[0]!, pair, found.tier);
    f.rows.splice(found.hits[0]!, b.old.length, ...repl);
    ov.staged.set(b.where, paste(f));
  });
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

function readV4a(rows: string[], strict: boolean, moves: [string, string][]): Apply[] {
  const first = rows.findIndex((r) => !isBlank(r));
  if (first < 0) throw new Fatal('error: parse 1');
  if (rows[first]!.trim() !== '*** Begin Patch') throw new Fatal(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = rows.length - 1; k >= 0; k--) {
    if (!isBlank(rows[k]!)) {
      last = k;
      break;
    }
  }
  if (rows[last]!.trim() !== '*** End Patch') throw new Fatal(`error: parse ${rows.length + 1}`);
  const HEADS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];
  // A section runs to the next section's head or to End Patch; blank rows at its
  // end are not part of it.
  const extent = (start: number): { end: number; next: number } => {
    let j = start;
    while (j < last && !HEADS.some((h) => rows[j]!.startsWith(h))) j++;
    let end = j;
    while (end > start && isBlank(rows[end - 1]!)) end--;
    return { end, next: j };
  };
  const edits: Apply[] = [];
  let i = first + 1;
  while (i < last) {
    const r = rows[i]!;
    if (isBlank(r)) {
      i++;
      continue;
    }
    if (r.startsWith('*** Add File: ')) {
      const p = r.slice(13).trim();
      const { end, next } = extent(i + 1);
      const content: string[] = [];
      for (let k = i + 1; k < end; k++) {
        const bl = rows[k]!;
        if (bl.startsWith('+')) content.push(bl.slice(1));
        else if (bl === '') content.push('');
        else throw new Fatal(`error: parse ${k + 1}`);
      }
      edits.push((ov) => {
        if (!pathOk(p)) throw new Miss('unsafe', p);
        if (ov.current(p) !== null) throw new Miss('exists', p);
        ov.staged.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      i = next;
      continue;
    }
    if (r.startsWith('*** Delete File: ')) {
      const p = r.slice(16).trim();
      const { end, next } = extent(i + 1);
      if (end > i + 1) throw new Fatal(`error: parse ${i + 2}`);
      edits.push((ov) => {
        if (!pathOk(p)) throw new Miss('unsafe', p);
        if (ov.current(p) === null) throw new Miss('missing', p);
        ov.staged.set(p, null);
      });
      i = next;
      continue;
    }
    if (r.startsWith('*** Update File: ')) {
      const p = r.slice(16).trim();
      const updLine = i + 1;
      const { end, next } = extent(i + 1);
      let moveTo: string | null = null;
      let k = i + 1;
      if (k < end && rows[k]!.startsWith('*** Move to: ')) {
        moveTo = rows[k]!.slice(13).trim();
        k++;
      }
      interface Chunk {
        anchor: string | null;
        eof: boolean;
        items: Piece[];
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (; k < end; k++) {
        const bl = rows[k]!;
        if (bl.startsWith('@@')) {
          const a = bl.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, items: [] };
          chunks.push(cur);
          continue;
        }
        if (bl === '*** End of File') {
          if (cur === null) throw new Fatal(`error: parse ${k + 1}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Fatal(`error: parse ${k + 1}`);
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          if (bl === '') cur.items.push({ tag: 'keep', s: '', bare: false });
          else if (bl.startsWith(' ')) cur.items.push({ tag: 'keep', s: bl.slice(1), bare: false });
          else if (bl.startsWith('-')) cur.items.push({ tag: 'drop', s: bl.slice(1), bare: false });
          else cur.items.push({ tag: 'add', s: bl.slice(1), bare: false });
          continue;
        }
        throw new Fatal(`error: parse ${k + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Fatal(`error: parse ${updLine}`);
      edits.push((ov) => {
        if (!pathOk(p)) throw new Miss('unsafe', p);
        if (moveTo !== null && !pathOk(moveTo)) throw new Miss('unsafe', moveTo);
        const before = ov.current(p);
        if (before === null) throw new Miss('missing', p);
        if (moveTo !== null && ov.current(moveTo) !== null) throw new Miss('exists', moveTo);
        const f = chop(before);
        let cursor = 0;
        for (const ch of chunks) cursor = runChunk(f, toPair(ch.items), ch.anchor, cursor, ch.eof, strict, p);
        const out = paste(f);
        if (moveTo !== null) {
          ov.staged.set(moveTo, out);
          ov.staged.set(p, null);
          moves.push([p, moveTo]);
        } else {
          ov.staged.set(p, out);
        }
      });
      i = next;
      continue;
    }
    throw new Fatal(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

/** One edit object read strictly; null when it is not one, which the caller
 *  reports as a parse fault at the object's line. */
function oneJsonEdit(v: unknown): Apply | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (ov: Overlay): string => {
    if (!pathOk(p)) throw new Miss('unsafe', p);
    const t = ov.current(p);
    if (t === null) throw new Miss('missing', p);
    return t;
  };
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (ov) => {
      if (!pathOk(p)) throw new Miss('unsafe', p);
      if (ov.current(p) !== null) throw new Miss('exists', p);
      ov.staged.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldS = o.old_str;
    const newS = (o.new_str as string | undefined) ?? '';
    return (ov) => {
      const before = need(ov);
      // In a CRLF file the text and both strings are read with \n for \r\n, and
      // the outcome is written back with \r\n (section 9).
      const at = before.indexOf('\n');
      const crlf = at > 0 && before.charAt(at - 1) === '\r';
      const toLf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const hay = toLf(before);
      const needle = toLf(oldS);
      let count = 0;
      for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + 1)) count++;
      if (count === 0) throw new Miss('no-match', p);
      if (count > 1) throw new Miss('ambiguous', p);
      const at2 = hay.indexOf(needle);
      const joined = hay.slice(0, at2) + toLf(newS) + hay.slice(at2 + needle.length);
      ov.staged.set(p, crlf ? joined.split('\n').join('\r\n') : joined);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const add = patchRows(o.new_str);
    return (ov) => {
      const before = need(ov);
      const f = chop(before);
      if (line < 0 || line > f.rows.length) throw new Miss('no-match', p);
      f.rows.splice(line, 0, ...add);
      ov.staged.set(p, paste(f));
    };
  }
  return null;
}

function readJson(text: string, rows: string[]): Apply[] {
  const first = rows.findIndex((r) => !isBlank(r));
  if (first < 0) throw new Fatal('error: parse 1');
  const edits: Apply[] = [];
  if (rows[first]!.trimStart().startsWith('[')) {
    // One array: any fault in it is named at the line where the array starts.
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Fatal(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Fatal(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = oneJsonEdit(x);
      if (e === null) throw new Fatal(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  rows.forEach((r, idx) => {
    if (isBlank(r)) return;
    let e: Apply | null = null;
    try {
      e = oneJsonEdit(JSON.parse(r));
    } catch {
      e = null;
    }
    if (e === null) throw new Fatal(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// The command line, and putting it together (sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function drive(argv: string[]): { status: number; lines: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let afterDashDash = false;
  for (const a of argv) {
    if (!afterDashDash && a === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.has(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !checkOnly) checkOnly = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { status: 2, lines: ['error: usage'] };
      continue;
    }
    positional.push(a);
  }
  if (positional.length > 1) return { status: 2, lines: ['error: usage'] };
  const patchArg = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = fs.readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { status: 2, lines: ['error: no-patch'] };
  }
  const rows = patchRows(text);
  const kind = format === null || format === 'auto' ? sniff(rows) : format;
  if (kind === null) return { status: 2, lines: ['error: format'] };
  const moves: [string, string][] = [];
  let edits: Apply[];
  try {
    if (kind === 'json') edits = readJson(text, rows);
    else if (kind === 'unified') edits = readUnified(rows, strict, moves);
    else if (kind === 'search-replace') edits = readBlocks(rows, strict);
    else edits = readV4a(rows, strict, moves);
    if (edits.length === 0) throw new Fatal('error: parse 1');
  } catch (e) {
    if (e instanceof Fatal) return { status: 2, lines: [e.line] };
    throw e;
  }
  // Edits run in the patch's order, each on the tree the ones before it left;
  // a failed edit is rolled back whole and the ones after it still run.
  const ov = new Overlay();
  const misses: Miss[] = [];
  for (const edit of edits) {
    const saved = new Map(ov.staged);
    try {
      edit(ov);
    } catch (e) {
      if (!(e instanceof Miss)) throw e;
      ov.staged.clear();
      for (const [k, v] of saved) ov.staged.set(k, v);
      misses.push(e);
    }
  }
  if (misses.length > 0) {
    return {
      status: 1,
      lines: [...misses.map((m) => `error: ${m.code} ${m.where}`), `failed: ${misses.length} of ${edits.length} edits`],
    };
  }
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  const changed = [...ov.staged.keys()].filter((p) => ov.base(p) !== ov.staged.get(p)).sort(byBytes);
  interface Row {
    key: string;
    line: string;
  }
  const out: Row[] = changed.map((p) => {
    const was = ov.base(p);
    const now = ov.staged.get(p) as string | null;
    return { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
  });
  // A move that truly moved a file replaces its D and A rows with one R row,
  // sorted by the new path.
  for (const [from, to] of moves) {
    if (ov.base(from) === null || ov.current(from) !== null) continue;
    if (ov.base(to) !== null || ov.current(to) === null) continue;
    for (let k = out.length - 1; k >= 0; k--) {
      if (out[k]!.line === `D ${from}` || out[k]!.line === `A ${to}`) out.splice(k, 1);
    }
    out.push({ key: to, line: `R ${from} -> ${to}` });
  }
  out.sort((x, y) => byBytes(x.key, y.key));
  if (!checkOnly) {
    for (const p of changed) {
      const now = ov.staged.get(p) as string | null;
      if (now === null) fs.rmSync(p, { force: true });
      else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, now);
      }
    }
  }
  return { status: 0, lines: [...out.map((r) => r.line), `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on
  // each one, without this variable in its environment.
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const r = drive(process.argv.slice(2));
  fs.writeSync(1, r.lines.map((l) => `${l}\n`).join(''));
  process.exitCode = r.status;
}
