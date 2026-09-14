import { expect, spyOn, test } from 'bun:test';
import * as markdownParser from 'mdast-util-from-markdown';
import { SourceSession, type SourceBlock } from '../app/markdown-source';
import { CORPUS } from './markdown-corpus';
const clone = (blocks: SourceBlock[]) => structuredClone(blocks);
const prose = (block: SourceBlock, text: string) => { block.content = [{ type: 'text', text, styles: {} }]; };
const corpus = ['', '\n\n', '\uFEFF# Heading\r\n\r\nHello  \r\nworld\n', '---\ntitle: Hi\n---\n\nText\n', '~~~age\nARMOR\n~~~\n', '- one\n  - two\n\n- [x] task\n', '| a | b |\n| - | - |\n| c | d |\n', '> quote\n> second\n', '[ref][id]\n\n[id]: https://example.com\n', '<div>raw</div>\n', '[[doc]] **bold** `[[code]]` [link](https://example.com)\n'];
test('unchanged source retains exact bytes', () => { for (const text of corpus) { const s = new SourceSession(text); expect(s.serialize(s.blocks)).toBe(text); } });
test('existing acceptance corpus retains exact bytes', () => { for (const { bytes } of CORPUS) { const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes); const s = new SourceSession(text); expect(s.serialize(s.blocks)).toBe(text); } });
test('an empty mermaid fence is a code block, not a diagram', () => { const s = new SourceSession('```mermaid\n```\n\n```mermaid\ngraph TD;\n```\n'); expect(s.blocks.map(b => b.type)).toEqual(['codeBlock', 'diagram']); expect(s.blocks[0].props.language).toBe('mermaid'); expect(s.serialize([{ ...clone(s.blocks)[0], id: 'fresh' }, s.blocks[1]])).toBe('```mermaid\n```\n\n```mermaid\ngraph TD;\n```\n'); });
test('edits preserve unrelated metadata, secrets and unsupported source', () => { const raw = '---\nx: y\n---\n\nFirst\n\n```age\nARMOR\n```\n\n<div>x</div>\n'; const s = new SourceSession(raw); const b = clone(s.blocks); prose(b[1], 'Changed'); expect(s.serialize(b)).toBe(raw.replace('First', 'Changed')); });
test('deleting and reordering never resurrects groups; undo preserves original', () => { const s = new SourceSession('one\n\n\ntwo\n\nthree'); expect(s.serialize([s.blocks[2], s.blocks[0]])).toBe('three\n\none'); expect(s.serialize(s.blocks)).toBe(s.markdown); });
test('literal Markdown punctuation is escaped by standard serializer', () => { const s = new SourceSession('before\n'); const b = clone(s.blocks); prose(b[0], '# title *literal* [no](link)'); const result = new SourceSession(s.serialize(b)); expect(result.blocks[0].type).toBe('paragraph'); expect(result.blocks[0].content).toEqual(b[0].content); });
test('edited nested task list keeps hierarchy and contiguous siblings', () => { const s = new SourceSession('- [ ] first\n  - nested\n- [x] second\n\nAfter\n'); const b = clone(s.blocks); b[0].props.checked = true; const out = s.serialize(b); expect(out).toContain('- [x] first'); expect(out).toContain('  - nested'); expect(out).toEndWith('\n\nAfter\n'); });
test('wiki atoms are excluded from code and links', () => { const s = new SourceSession('[[a]] `[[b]]` [x [[c]]](https://example.com)'); const content = s.blocks[0].content as Array<{type: string}>; expect(content.filter(x => x.type === 'wikiLink')).toHaveLength(1); });
test('metadata movement and protected transformations are rejected', () => { const s = new SourceSession('---\na: b\n---\n\ntext'); expect(() => s.serialize([...s.blocks].reverse())).toThrow(); const b = clone(s.blocks); b[0].type = 'paragraph'; expect(() => s.serialize(b)).toThrow(); });
test('duplicate secret edits target stable IDs after reorder', () => { const s = new SourceSession('```age\nSAME\n```\n\n```age\nSAME\n```\n'); const b = clone(s.blocks).reverse(); const id = b[0].id; const out = s.replaceSecret(id, 'NEW', b); expect(out).toBe('```age\nNEW\n```\n\n```age\nSAME\n```\n'); expect(s.range(id, b)?.line).toBe(1); });
test('wiki syntax survives edits in its paragraph', () => { const s = new SourceSession('[[a]] before'); const b = clone(s.blocks); (b[0].content as import('../app/markdown-source').Inline[]).push({ type: 'text', text: ' after', styles: {} }); expect(s.serialize(b)).toBe('[[a]] before after'); });
test('editing preserves native CRLF separators and final newline', () => { const s = new SourceSession('one\r\n\r\n\r\ntwo\r\n'); const b = clone(s.blocks); prose(b[0], 'new'); expect(s.serialize(b)).toBe('new\r\n\r\n\r\ntwo\r\n'); });
test('split and join do not reintroduce deleted list items', () => { const s = new SourceSession('- first\n- second\n- third\n\nAfter'); const b = clone(s.blocks); b[1].type = 'paragraph'; expect(s.serialize(b)).toBe('- first\n\nsecond\n\n- third\n\nAfter'); expect(s.serialize([b[0], b[2], b[3]])).toBe('- first\n- third\n\nAfter'); });
test('nested secrets and unsupported inlines protect their whole source group', () => { for (const raw of ['- before\n\n  ```age\n  ARMOR\n  ```\n', '> ```age\n> ARMOR\n> ```\n', '![alt](image.png)\n', 'one  \ntwo\n']) { const s = new SourceSession(raw); expect(s.blocks[0].type).toBe('source'); expect(s.serialize(s.blocks)).toBe(raw); } });
test('links the editor may not make actionable keep their bytes, unreachable', () => { for (const raw of ['See [repo](ssh://git@host/x.git) here.', '[bad](javascript:alert)']) { const s = new SourceSession(raw); expect(s.blocks[0].type).toBe('source'); expect(s.blocks[0].content).toBeUndefined(); expect(s.serialize(s.blocks)).toBe(raw); } });
test('unsupported visual formatting is rejected', () => { const s = new SourceSession('text'); const b = clone(s.blocks); (b[0].content as import('../app/markdown-source').Inline[])[0] = { type: 'text', text: 'text', styles: { underline: true } }; expect(() => s.serialize(b)).toThrow(); });
test('nested age controls preserve prefixes and identify duplicate protected groups', () => {
  for (const prefix of ['  ', '> ']) {
    const raw = prefix === '  ' ? '- item\n\n  ```age\n  OLD\n  ```' : '> ```age\n> OLD\n> ```';
    const s = new SourceSession(raw + '\n\nBetween\n\n' + raw + '\n');
    const b = clone(s.blocks).reverse();
    const secrets = s.secrets(b);
    expect(secrets).toHaveLength(2);
    expect(secrets[0].ciphertext).toBe(prefix + 'OLD');
    expect(secrets[0].indent).toBe(prefix);
    const out = s.replaceSecret(secrets[0].id, prefix + 'NEW\n' + prefix + 'MORE', b);
    expect(out).toBe(raw.replace(prefix + 'OLD', prefix + 'NEW\n' + prefix + 'MORE') + '\n\nBetween\n\n' + raw + '\n');
    expect(s.secrets(b)[0].id).toBe(secrets[0].id);
    expect(s.serialize(s.blocks)).toBe(s.markdown);
    expect(s.sourceParts(b[0].id, b).filter(part => 'secret' in part)).toHaveLength(1);
  }
});
test('top-level indented age replacement preserves fence and body prefixes', () => {
  const s = new SourceSession('  ```age\n  OLD\n  ```\n');
  const b = clone(s.blocks);
  expect(s.secrets(b)[0].ciphertext).toBe('  OLD');
  expect(s.replaceSecret(b[0].id, '  NEW', b)).toBe('  ```age\n  NEW\n  ```\n');
});
test('duplicated protected groups support secret replacement and remain protected', () => {
  const raw = '> ```age\n> OLD\n> ```';
  const s = new SourceSession(raw + '\n');
  const duplicate = { ...structuredClone(s.blocks[0]), id: 'duplicate-source' };
  const blocks = [...clone(s.blocks), duplicate];
  const secret = s.secrets(blocks).find(entry => entry.blockId === duplicate.id)!;
  expect(s.replaceSecret(secret.id, '> NEW', blocks)).toBe(raw + '\n\n' + raw.replace('OLD', 'NEW') + '\n');
  duplicate.props.source = '> arbitrary change';
  expect(() => s.serialize(blocks)).toThrow('Protected source');
});
test('changing a heading to prose keeps separate paragraphs at a tight boundary', () => {
  for (const newline of ['\n', '\r\n']) {
    const session = new SourceSession(`# Title${newline}Body${newline}`);
    const blocks = clone(session.blocks);
    blocks[0].type = 'paragraph';
    const output = session.serialize(blocks);
    expect(new SourceSession(output).blocks.map(block => block.type)).toEqual(['paragraph', 'paragraph']);
    expect(output).toBe(`Title${newline}${newline}Body${newline}`);
  }
});
test('EOF-dependent groups cannot move before prose and consume it', () => {
  for (const tail of ['<!-- unfinished', '```age\nARMOR']) {
    const raw = `Before\n\n${tail}`;
    const session = new SourceSession(raw);
    expect(() => session.serialize([...session.blocks].reverse())).toThrow('Source');
    expect(session.serialize(session.blocks)).toBe(raw);
  }
});
test('moving an unclosed supported code block closes it without swallowing prose', () => {
  const session = new SourceSession('Before\n\n```js\nunfinished');
  const output = session.serialize([...session.blocks].reverse());
  expect(output).toBe('```js\nunfinished\n```\n\nBefore');
  expect(new SourceSession(output).blocks.map(block => block.type)).toEqual(['codeBlock', 'paragraph']);
  expect(session.serialize(session.blocks)).toBe(session.markdown);
});
test('ordered tasks stay protected rather than turning into unordered tasks', () => {
  const raw = '3. [ ] first\n4. [x] second\n\nAfter';
  const session = new SourceSession(raw);
  expect(session.blocks[0].type).toBe('source');
  const blocks = clone(session.blocks);
  prose(blocks[1], 'Changed');
  expect(session.serialize(blocks)).toBe(raw.replace('After', 'Changed'));
});
test('escaped and entity wiki punctuation stays literal after nearby edits', () => {
  for (const literal of ['\\[\\[literal\\]\\]', '&#91;&#91;literal&#93;&#93;']) {
    const session = new SourceSession(`${literal} before`);
    const blocks = clone(session.blocks);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].content).toEqual([{ type: 'text', text: '[[literal]] before', styles: {} }]);
    (blocks[0].content as import('../app/markdown-source').Inline[]).push({ type: 'text', text: ' after', styles: {} });
    const reloaded = new SourceSession(session.serialize(blocks));
    expect(reloaded.blocks[0].content).toEqual([{ type: 'text', text: '[[literal]] before after', styles: {} }]);
  }
});
test('automatic trailing empty paragraphs do not close or move EOF-dependent blocks', () => {
  for (const tail of ['<!-- unfinished', '```age\nARMOR', '```js\nunfinished']) {
    const session = new SourceSession(`Before\n\n${tail}`);
    const blocks = clone(session.blocks);
    blocks.push({ id: 'empty-tail', type: 'paragraph', props: {}, content: [], children: [] });
    expect(session.serialize(blocks)).toBe(session.markdown);
    prose(blocks[0], 'Changed');
    expect(session.serialize(blocks)).toBe(session.markdown.replace('Before', 'Changed'));
    expect(session.sourceParts(blocks[1].id, blocks).length).toBeGreaterThan(0);
    if (blocks[1].type !== 'codeBlock') {
      prose(blocks[2], 'Following prose');
      expect(() => session.serialize(blocks)).toThrow('Source');
    }
  }
});
test('ambiguous escaped and genuine wiki mixtures stay protected', () => {
  const raw = '\\[\\[literal\\]\\] and [[actual]]';
  const session = new SourceSession(raw);
  expect(session.blocks[0].type).toBe('source');
  expect(session.serialize(session.blocks)).toBe(raw);
});
test('reordering delimiters cannot turn visible blocks into frontmatter', () => {
  for (const delimiter of ['---', '+++']) {
    const session = new SourceSession(`Before\n\n${delimiter}\n\nMiddle\n\n${delimiter}\n\nAfter`);
    const blocks = [session.blocks[1], session.blocks[2], session.blocks[3], session.blocks[0], session.blocks[4]];
    const output = session.serialize(blocks);
    const reloaded = new SourceSession(output);
    expect(reloaded.blocks).toHaveLength(5);
    expect(reloaded.blocks.some(block => block.props.metadata)).toBe(false);
    expect(output).toEndWith(`\n\nMiddle\n\n${delimiter}\n\nBefore\n\nAfter`);
    expect(session.serialize(session.blocks)).toBe(session.markdown);
  }
});
test('moving a closing delimiter after a leading delimiter cannot create metadata', () => {
  const session = new SourceSession('+++\n\nMiddle\n\nAfter');
  const blocks = clone(session.blocks);
  blocks.push({ id: 'closing-delimiter', type: 'paragraph', props: {}, content: [{ type: 'text', text: '+++', styles: {} }], children: [] });
  const output = session.serialize(blocks);
  expect(new SourceSession(output).blocks).toHaveLength(4);
  expect(new SourceSession(output).blocks.some(block => block.props.metadata)).toBe(false);
});
test('leading delimiters keep original bytes when surrounding edits do not create metadata', () => {
  for (const delimiter of ['---', '+++']) {
    const raw = `${delimiter}\r\n\r\nBefore\r\n`;
    const session = new SourceSession(raw);
    const blocks = clone(session.blocks);
    prose(blocks[1], 'Changed');
    expect(session.serialize(blocks)).toBe(raw.replace('Before', 'Changed'));
  }
});
test('normalizing a relocated leading delimiter preserves genuine wiki atoms', () => {
  const session = new SourceSession('Before\n\n+++\n[[target]]\n\n+++\n\nAfter');
  const output = session.serialize([session.blocks[1], session.blocks[2], session.blocks[0], session.blocks[3]]);
  expect(output).toContain('[[target]]');
  const reloaded = new SourceSession(output);
  expect((reloaded.blocks[0].content as import('../app/markdown-source').Inline[]).some(item => item.type === 'wikiLink' && item.props.target === 'target')).toBe(true);
  expect(reloaded.blocks.some(block => block.props.metadata)).toBe(false);
});
test('ordered lists starting at zero retain their start when text changes', () => {
  const session = new SourceSession('0. zero\n1. one\n');
  expect(session.blocks.map(block => block.props.start)).toEqual([0, 1]);
  const blocks = clone(session.blocks);
  prose(blocks[1], 'changed');
  expect(session.serialize(blocks)).toBe('0. zero\n1. changed\n');
});
test('normalizing a protected leading delimiter preserves its opaque remainder', () => {
  const protectedGroup = '+++\r\n![image](<some image.png>) [[target]]';
  const session = new SourceSession(`Before\r\n\r\n${protectedGroup}\r\n\r\n+++\r\n\r\nAfter`);
  expect(session.blocks[1].type).toBe('source');
  const output = session.serialize([session.blocks[1], session.blocks[2], session.blocks[0], session.blocks[3]]);
  expect(output).toStartWith('\\' + protectedGroup);
  expect(new SourceSession(output).blocks).toHaveLength(4);
});
test('original following siblings avoid redundant EOF parsing without trusting new source', () => {
  const session = new SourceSession('```age\nARMOR\n```\n\nAfter\n\n<!-- unfinished');
  const parser = spyOn(markdownParser, 'fromMarkdown');
  try {
    expect(session.requiresEndBlock(session.blocks[0].id)).toBe(false);
    expect(parser).not.toHaveBeenCalled();
    expect(session.requiresEndBlock(session.blocks[2].id)).toBe(true);
    expect(session.requiresEnd('```age\nCHANGED')).toBe(true);
    expect(parser).toHaveBeenCalledTimes(2);
  } finally { parser.mockRestore(); }
});
test('a BOM stays the first bytes of the file, whatever is edited above it', () => {
  const raw = '\uFEFF# Title\n\nFirst paragraph here.\n\n- one\n- two\n\nLast.\n';
  const session = new SourceSession(raw);
  expect(session.serialize(session.blocks)).toBe(raw);
  const blocks = clone(session.blocks);
  prose(blocks.at(-1)!, 'Last. edited.');
  expect(session.serialize(blocks)).toBe(raw.replace('Last.\n', 'Last. edited.\n'));
  const above: SourceBlock = { id: 'fresh-first', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Top', styles: {} }], children: [] };
  expect(session.serialize([above, ...clone(session.blocks)])).toBe('\uFEFFTop\n\n' + raw.slice(1));
});
test('a list item may not carry a non-list child out to Markdown', () => {
  const session = new SourceSession('- item\n- second\n');
  const blocks = clone(session.blocks);
  blocks[0].children = [{ id: 'child-paragraph', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'A paragraph', styles: {} }], children: [] }];
  expect(() => session.serialize(blocks)).toThrow('nesting requires Source');
});
test('an edited list leaves its neighbour list, its separators and its looseness alone', () => {
  const session = new SourceSession('1. a\n\n* b\n* c\n\n\nafter\n');
  const blocks = clone(session.blocks);
  prose(blocks[0], 'a edited');
  expect(session.serialize(blocks)).toBe('1. a edited\n\n* b\n* c\n\n\nafter\n');
  const loose = new SourceSession('* a\n\n* b\n\n* c\n');
  const items = clone(loose.blocks);
  prose(items[0], 'a edited');
  expect(loose.serialize(items)).toBe('- a edited\n\n- b\n\n- c\n');
});
test('a new item joins the list it was typed into, tight or loose', () => {
  const item = (type: string, text: string): SourceBlock => ({ id: `fresh-${text}`, type, props: {}, content: [{ type: 'text', text, styles: {} }], children: [] });
  const typed = (markdown: string, type: string) => {
    const session = new SourceSession(markdown);
    const blocks = clone(session.blocks);
    const last = blocks.findLastIndex(block => block.type === type);
    return session.serialize([...blocks.slice(0, last + 1), item(type, 'c'), ...blocks.slice(last + 1)]);
  };
  expect(typed('- a\n- b\n', 'bulletListItem')).toBe('- a\n- b\n- c\n');
  expect(typed('- a\n- b\n\nAfter\n', 'bulletListItem')).toBe('- a\n- b\n- c\n\nAfter\n');
  expect(typed('3. a\n4. b\n', 'numberedListItem')).toBe('3. a\n4. b\n5. c\n');
  expect(typed('- a\n\n- b\n', 'bulletListItem')).toBe('- a\n\n- b\n\n- c\n');
  const head = new SourceSession('- a\n- b\n');
  expect(head.serialize([item('bulletListItem', 'z'), ...clone(head.blocks)])).toBe('- z\n- a\n- b\n');
});

