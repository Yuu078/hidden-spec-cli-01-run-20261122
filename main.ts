// mend — one patch tool for every edit format an AI model writes.
//
// mend reads a patch in one of four formats (a unified diff, SEARCH/REPLACE
// blocks, a V4A patch, or JSON edit objects), works out the change each edit
// asks for against the tree of text files in the working directory, and then
// writes every change or none of them. What it did, or why an edit failed,
// is printed on standard output; the exit code says which kind of answer it
// was. The contract is SPEC.md, and this file follows it section by section.
//
// When the trial environment is present (MAKEFUN_ENV_URL) main.ts is not a
// CLI at all: it hands over to the kit's runner, which drives this same file
// once per check.

import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------------------
// Errors. A ParseFault aborts the whole run before any file is looked at and
// carries the 1-based patch line the format's section names. A Botch is one
// edit failing against the tree; it carries the spec's code and the path the
// failure concerns, and the run goes on with the next edit.

class ParseFault extends Error {
  lineNo: number;
  constructor(lineNo: number) {
    super(`parse ${lineNo}`);
    this.lineNo = lineNo;
  }
}

class Botch extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// The tree, held in memory while the patch runs. Files are read lazily and
// nothing reaches the disk until every edit has succeeded, which is what
// makes a patch atomic. The state each touched path started in is remembered
// so the final report can compare before with after.

class Tree {
  private now = new Map<string, string>();
  private gone = new Set<string>();
  private start = new Map<string, string | null>();
  moves: Array<[string, string]> = [];

  private peek(path: string): string | null {
    if (this.gone.has(path)) return null;
    const held = this.now.get(path);
    if (held !== undefined) return held;
    try {
      return readFileSync(join(...path.split('/')), 'utf8');
    } catch {
      return null;
    }
  }

  private note(path: string): void {
    if (!this.start.has(path)) this.start.set(path, this.peek(path));
  }

  has(path: string): boolean {
    return this.peek(path) !== null;
  }

  read(path: string): string | null {
    this.note(path);
    return this.peek(path);
  }

  put(path: string, text: string): void {
    this.note(path);
    this.gone.delete(path);
    this.now.set(path, text);
  }

  del(path: string): void {
    this.note(path);
    this.now.delete(path);
    this.gone.add(path);
  }

  /** The paths the patch touched, each with its before and after text. */
  touched(): Array<{ path: string; before: string | null; after: string | null }> {
    const out: Array<{ path: string; before: string | null; after: string | null }> = [];
    for (const [path, before] of this.start) out.push({ path, before, after: this.peek(path) });
    return out;
  }

