// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Same answers as makefun-site's build(), byte for byte, on every case —
// reimplemented from its README spec as one fused pipeline:
//   * front matter parsed by index scans, no whole-text split/join round trip
//   * Markdown lexed and rendered in a single pass, inline over ranges
//     (no token objects, no substring slicing for nested spans)
//   * templates compiled once per case to plain JS (new Function) with a
//     scope-stack lookup, instead of tree-walking with string concat
//   * ASCII fast paths for slugs/escapes; per-case slug cache
// Nothing is cached from one case to the next: every per-case table is
// built fresh inside run().

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const SPECIAL_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. C-scan, allocates only on a hit. */
function escapeHtml(text) {
  SPECIAL_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = SPECIAL_RE.exec(text)) !== null) {
    out += text.slice(last, m.index) + ESCAPES[m[0]];
    last = m.index + 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** Whether code point `c` is JS \s whitespace. */
function isWSCode(c) {
  return (
    c === 32 || (c >= 9 && c <= 13) ||
    c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** Runs of non-whitespace in `text[from..]` (== text.slice(from).match(/\S+/g).length). */
function wordsIn(text, from) {
  let n = 0;
  let i = from;
  const len = text.length;
  while (i < len) {
    let c = text.charCodeAt(i);
    if (c < 128 ? c === 32 || (c >= 9 && c <= 13) : isWSCode(c)) { i++; continue; }
    n++;
    i++;
    while (i < len) {
      c = text.charCodeAt(i);
      if (c < 128 ? c === 32 || (c >= 9 && c <= 13) : isWSCode(c)) break;
      i++;
    }
  }
  return n;
}


const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const SLUG_MAX = 64;

/** Slug scan over `plain` (already NFKD, marks dropped). */
function slugScan(plain) {
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; ) {
    const cp = plain.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += cp > 0xffff ? 2 : 1;
    let keep = null;
    if (cp >= 65 && cp <= 90) keep = ch.toLowerCase();
    else if ((cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57)) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters, "untitled" when nothing is left. Pure-ASCII input skips
 * the normalisation entirely (NFKD is the identity on ASCII, and ASCII
 * holds no combining marks).
 */
function slugify(text, cache) {
  if (cache !== undefined) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
  }
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  const slug = ascii
    ? slugScan(text)
    : slugScan(text.normalize('NFKD').replace(/\p{M}/gu, ''));
  if (cache !== undefined) cache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const TAG_BAD = /["[\]]/;

/** Days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { y = -1; break; }
        }
        if (y !== -1) {
          y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
          mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
          d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
        }
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        if (tags[i] === '' || TAG_BAD.test(tags[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Is `line` blank (spaces and tabs only)? */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, lines, bodyFrom }, or { error }
 * with the first reason it is refused. `lines` is text split on "\n";
 * the body is lines[bodyFrom..]. Line numbers in errors count from 1 at
 * the opening `---`, exactly as the reference does.
 */
function parseFrontMatter(lines) {
  if (lines.length === 0 || lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    // key: value — key of [a-z_]+, ":", then one space and the value.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    if (e !== raw.length) raw = raw.slice(0, e);
    const key = line.slice(0, k);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, lines, bodyFrom: close + 1 };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Trim spaces and tabs at both ends of a line. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/**
 * Fence open: a line of three backticks and an optional language
 * (A-Z, a-z, 0-9, _, +, -), then spaces or tabs only. Returns the
 * language, or null when the line is not one.
 */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else return null;
  }
  return lang;
}

/** Fence close: a line of three backticks, spaces or tabs after them. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * Heading: 1 to 6 `#`, at least one space or tab, then text (spaces and
 * tabs at its end dropped). Returns { depth, text } or null.
 */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n === line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let text = line.slice(n + 1);
  let e = text.length;
  while (e > 0) {
    const d = text.charCodeAt(e - 1);
    if (d === 32 || d === 9) e--;
    else break;
  }
  if (e !== text.length) text = text.slice(0, e);
  if (text === '') return null;
  return { depth: n, text };
}

/** Thematic break: `---` or `***`, then spaces or tabs only. */
function isHR(line) {
  const first = line.charCodeAt(0);
  if (first !== 45 && first !== 42) return false;
  if (line.charCodeAt(1) !== first || line.charCodeAt(2) !== first) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** List continuation: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i === line.length) return false;
  const c = line.charCodeAt(i);
  if (c < 128) return !(c === 32 || (c >= 9 && c <= 13));
  return !isWSCode(c);
}

/** Bullet item: `- ` or `* `, returns its text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** Ordered item: digits and `. `, returns { num, text }, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && i < 9) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  let num = 0;
  for (let k = 0; k < i; k++) num = num * 10 + (line.charCodeAt(k) - 48);
  return { num, text: line.slice(i + 2) };
}

/** First index from `from` where `s` holds `what` outside an escape, or -1. Scans [from, end). */
function findUnescaped(s, what, from, end) {
  // No backslash in range: no escape can hide `what`; a C scan finds it.
  const bs = s.indexOf('\\', from);
  if (bs === -1 || bs >= end) {
    const j = s.indexOf(what, from);
    return j !== -1 && j + what.length <= end ? j : -1;
  }
  const wlen = what.length;
  for (let j = from; j + wlen <= end; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single `*` from `from` (one whose run is not `**`), outside an escape, or -1. Scans [from, end). */
function findSingleStar(s, from, end) {
  // No backslash and no "**" in range: every "*" stands alone.
  const bs = s.indexOf('\\', from);
  if (bs === -1 || bs >= end) {
    const dd = s.indexOf('**', from);
    if (dd === -1 || dd >= end) {
      const j = s.indexOf('*', from);
      return j !== -1 && j < end ? j : -1;
    }
  }
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/** Does `s` hold JS \s whitespace in [from, end)? */
function hasWS(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c < 128 ? c === 32 || (c >= 9 && c <= 13) : isWSCode(c)) return true;
  }
  return false;
}

/** Next inline-special character: backslash, backtick, *, [, or an HTML special. */
const INLINE_NEXT = /[\\`*\[&<>"']/g;

/**
 * `s[from..end)` rendered inline into `out`; `link(target)` resolves a
 * link's href. A regex finds each next interesting character in one C
 * scan; plain runs between them hold no HTML specials, so they go out
 * raw. Constructs nest by recursion over ranges, never sliced. Mirrors
 * the reference exactly, including its nesting.
 */
function inlineRange(s, from, end, link, out) {
  let i = from;
  let run = from;
  // Flush the plain run [run, to): it holds no HTML specials, so raw.
  const flush = (to) => {
    if (to > run) out.push(s.slice(run, to));
  };
  while (i < end) {
    INLINE_NEXT.lastIndex = i;
    const m = INLINE_NEXT.exec(s);
    const at = m === null || m.index >= end ? -1 : m.index;
    if (at === -1) break;
    const code = s.charCodeAt(at);
    if (code === 38 || code === 60 || code === 62 || code === 34 || code === 39) {
      // & < > " ' — escape as met.
      flush(at);
      out.push(ESCAPES[s[at]]);
      i = at + 1;
      run = i;
      continue;
    }
    if (code === 92 && at + 1 < end && ESCAPABLE.has(s[at + 1])) {
      flush(at);
      out.push(ESCAPES[s[at + 1]] ?? s[at + 1]);
      i = at + 2;
      run = i;
      continue;
    }
    if (code === 96) {
      const j = s.indexOf('`', at + 1);
      if (j !== -1 && j < end && j > at + 1) {
        flush(at);
        out.push('<code>', escapeHtml(s.slice(at + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else {
        // No closer: the backtick is itself; it stays in the plain run.
        i = at + 1;
      }
      continue;
    }
    if (code === 42) {
      if (at + 1 < end && s.charCodeAt(at + 1) === 42) {
        const j = findUnescaped(s, '**', at + 2, end);
        if (j > at + 2) {
          flush(at);
          out.push('<strong>');
          inlineRange(s, at + 2, j, link, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else {
          // No closer: "**" is itself; it stays in the plain run.
          i = at + 2;
        }
        continue;
      }
      const j = findSingleStar(s, at + 1, end);
      if (j > at + 1) {
        flush(at);
        out.push('<em>');
        inlineRange(s, at + 1, j, link, out);
        out.push('</em>');
        i = j + 1;
        run = i;
      } else {
        // No closer: the "*" is itself; it stays in the plain run.
        i = at + 1;
      }
      continue;
    }
    if (code === 91) {
      const k = findUnescaped(s, ']', at + 1, end);
      const mm = k !== -1 && k + 1 < end && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const hasTarget = mm !== -1 && mm < end && mm > k + 2 && !hasWS(s, k + 2, mm);
      if (hasTarget) {
        flush(at);
        const target = s.slice(k + 2, mm);
        out.push('<a href="', escapeHtml(link(target)), '">');
        inlineRange(s, at + 1, k, link, out);
        out.push('</a>');
        i = mm + 1;
        run = i;
      } else {
        // No link: the "[" is itself; it stays in the plain run.
        i = at + 1;
      }
      continue;
    }
    // Backslash before a non-escapable character: itself, still in the run.
    i = at + 1;
  }
  flush(end);
}

/** `s` rendered inline as one string. */
function inlineStr(s, link) {
  // No inline special at all: the text is already its own rendering.
  INLINE_NEXT.lastIndex = 0;
  if (INLINE_NEXT.exec(s) === null) return s;
  const out = [];
  inlineRange(s, 0, s.length, link, out);
  return out.join('');
}

/**
 * `lines[from..to)` rendered: its HTML (each block on its own lines, a
 * "\n" after the last), its table of contents and its excerpt (the first
 * paragraph's inline HTML, or ""). `link` resolves link targets.
 * Blocks are dispatched on the line's first character, so most lines
 * take one comparison instead of six block tests.
 */
function renderMarkdown(lines, from, to, link, slugCache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = from;
  while (i < to) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line.length === 0 || c0 === 32 || c0 === 9) {
      if (isBlank(line)) { i++; continue; }
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < to && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        let code = `<pre><code${cls}>`;
        for (const l of body) code += `${escapeHtml(l)}\n`;
        blocks.push(`${code}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugCache), ids);
        const html = inlineStr(heading.text, link);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      if (bulletOf(line) !== null) {
        const items = [];
        while (i < to) {
          const l = lines[i];
          const m = bulletOf(l);
          if (m !== null) { items.push([trimLine(m)]); i++; continue; }
          if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        let html = '<ul>\n';
        for (const parts of items) html += `<li>${inlineStr(parts.join('\n'), link)}</li>\n`;
        blocks.push(`${html}</ul>`);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < to && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.startsWith('> ') ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else blocks.push(`<blockquote>\n<p>${inlineStr(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const first = orderedOf(line);
      if (first !== null) {
        const items = [];
        let start = first.num;
        while (i < to) {
          const l = lines[i];
          const m = orderedOf(l);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
          if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        let html = `${open}\n`;
        for (const parts of items) html += `<li>${inlineStr(parts.join('\n'), link)}</li>\n`;
        blocks.push(`${html}</ol>`);
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line,
    // a fence, a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < to) {
      const l = lines[i];
      const d0 = l.charCodeAt(0);
      if (l.length === 0 || d0 === 32 || d0 === 9) {
        if (isBlank(l)) break;
      } else if (d0 === 96) {
        if (fenceLang(l) !== null) break;
      } else if (d0 === 35) {
        if (headingOf(l) !== null) break;
      } else if (d0 === 45 || d0 === 42) {
        if (isHR(l)) break;
      }
      body.push(trimLine(l));
      i++;
    }
    const text = body.join('\n');
    const html = inlineStr(text, link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Is `s` all spaces/tabs in [from, to)? */
function allSpaceTab(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = allSpaceTab(src, lineStart, open) && allSpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope stack: first name from the nearest scope holding it, then own properties. */
function scopeGet(S, path) {
  let v;
  let found = false;
  for (let i = S.length - 1; i >= 0; i--) {
    const o = S[i];
    if (Object.hasOwn(o, path[0])) { v = o[path[0]]; found = true; break; }
  }
  if (!found) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** One-segment path. */
function get1(S, a) {
  for (let i = S.length - 1; i >= 0; i--) {
    const o = S[i];
    if (Object.hasOwn(o, a)) return o[a];
  }
  return undefined;
}

/** Two-segment path. */
function get2(S, a, b) {
  for (let i = S.length - 1; i >= 0; i--) {
    const o = S[i];
    if (Object.hasOwn(o, a)) {
      const v = o[a];
      return v !== null && typeof v === 'object' && Object.hasOwn(v, b) ? v[b] : undefined;
    }
  }
  return undefined;
}

/** Three-segment path. */
function get3(S, a, b, c) {
  for (let i = S.length - 1; i >= 0; i--) {
    const o = S[i];
    if (Object.hasOwn(o, a)) {
      let v = o[a];
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
      v = v[b];
      return v !== null && typeof v === 'object' && Object.hasOwn(v, c) ? v[c] : undefined;
    }
  }
  return undefined;
}

const RT = { esc: escapeHtml, txt: textOf, truthy, get: scopeGet, g1: get1, g2: get2, g3: get3 };

/**
 * Compile parsed `nodes` to a render function (R, S, O, C, D):
 * R runtime helpers, S scope stack, O output array, C compiled
 * templates by name, D include depth. Returns the function.
 */
/**
 * Compile parsed `nodes` to a render function (R, S, C, D) returning the
 * rendered string: R runtime helpers, S scope stack, C compiled templates
 * by name, D include depth. Paths resolve through length-specialised
 * lookups; output accumulates in one string.
 */
function compileTemplate(nodes) {
  let tmp = 0;
  const pathExpr = (p) =>
    p.length === 1 ? `R.g1(S,${JSON.stringify(p[0])})`
    : p.length === 2 ? `R.g2(S,${JSON.stringify(p[0])},${JSON.stringify(p[1])})`
    : p.length === 3 ? `R.g3(S,${JSON.stringify(p[0])},${JSON.stringify(p[1])},${JSON.stringify(p[2])})`
    : `R.get(S,${JSON.stringify(p)})`;
  const gen = (ns, out) => {
    for (const n of ns) {
      if (n.kind === 'text') out.push(`O+=${JSON.stringify(n.text)};`);
      else if (n.kind === 'var') out.push(`O+=R.esc(R.txt(${pathExpr(n.path)}));`);
      else if (n.kind === 'raw') out.push(`O+=R.txt(${pathExpr(n.path)});`);
      else if (n.kind === 'if') {
        out.push(`if(R.truthy(${pathExpr(n.path)})!==${n.not}){`);
        gen(n.then, out);
        out.push('}');
        if (n.else !== null) {
          out.push('else{');
          gen(n.else, out);
          out.push('}');
        }
      } else if (n.kind === 'for') {
        const x = `X${tmp}`;
        const k = `K${tmp}`;
        const v = `V${tmp}`;
        tmp++;
        if (n.name === 'loop') {
          // A loop variable named "loop" would collide with the loop
          // record itself: keep the reference's fresh object per item.
          out.push(`{const ${x}=${pathExpr(n.path)};if(Array.isArray(${x})){for(let ${k}=0;${k}<${x}.length;${k}++){S.push({[${JSON.stringify(n.name)}]:${x}[${k}],loop:{index:${k}+1,first:${k}===0,last:${k}===${x}.length-1,length:${x}.length}});`);
          gen(n.body, out);
          out.push('S.pop();}}}');
        } else {
          // One scope object per loop execution, its element and loop
          // record rewritten per item: the body renders synchronously,
          // so nothing can observe a stale item.
          out.push(`{const ${x}=${pathExpr(n.path)};if(Array.isArray(${x})){const ${v}={[${JSON.stringify(n.name)}]:null,loop:{index:1,first:true,last:false,length:${x}.length}};for(let ${k}=0;${k}<${x}.length;${k}++){${v}[${JSON.stringify(n.name)}]=${x}[${k}];${v}.loop.index=${k}+1;${v}.loop.first=${k}===0;${v}.loop.last=${k}===${x}.length-1;S.push(${v});`);
          gen(n.body, out);
          out.push('S.pop();}}}');
        }
      } else if (n.kind === 'include') {
        out.push(`{if(D<${INCLUDE_DEPTH}){const T=C.get(${JSON.stringify(n.name)});if(T!==undefined){if(D<4&&K.has(${JSON.stringify(n.name)}))O+=K.get(${JSON.stringify(n.name)});else O+=T(R,S,C,D+1,K);}}}`);
      }
    }
  };
  const parts = [];
  gen(nodes, parts);
  return new Function('R', 'S', 'C', 'D', 'K', `let O="";${parts.join('')}return O;`);
}

/**
 * A template's free first-names: the names its paths read that no
 * enclosing for binds, following includes in the same scope. `bound`
 * holds the names bound where the walk stands. Include cycles stop
 * at depth 8, where rendering stops too. Also returns the deepest
 * include nesting met.
 */
function freeNames(nodes, bound, out, depth, parsed) {
  let maxDepth = depth;
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
    }
    if (n.kind === 'if') {
      maxDepth = Math.max(maxDepth, freeNames(n.then, bound, out, depth, parsed));
      if (n.else !== null) maxDepth = Math.max(maxDepth, freeNames(n.else, bound, out, depth, parsed));
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      maxDepth = Math.max(maxDepth, freeNames(n.body, inner, out, depth, parsed));
    } else if (n.kind === 'include') {
      if (depth < 8) {
        const t = parsed.get(n.name);
        if (t !== undefined) maxDepth = Math.max(maxDepth, freeNames(t, bound, out, depth + 1, parsed));
      }
    }
  }
  return maxDepth;
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from a source's directory segments, or null when it climbs out of the root. */
function resolvePath(parts, rel) {
  const out = parts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const report = [];
  const templates = new Map();
  const parsed = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      parsed.set(name, nodes);
      templates.set(name, compileTemplate(nodes));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, text, lines: text.split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in the reference's check order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyFrom = fm.bodyFrom;
    // The body's words, counted by one scan over the body text: the
    // body starts just past the front matter's closing line.
    let off = 0;
    for (let k = 0; k < fm.bodyFrom; k++) off += s.lines[k].length + 1;
    s.words = wordsIn(s.text, off);
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dirParts, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.lines, s.bodyFrom, s.lines.length, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name, slug });
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, pages, and the render context.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const rootVars = { site, tags: allTags, recent };
  // Templates that read only the case's constants (site, tags, recent)
  // render the same on every page: render each once and reuse the
  // string at every include site (their include nesting stays shallow
  // enough that the depth cutoff can never change the result).
  const consts = new Map();
  for (const name of parsed.keys()) {
    const names = new Set();
    const depth = freeNames(parsed.get(name), new Set(), names, 0, parsed);
    let ok = depth <= 4;
    if (ok) for (const n of names) if (n !== 'site' && n !== 'tags' && n !== 'recent') { ok = false; break; }
    if (ok) consts.set(name, templates.get(name)(RT, [rootVars, {}], templates, 0, consts));
  }
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    return fn(RT, [rootVars, vars], templates, 0, consts);
  };

  // 7. Every page through its layout, the index pages and the tag pages.
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}