test("retained lists that become adjacent join one run; item-level looseness counts", () => {
  const item = (type: string, text: string): SourceBlock => ({ id: `fresh-${text}`, type, props: {}, content: [{ type: "text", text, styles: {} }], children: [] });
  const without = (markdown: string, drop: string) => {
    const session = new SourceSession(markdown);
    return session.serialize(clone(session.blocks).filter(block => !JSON.stringify(block.content).includes(drop)));
  };
  expect(without("1. a\n2. b\n\npara\n\n1. x\n2. y\n", "para")).toBe("1. a\n2. b\n3. x\n4. y\n");
  expect(without("- a\n- b\n\npara\n\n- x\n- y\n", "para")).toBe("- a\n- b\n- x\n- y\n");
  // two lists told apart only by their markers were adjacent already: appending reaches both
  const alt = new SourceSession("- a\n\n* b\n");
  expect(alt.serialize([...clone(alt.blocks), item("bulletListItem", "z")])).toBe("- a\n- b\n- z\n");
  // a blank line inside one item makes the list loose, whatever the list node reports
  const inner = new SourceSession("- a\n\n  - a1\n- b\n");
  expect(inner.serialize([...clone(inner.blocks), item("bulletListItem", "c")])).toBe("- a\n  - a1\n\n- b\n\n- c\n");
});