  /** Write every change to disk. Directories are made as files need them. */
  flush(): void {
    for (const { path, before, after } of this.touched()) {
      if (before === after) continue;
      const disk = join(...path.split('/'));
      if (after === null) {
        rmSync(disk, { force: true });
      } else {
        mkdirSync(dirname(disk), { recursive: true });
        writeFileSync(disk, after);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Lines. A file's break is CRLF when its first line feed follows a carriage
// return, else LF; its lines are the text split at that break, and a final
// break does not make a last empty line. A patch's lines are split at \n,
// each with one trailing \r removed.

interface TextBody {
  brk: string;
  lines: string[];
  tail: boolean; // the text ends with a line break
}

function splitBody(text: string): TextBody {
  let brk = '\n';
  const firstLf = text.indexOf('\n');
  if (firstLf > 0 && text[firstLf - 1] === '\r') brk = '\r\n';
  if (text === '') return { brk, lines: [], tail: false };
  const parts = text.split(brk);
  let tail = false;
  if (parts[parts.length - 1] === '') {
    tail = true;
    parts.pop();
  }
  return { brk, lines: parts, tail };
}

function joinBody(body: TextBody): string {
  if (body.lines.length === 0) return '';
  return body.lines.join(body.brk) + (body.tail ? body.brk : '');
}

function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// ---------------------------------------------------------------------------
// Paths. A path is safe when it is not empty, does not start with /, holds
// no backslash, and no /-separated segment of it is empty, . or ...

function safePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function demandSafe(path: string): void {
  if (!safePath(path)) throw new Botch('unsafe', path);
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC section 5). Old lines are looked for at three tiers:
// exact, then ignoring trailing blanks, then ignoring blanks at both ends.
// The first tier with an occurrence wins. With --strict only tier 0 is tried.

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function atTier(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trimTrail(line);
  return trimBoth(line);
}

interface Found {
  tier: number;
  hits: number[]; // 0-based start positions, in order
}

function findLines(
  fileLines: string[],
  want: string[],
  strict: boolean,
  from: number,
): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const keys = want.map((l) => atTier(l, tier));
    const hits: number[] = [];
    for (let i = from; i + want.length <= fileLines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < want.length; j += 1) {
        if (atTier(fileLines[i + j], tier) !== keys[j]) {
          ok = false;
          break;
        }
      }
      if (ok) hits.push(i);
    }
    if (hits.length > 0) return { tier, hits };
  }
  return null;
}

// One line of a replacement: either a context line (written as the file's own
// matched line, ctxAt is its index in the old lines) or a fresh line.
interface NewLine {
  text: string;
  ctxAt: number; // -1 for a fresh line
}

function leadBlanks(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

// Build the lines that replace the match at pos. Context lines come from the
// file. At tier 2 the fresh lines are re-indented: the first old line's lead
// P becomes the file's first matched line's lead F, on any fresh line that
// is not blank and starts with P.
function replacement(
  fileLines: string[],
  pos: number,
  oldLines: string[],
  newLines: NewLine[],
  tier: number,
): string[] {
  let from = '';
  let to = '';
  if (tier === 2 && oldLines.length > 0) {
    to = leadBlanks(fileLines[pos]);
    from = leadBlanks(oldLines[0]);
  }
  return newLines.map((nl) => {
    if (nl.ctxAt >= 0) return fileLines[pos + nl.ctxAt];
    let t = nl.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(from)) {
      t = to + t.slice(from.length);
    }
    return t;
  });
}

// ---------------------------------------------------------------------------
// An edit is a closure over the tree. Parsers below turn a patch into a list
// of them (reading the whole patch first, so a parse fault is reported
// before any file is looked at); the driver then runs them in order.

type Edit = (tree: Tree) => void;

// --strict is a run-wide option that the appliers below need; the driver
// sets it before any edit runs.
let strictRun = false;

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6).

interface HunkEntry {
  kind: string; // ' ', '-' or '+'
  text: string;
  noEol: boolean; // a \ line follows this body line
}

interface Hunk {
  a: number; // the A of @@ -A[,B] +C[,D] @@
  entries: HunkEntry[];
}

