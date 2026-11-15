// A small reader for Valve's text KeyValues format (.vdf and .acf files).
// Pure text in, nested maps out; it never touches the disk. Valve mixes the
// case of keys between files and versions ("Apps" / "apps"), so lookups go
// through the case-insensitive helpers below.

export type VdfValue = string | VdfObject;
export type VdfObject = Map<string, VdfValue>;

type Token = { kind: 'string'; text: string } | { kind: 'open' } | { kind: 'close' };

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

function tokenize(input: string): Token[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (isSpace(ch)) {
      i += 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (ch === '{') {
      tokens.push({ kind: 'open' });
      i += 1;
    } else if (ch === '}') {
      tokens.push({ kind: 'close' });
      i += 1;
    } else if (ch === '"') {
      i += 1;
      let out = '';
      let closed = false;
      while (i < text.length) {
        const c = text[i];
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (c === '\\' && i + 1 < text.length) {
          const next = text[i + 1];
          if (next === 'n') out += '\n';
          else if (next === 't') out += '\t';
          else if (next === '\\') out += '\\';
          else if (next === '"') out += '"';
          else out += c + next;
          i += 2;
        } else {
          out += c;
          i += 1;
        }
      }
      if (!closed) throw new Error('Unterminated quoted string in VDF text.');
      tokens.push({ kind: 'string', text: out });
    } else {
      const start = i;
      while (i < text.length && !isSpace(text[i]) && text[i] !== '{' && text[i] !== '}' && text[i] !== '"') i += 1;
      const word = text.slice(start, i);
      // A platform conditional like [$WIN32] is not a key or a value.
      if (/^\[.*\]$/.test(word)) continue;
      tokens.push({ kind: 'string', text: word });
    }
  }
  return tokens;
}

/** Parses VDF text into nested maps. Throws an Error when the text is malformed. */
export function parseVdf(input: string): VdfObject {
  const tokens = tokenize(input);
  let pos = 0;

  const parseObject = (depth: number): VdfObject => {
    const obj: VdfObject = new Map();
    for (;;) {
      const keyTok = tokens[pos];
      if (!keyTok) {
        if (depth > 0) throw new Error('VDF text ended inside a block.');
        return obj;
      }
      pos += 1;
      if (keyTok.kind === 'close') {
        if (depth === 0) throw new Error('Unexpected "}" in VDF text.');
        return obj;
      }
      if (keyTok.kind === 'open') throw new Error('Unexpected "{" in VDF text.');
      const valueTok = tokens[pos];
      if (!valueTok) throw new Error(`VDF key "${keyTok.text}" has no value.`);
      pos += 1;
      if (valueTok.kind === 'open') obj.set(keyTok.text, parseObject(depth + 1));
      else if (valueTok.kind === 'string') obj.set(keyTok.text, valueTok.text);
      else throw new Error(`VDF key "${keyTok.text}" has no value.`);
    }
  };

  return parseObject(0);
}

/** The value for a key, ignoring case. */
export function vdfGet(obj: VdfObject | undefined, key: string): VdfValue | undefined {
  if (!obj) return undefined;
  const direct = obj.get(key);
  if (direct !== undefined) return direct;
  const lower = key.toLowerCase();
  for (const [k, v] of obj) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export function vdfObject(obj: VdfObject | undefined, key: string): VdfObject | undefined {
  const v = vdfGet(obj, key);
  return typeof v === 'object' ? v : undefined;
}

export function vdfString(obj: VdfObject | undefined, key: string): string | undefined {
  const v = vdfGet(obj, key);
  return typeof v === 'string' ? v : undefined;
}

/** Follows a chain of keys (ignoring case) down through nested blocks. */
export function vdfPath(obj: VdfObject | undefined, keys: string[]): VdfObject | undefined {
  let cur = obj;
  for (const k of keys) cur = vdfObject(cur, k);
  return cur;
}
