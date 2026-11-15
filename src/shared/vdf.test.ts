import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVdf, vdfGet, vdfObject, vdfPath, vdfString } from './vdf';

test('the new libraryfolders layout parses into nested blocks', () => {
  const doc = parseVdf(`"libraryfolders"
{
  "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" "apps" { "10" "123" } }
  "1" { "path" "D:\\\\SteamLibrary" }
}`);
  const root = vdfObject(doc, 'LibraryFolders');
  assert.equal(vdfString(vdfObject(root, '0'), 'path'), 'C:\\Program Files (x86)\\Steam');
  assert.equal(vdfString(vdfObject(root, '1'), 'path'), 'D:\\SteamLibrary');
  assert.equal(vdfString(vdfPath(root, ['0', 'apps']), '10'), '123');
});

test('the old layout has plain string values', () => {
  const doc = parseVdf('"LibraryFolders"\n{\n\t"TimeNextStatsReport"\t\t"1"\n\t"1"\t\t"D:\\\\SteamLibrary"\n}');
  assert.equal(vdfString(vdfObject(doc, 'libraryfolders'), '1'), 'D:\\SteamLibrary');
});

test('escapes, unquoted tokens, comments and conditionals', () => {
  const doc = parseVdf('// header\n"a" { "q" "say \\"hi\\"\\n\\ttab" bare word "k" "v" [$WIN32]\n "gone" "x" } // tail\n');
  const a = vdfObject(doc, 'a');
  assert.equal(vdfString(a, 'q'), 'say "hi"\n\ttab');
  assert.equal(vdfString(a, 'bare'), 'word');
  assert.equal(vdfString(a, 'k'), 'v');
  assert.equal(vdfString(a, 'gone'), 'x');
});

test('a BOM and CRLF line endings are fine, and lookups ignore case', () => {
  const doc = parseVdf('\uFEFF"Root"\r\n{\r\n"Apps"\r\n{\r\n"1" "x"\r\n}\r\n}\r\n');
  assert.equal(vdfString(vdfObject(vdfObject(doc, 'root'), 'apps'), '1'), 'x');
  assert.equal(vdfGet(doc, 'nope'), undefined);
});

test('malformed text throws a clear error', () => {
  assert.throws(() => parseVdf('"a" {'), /ended inside a block/);
  assert.throws(() => parseVdf('"a" { "b" }'), /no value/);
  assert.throws(() => parseVdf('"a" "unterminated'), /Unterminated/);
  assert.throws(() => parseVdf('}'), /Unexpected/);
  assert.throws(() => parseVdf('"a"'), /no value/);
});