interface Section {
  minus: string | null; // old path from ---, '/dev/null' for none
  plus: string | null; // new path from +++
  gitOld: string | null;
  gitNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function headerPath(raw: string): string {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let inHeader = false;
  let body: Hunk | null = null;

  const freshSection = (): Section => ({
    minus: null,
    plus: null,
    gitOld: null,
    gitNew: null,
    renFrom: null,
    renTo: null,
    newFile: false,
    delFile: false,
    hunks: [],
  });

  const closeBody = (): void => {
    if (body === null || sec === null) return;
    while (body.entries.length > 0) {
      const last = body.entries[body.entries.length - 1];
      if (last.kind === ' ' && last.text === '' && !last.noEol) body.entries.pop();
      else break;
    }
    sec.hunks.push(body);
    body = null;
  };

  const closeSection = (): void => {
    closeBody();
    if (sec !== null) sections.push(sec);
    sec = null;
    inHeader = false;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : null;

    if (body !== null) {
      // Inside a hunk body: body lines, or the start of the next section.
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && next !== null && next.startsWith('+++ '))) {
        closeBody();
        // fall through and treat this line as a section start below
      } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
        body.entries.push({ kind: line === '' ? ' ' : line[0], text: line.slice(1), noEol: false });
        i += 1;
        continue;
      } else if (line[0] === '\\') {
        const last = body.entries[body.entries.length - 1];
        if (last !== undefined) last.noEol = true;
        i += 1;
        continue;
      } else {
        closeBody();
        // fall through: the line is handled as a header or outside line
      }
    }

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      closeSection();
      sec = freshSection();
      sec.gitOld = m[1];
      sec.gitNew = m[2];
      inHeader = true;
      i += 1;
      continue;
    }

    if (line.startsWith('--- ') && next !== null && next.startsWith('+++ ')) {
      if (sec !== null && inHeader && sec.minus === null) {
        sec.minus = headerPath(line.slice(4));
        sec.plus = headerPath(next.slice(4));
      } else {
        closeSection();
        sec = freshSection();
        sec.minus = headerPath(line.slice(4));
        sec.plus = headerPath(next.slice(4));
        inHeader = true;
      }
      i += 2;
      continue;
    }

    if (sec !== null && inHeader && line.startsWith('--- ')) {
      // A --- line in a header with no +++ after it: the fault names the
      // line after it.
      throw new ParseFault(i + 2);
    }

    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseFault(i + 1);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      body = { a: Number(m[1]), entries: [] };
      inHeader = false;
      i += 1;
      continue;
    }

    if (sec !== null && inHeader) {
      if (line.startsWith('rename from ')) sec.renFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) sec.renTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
      // index, mode and similarity lines, and anything else, are ignored.
      i += 1;
      continue;
    }

    // Outside bodies and headers, lines are ignored (prose, code fences).
    i += 1;
  }
  closeSection();

  if (sections.length === 0) throw new ParseFault(1);
  return sections.map((s) => (tree: Tree) => applySection(tree, s));
}

// Apply one section's hunks, in order, to a list of lines. d is the running
// sum of (new length - old length) over the hunks applied so far; a hunk
// whose old lines are found takes the occurrence nearest to A - 1 + d.
function applyHunks(
  startLines: string[],
  startTail: boolean,
  hunks: Hunk[],
  strict: boolean,
): { lines: string[]; tail: boolean } {
  let lines = startLines;
  let tail = startTail;
  let d = 0;
  for (const hunk of hunks) {
    const oldLines: string[] = [];
    const newLines: NewLine[] = [];
    for (const e of hunk.entries) {
      if (e.kind === ' ') {
        const at = oldLines.length;
        oldLines.push(e.text);
        newLines.push({ text: e.text, ctxAt: at });
      } else if (e.kind === '-') {
        oldLines.push(e.text);
      } else {
        newLines.push({ text: e.text, ctxAt: -1 });
      }
    }

    if (oldLines.length === 0) {
      // Nothing to find: the new lines go after the first A + d lines.
      const pos = Math.min(hunk.a + d, lines.length);
      const fresh = newLines.map((nl) => nl.text);
      lines = [...lines.slice(0, pos), ...fresh, ...lines.slice(pos)];
      if (pos + fresh.length === lines.length && fresh.length > 0) {
        // The insertion is at the end: the result ends with a break unless
        // a \ line follows the hunk's last + line.
        const lastPlus = hunk.entries[hunk.entries.length - 1];
        tail = !(lastPlus !== undefined && lastPlus.kind === '+' && lastPlus.noEol);
      }
      d += newLines.length;
      continue;
    }

    const found = findLines(lines, oldLines, strict, 0);
    if (found === null) throw new Botch('no-match', '');
    const target = hunk.a - 1 + d;
    let pos = found.hits[0];
    for (const hit of found.hits) {
      if (Math.abs(hit - target) < Math.abs(pos - target)) pos = hit;
    }
    const repl = replacement(lines, pos, oldLines, newLines, found.tier);
    const runsToEnd = pos + oldLines.length === lines.length;
    lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + oldLines.length)];
    if (runsToEnd) {
      // The matched lines run to the end of the file: the result ends with
      // a break unless a \ line follows the hunk's last context or + line.
      let lastCp: HunkEntry | undefined;
      for (const e of hunk.entries) if (e.kind === ' ' || e.kind === '+') lastCp = e;
      tail = !(lastCp !== undefined && lastCp.noEol);
    }
    d += newLines.length - oldLines.length;
  }
  return { lines, tail };
}

function applySection(tree: Tree, sec: Section): void {
  const oldPath = sec.minus ?? sec.renFrom ?? sec.gitOld;
  const newPath = sec.plus ?? sec.renTo ?? sec.gitNew;
  const isCreate = sec.newFile || sec.minus === '/dev/null';
  const isDelete = sec.delFile || sec.plus === '/dev/null';

  if (isCreate) {
    const target = newPath ?? oldPath;
    if (target === null) throw new Botch('missing', '');
    demandSafe(target);
    if (tree.has(target)) throw new Botch('exists', target);
    const made: string[] = [];
    let lastPlus: HunkEntry | undefined;
    for (const hunk of sec.hunks) {
      for (const e of hunk.entries) {
        if (e.kind === '+') {
          made.push(e.text);
          lastPlus = e;
        }
      }
    }
    const tail = made.length > 0 && !(lastPlus !== undefined && lastPlus.noEol);
    tree.put(target, made.join('\n') + (tail ? '\n' : ''));
    return;
  }

  if (oldPath === null) throw new Botch('missing', newPath ?? '');
  demandSafe(oldPath);

  if (isDelete) {
    if (!tree.has(oldPath)) throw new Botch('missing', oldPath);
    tree.del(oldPath);
    return;
  }

  const text = tree.read(oldPath);
  if (text === null) throw new Botch('missing', oldPath);
  const isMove = newPath !== null && newPath !== oldPath;
  if (isMove) {
    demandSafe(newPath as string);
    if (tree.has(newPath as string)) throw new Botch('exists', newPath as string);
  }

  const body = splitBody(text);
  let done: { lines: string[]; tail: boolean };
  try {
    done = applyHunks(body.lines, body.tail, sec.hunks, strictRun);
  } catch (err) {
    if (err instanceof Botch) throw new Botch(err.code, oldPath);
    throw err;
  }
  const out = joinBody({ brk: body.brk, lines: done.lines, tail: done.tail });
  if (isMove) {
    tree.put(newPath as string, out);
    tree.del(oldPath);
    tree.moves.push([oldPath, newPath as string]);
  } else {
    tree.put(oldPath, out);
  }
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7).

interface Block {
  path: string;
  oldLines: string[];
  newLines: string[];
}

const rtrimLine = (s: string): string => s.replace(/\s+$/, '');

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let regionStart = 0; // first line index a path may be searched from
  let i = 0;
  while (i < lines.length) {
    if (rtrimLine(lines[i]) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= regionStart; j -= 1) {
      const t = lines[j].trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(searchLine);

    let k = i + 1;
    const oldLines: string[] = [];
    while (k < lines.length && rtrimLine(lines[k]) !== '=======' && rtrimLine(lines[k]) !== '>>>>>>> REPLACE') {
      oldLines.push(lines[k]);
      k += 1;
    }
    if (k >= lines.length || rtrimLine(lines[k]) !== '=======') throw new ParseFault(searchLine);
    k += 1;
    const newLines: string[] = [];
    while (k < lines.length && rtrimLine(lines[k]) !== '>>>>>>> REPLACE') {
      newLines.push(lines[k]);
      k += 1;
    }
    if (k >= lines.length) throw new ParseFault(searchLine);

    blocks.push({ path, oldLines, newLines });
    prevPath = path;
    regionStart = k + 1;
    i = k + 1;
  }
  if (blocks.length === 0) throw new ParseFault(1);
  return blocks.map((b) => (tree: Tree) => applyBlock(tree, b));
}

function applyBlock(tree: Tree, block: Block): void {
  demandSafe(block.path);
  if (block.oldLines.length === 0) {
    // No old lines: the file is created with the new lines.
    if (tree.has(block.path)) throw new Botch('exists', block.path);
    const text = block.newLines.length === 0 ? '' : block.newLines.join('\n') + '\n';
    tree.put(block.path, text);
    return;
  }
  const text = tree.read(block.path);
  if (text === null) throw new Botch('missing', block.path);
  const body = splitBody(text);
  const found = findLines(body.lines, block.oldLines, strictRun, 0);
  if (found === null) throw new Botch('no-match', block.path);
  if (found.hits.length > 1) throw new Botch('ambiguous', block.path);
  const pos = found.hits[0];
  const newLines: NewLine[] = block.newLines.map((t) => ({ text: t, ctxAt: -1 }));
  const repl = replacement(body.lines, pos, block.oldLines, newLines, found.tier);
  const lines = [...body.lines.slice(0, pos), ...repl, ...body.lines.slice(pos + block.oldLines.length)];
  tree.put(block.path, joinBody({ brk: body.brk, lines, tail: body.tail }));
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8).

interface Chunk {
  anchor: string | null;
  entries: HunkEntry[]; // kinds ' ', '-', '+'; noEol unused here
  eof: boolean;
}

interface VSection {
  kind: string; // 'add', 'delete' or 'update'
  path: string;
  addLines: string[];
  moveTo: string | null;
  chunks: Chunk[];
  headLine: number;
}

const isVSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (lines[idx].trim() !== '') {
      if (first < 0) first = idx;
      last = idx;
    }
  }
  if (first < 0) throw new ParseFault(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    let kind: string;
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new ParseFault(i + 1);
    }
    const headLine = i + 1;
    const raw: Array<{ n: number; t: string }> = [];
    let j = i + 1;
    while (j < last && !isVSectionStart(lines[j])) {
      raw.push({ n: j + 1, t: lines[j] });
      j += 1;
    }
    while (raw.length > 0 && raw[raw.length - 1].t.trim() === '') raw.pop();
    sections.push(parseVSection(kind, path, raw, headLine));
    i = j;
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections.map((s) => (tree: Tree) => applyVSection(tree, s));
}

function parseVSection(
  kind: string,
  path: string,
  raw: Array<{ n: number; t: string }>,
  headLine: number,
): VSection {
  const sec: VSection = { kind, path, addLines: [], moveTo: null, chunks: [], headLine };
  if (kind === 'add') {
    for (const { n, t } of raw) {
      if (t.startsWith('+')) sec.addLines.push(t.slice(1));
      else if (t === '') sec.addLines.push('');
      else throw new ParseFault(n);
    }
    return sec;
  }
  if (kind === 'delete') {
    if (raw.length > 0) throw new ParseFault(raw[0].n);
    return sec;
  }
  // Update: an optional Move to first, then chunks.
  let at = 0;
  if (raw.length > 0 && raw[0].t.startsWith('*** Move to: ')) {
    sec.moveTo = raw[0].t.slice('*** Move to: '.length).trim();
    at = 1;
  }
  let chunk: Chunk | null = null;
  let afterEof = false; // an End of File closed a chunk: only @@ may follow
  for (let k = at; k < raw.length; k += 1) {
    const { n, t } = raw[k];
    if (t.startsWith('@@')) {
      const anchor = t.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, entries: [], eof: false };
      sec.chunks.push(chunk);
      afterEof = false;
    } else if (t.trim() === '*** End of File') {
      // End of File ends a chunk and anchors it to the end of the file; with
      // no chunk open (or a second one in a row) it is a parse fault.
      if (chunk === null) throw new ParseFault(n);
      chunk.eof = true;
      chunk = null;
      afterEof = true;
    } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
      if (afterEof) throw new ParseFault(n);
      if (chunk === null) {
        chunk = { anchor: null, entries: [], eof: false };
        sec.chunks.push(chunk);
      }
      chunk.entries.push({ kind: t === '' ? ' ' : t[0], text: t.slice(1), noEol: false });
    } else {
      throw new ParseFault(n);
    }
  }
  if (sec.chunks.length === 0 && sec.moveTo === null) throw new ParseFault(headLine);
  return sec;
}

function applyVSection(tree: Tree, sec: VSection): void {
  demandSafe(sec.path);
  if (sec.kind === 'add') {
    if (tree.has(sec.path)) throw new Botch('exists', sec.path);
    const text = sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n';
    tree.put(sec.path, text);
    return;
  }
  if (sec.kind === 'delete') {
    if (!tree.has(sec.path)) throw new Botch('missing', sec.path);
    tree.del(sec.path);
    return;
  }
  // Update.
  const text = tree.read(sec.path);
  if (text === null) throw new Botch('missing', sec.path);
  if (sec.moveTo !== null) {
    demandSafe(sec.moveTo);
    if (tree.has(sec.moveTo)) throw new Botch('exists', sec.moveTo);
  }
  const body = splitBody(text);
  let lines = body.lines;
  let cursor = 0;
  for (const chunk of sec.chunks) {
    if (chunk.anchor !== null) {
      const tiers = strictRun ? [0] : [0, 1, 2];
      let at = -1;
      for (const tier of tiers) {
        const key = atTier(chunk.anchor, tier);
        for (let p = cursor; p < lines.length; p += 1) {
          if (atTier(lines[p], tier) === key) {
            at = p;
            break;
          }
        }
        if (at >= 0) break;
      }
      if (at < 0) throw new Botch('no-match', sec.path);
      cursor = at + 1;
    }
    const oldLines: string[] = [];
    const newLines: NewLine[] = [];
    for (const e of chunk.entries) {
      if (e.kind === ' ') {
        const idx = oldLines.length;
        oldLines.push(e.text);
        newLines.push({ text: e.text, ctxAt: idx });
      } else if (e.kind === '-') {
        oldLines.push(e.text);
      } else {
        newLines.push({ text: e.text, ctxAt: -1 });
      }
    }
    if (oldLines.length === 0) {
      const pos = chunk.eof ? lines.length : Math.min(cursor, lines.length);
      const fresh = newLines.map((nl) => nl.text);
      lines = [...lines.slice(0, pos), ...fresh, ...lines.slice(pos)];
      cursor = pos + fresh.length;
      continue;
    }
    const found = findLines(lines, oldLines, strictRun, cursor);
    if (found === null) throw new Botch('no-match', sec.path);
    let hits = found.hits;
    if (chunk.eof) hits = hits.filter((h) => h + oldLines.length === lines.length);
    if (hits.length === 0) throw new Botch('no-match', sec.path);
    const pos = hits[0];
    const repl = replacement(lines, pos, oldLines, newLines, found.tier);
    lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + oldLines.length)];
    cursor = pos + repl.length;
  }
  const out = joinBody({ brk: body.brk, lines, tail: body.tail });
  if (sec.moveTo !== null) {
    tree.put(sec.moveTo, out);
    tree.del(sec.path);
    tree.moves.push([sec.path, sec.moveTo]);
  } else {
    tree.put(sec.path, out);
  }
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9).

interface JsonEdit {
  command: string;
  path: string;
  fileText: string;
  oldStr: string;
  newStr: string;
  insertLine: number;
}

function validJsonEdit(obj: unknown): JsonEdit | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const base: JsonEdit = {
    command: '',
    path: o.path,
    fileText: '',
    oldStr: '',
    newStr: '',
    insertLine: 0,
  };
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    base.command = 'create';
    base.fileText = o.file_text;
    return base;
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    base.command = 'str_replace';
    base.oldStr = o.old_str;
    base.newStr = o.new_str === undefined ? '' : (o.new_str as string);
    return base;
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    base.command = 'insert';
    base.insertLine = o.insert_line;
    base.newStr = o.new_str;
    return base;
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const edits: JsonEdit[] = [];
  if (text.trim().startsWith('[')) {
    let startLine = 1;
    for (let idx = 0; idx < lines.length; idx += 1) {
      if (lines[idx].trim() !== '') {
        startLine = idx + 1;
        break;
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseFault(startLine);
    }
    if (!Array.isArray(parsed)) throw new ParseFault(startLine);
    for (const item of parsed) {
      const e = validJsonEdit(item);
      if (e === null) throw new ParseFault(startLine);
      edits.push(e);
    }
  } else {
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new ParseFault(idx + 1);
      }
      const e = validJsonEdit(parsed);
      if (e === null) throw new ParseFault(idx + 1);
      edits.push(e);
    }
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits.map((e) => (tree: Tree) => applyJsonEdit(tree, e));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = haystack.indexOf(needle, at + 1);
  }
  return count;
}

function applyJsonEdit(tree: Tree, edit: JsonEdit): void {
  demandSafe(edit.path);
  if (edit.command === 'create') {
    if (tree.has(edit.path)) throw new Botch('exists', edit.path);
    tree.put(edit.path, edit.fileText);
    return;
  }
  const text = tree.read(edit.path);
  if (text === null) throw new Botch('missing', edit.path);

  if (edit.command === 'str_replace') {
    const crlf = splitBody(text).brk === '\r\n';
    const norm = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
    const work = norm(text);
    const oldStr = norm(edit.oldStr);
    const hits = countOccurrences(work, oldStr);
    if (hits === 0) throw new Botch('no-match', edit.path);
    if (hits > 1) throw new Botch('ambiguous', edit.path);
    let out = work.replace(oldStr, () => norm(edit.newStr));
    if (crlf) out = out.split('\n').join('\r\n');
    tree.put(edit.path, out);
    return;
  }

  // insert
  const body = splitBody(text);
  if (edit.insertLine < 0 || edit.insertLine > body.lines.length) {
    throw new Botch('no-match', edit.path);
  }
  const parts = edit.newStr.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  const fresh = parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const lines = [
    ...body.lines.slice(0, edit.insertLine),
    ...fresh,
    ...body.lines.slice(edit.insertLine),
  ];
  tree.put(edit.path, joinBody({ brk: body.brk, lines, tail: body.tail }));
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC section 4), for --format=auto.

function detectFormat(lines: string[]): string | null {
  let firstText = '';
  for (const l of lines) {
    if (l.trim() !== '') {
      firstText = l.trim();
      break;
    }
  }
  if (firstText === '*** Begin Patch') return 'v4a';
  if (firstText.startsWith('[') || firstText.startsWith('{')) return 'json';
  for (const l of lines) if (rtrimLine(l) === '<<<<<<< SEARCH') return 'search-replace';
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (lines[idx].startsWith('diff --git ')) return 'unified';
    if (lines[idx].startsWith('--- ') && idx + 1 < lines.length && lines[idx + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The report (SPEC section 2). One line per path whose state changed, in
// byte order of the paths; a successful move replaces its pair's D and A
// lines with one R line that sorts by the new path.

function byteCompare(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i += 1) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i];
  }
  return ba.length - bb.length;
}

function reportLines(tree: Tree): string[] {
  const rows: Array<{ key: string; line: string }> = [];
  const state = new Map<string, { before: string | null; after: string | null }>();
  for (const t of tree.touched()) state.set(t.path, t);
  const used = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const o = state.get(oldP);
    const n = state.get(newP);
    if (
      o !== undefined && n !== undefined &&
      o.before !== null && o.after === null &&
      n.before === null && n.after !== null
    ) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      used.add(oldP);
      used.add(newP);
    }
  }
  for (const { path, before, after } of state.values()) {
    if (used.has(path) || before === after) continue;
    if (before === null) rows.push({ key: path, line: `A ${path}` });
    else if (after === null) rows.push({ key: path, line: `D ${path}` });
    else rows.push({ key: path, line: `M ${path}` });
  }
  rows.sort((x, y) => byteCompare(x.key, y.key));
  return rows.map((r) => r.line);
}

// ---------------------------------------------------------------------------
// The driver: arguments, the patch, the edits in order, the answer.

const FORMAT_NAMES = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function mendMain(argv: string[]): number {
  const out: string[] = [];
  const emit = (code: number): number => {
    process.stdout.write(out.join('\n') + '\n');
    return code;
  };

  // Arguments (section 1). Options and PATCH may come in any order; -- ends
  // the options. A repeated option, an unknown -argument, a bad --format
  // value or a second positional argument is a usage error.
  let format = 'auto';
  let checkOnly = false;
  let strict = false;
  let patchArg: string | null = null;
  let usageBad = false;
  const seen = new Set<string>();
  let optionsDone = false;
  for (const arg of argv) {
    if (!optionsDone && arg === '--') {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check' || arg === '--strict') {
        const key = arg.slice(2);
        if (seen.has(key)) usageBad = true;
        seen.add(key);
        if (arg === '--check') checkOnly = true;
        else strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seen.has('format')) usageBad = true;
        seen.add('format');
        const value = arg.slice('--format='.length);
        if (!FORMAT_NAMES.includes(value)) usageBad = true;
        else format = value;
      } else {
        usageBad = true;
      }
      continue;
    }
    if (patchArg !== null) usageBad = true;
    else patchArg = arg;
  }
  if (usageBad) {
    out.push('error: usage');
    return emit(2);
  }

  // The patch itself: from the named file, or standard input.
  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    try {
      patchText = readFileSync(0, 'utf8');
    } catch {
      out.push('error: no-patch');
      return emit(2);
    }
  } else {
    try {
      patchText = readFileSync(join(...patchArg.split('/')), 'utf8');
    } catch {
      out.push('error: no-patch');
      return emit(2);
    }
  }
  const lines = patchLines(patchText);

  // The format: named, or detected.
  let formatName = format;
  if (formatName === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      out.push('error: format');
      return emit(2);
    }
    formatName = detected;
  }

  // Read the whole patch before any file is looked at.
  strictRun = strict;
  let edits: Edit[];
  try {
    if (formatName === 'unified') edits = parseUnified(lines);
    else if (formatName === 'search-replace') edits = parseSearchReplace(lines);
    else if (formatName === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(patchText, lines);
  } catch (err) {
    if (err instanceof ParseFault) {
      out.push(`error: parse ${err.lineNo}`);
      return emit(2);
    }
    throw err;
  }

  // Run the edits in order; a failed edit changes nothing and the edits
  // after it still run.
  const tree = new Tree();
  const failures: Botch[] = [];
  for (const edit of edits) {
    try {
      edit(tree);
    } catch (err) {
      if (err instanceof Botch) failures.push(err);
      else throw err;
    }
  }
  if (failures.length > 0) {
    for (const f of failures) out.push(`error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return emit(1);
  }

  if (!checkOnly) tree.flush();
  const rows = reportLines(tree);
  out.push(...rows);
  out.push(rows.length === 1 ? 'ok: 1 file' : `ok: ${rows.length} files`);
  return emit(0);
}

// ---------------------------------------------------------------------------
// Boot. With the trial environment present, main.ts hands over to the kit's
// runner; otherwise it is the CLI. This sits at the end of the file so every
// declaration above has been initialized before either path runs.

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  await runTrial(envUrl);
} else {
  process.exitCode = mendMain(process.argv.slice(2));
}
