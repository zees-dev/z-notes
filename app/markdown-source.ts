/* ============================================================
   markdown-source.ts — Markdown/source identity at the editor boundary.
   Untouched AST groups keep their bytes; only edited groups pass through
   the standard serializer. No editor state or decrypted secrets live here.
   ============================================================ */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';
import { frontmatterFromMarkdown, frontmatterToMarkdown } from 'mdast-util-frontmatter';

export type Inline = { type: 'text'; text: string; styles: Record<string, boolean | string> } |
  { type: 'link'; href: string; content: Inline[] } |
  { type: 'wikiLink'; props: { target: string } };
export type TableContent = { type: 'tableContent'; rows: { cells: (Inline[] | { type: 'tableCell'; content: Inline[]; props?: Record<string, unknown> })[] }[]; headerRows?: number };
export type SourceBlock = { id: string; type: string; props: Record<string, string | number | boolean>; content?: Inline[] | TableContent | string; children: SourceBlock[] };
type Node = { type: string; children?: Node[]; value?: string; url?: string; title?: string | null; depth?: number; ordered?: boolean; spread?: boolean; start?: number | null; checked?: boolean | null; lang?: string | null; meta?: string | null; align?: (string | null)[]; position?: { start: { offset: number }; end: { offset: number } } };
type Group = { start: number; end: number; blocks: SourceBlock[]; snapshot: string };
export type SecretIdentity = { id: string; blockId: string; ciphertext: string; indent: string; start: number; end: number; line: number };
type SecretSlice = { start: number; end: number; bodyStart: number; bodyEnd: number; ciphertext: string; indent: string };
let nextId = 0;
const block = (type: string, content?: SourceBlock['content'], props: SourceBlock['props'] = {}, children: SourceBlock[] = []): SourceBlock => ({ id: `md-${++nextId}`, type, props, ...(content === undefined ? {} : { content }), children });
const parse = (value: string) => fromMarkdown(value, { extensions: [gfm(), frontmatter(['yaml', 'toml'])], mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml', 'toml'])] }) as unknown as Node;
const print = (nodes: Node[]) => toMarkdown({ type: 'root', children: nodes } as Parameters<typeof toMarkdown>[0], { extensions: [gfmToMarkdown(), frontmatterToMarkdown(['yaml', 'toml'])], bullet: '-', fences: true, listItemIndent: 'one', handlers: { wikiLink: (node: { value?: string }) => node.value || '' } }).replace(/\n$/, '');
const safeUrl = (url: string) => {
  const normalized = url.replace(/[\u0000-\u0020]/g, '');
  return !/^[a-z][a-z0-9+.-]*:/i.test(normalized) || /^(https?|mailto|tel):/i.test(normalized);
};
const text = (value: string, styles: Record<string, boolean | string> = {}): Inline => ({ type: 'text', text: value, styles });
function inlines(nodes: Node[], source: string, styles: Record<string, boolean | string> = {}, wiki = true): Inline[] {
  return nodes.flatMap((node): Inline[] => {
    if (node.type === 'text') {
      if (!wiki) return [text(node.value || '', styles)];
      const raw = source.slice(node.position!.start.offset, node.position!.end.offset);
      if (raw !== node.value && /\[\[[^\]\n]+\]\]/.test(node.value || '')) {
        // MDAST decodes escapes and entities. Ambiguous mixtures stay protected.
        const rawLinks = Array.from(raw.matchAll(/(?<!\\)(?:\\\\)*(\[\[[^\]\\\n]+\]\])/g), match => match[1]);
        if (!rawLinks.length) return [text(node.value || '', styles)];
        if (JSON.stringify(rawLinks) !== JSON.stringify(node.value?.match(/\[\[[^\]\n]+\]\]/g))) throw new Error('Mixed escaped wiki-links require Source');
      }
      if (Object.keys(styles).length && /\[\[[^\]\n]+\]\]/.test(node.value || '')) throw new Error('Styled wiki-links require Source');
      return (node.value || '').split(/(\[\[[^\]\n]+\]\])/).filter(Boolean).map(value => value.startsWith('[[') && value.endsWith(']]') ? { type: 'wikiLink', props: { target: value.slice(2, -2) } } : text(value, styles));
    }
    if (node.type === 'inlineCode') return [text(node.value || '', { ...styles, code: true })];
    if (node.type === 'break') throw new Error('Hard breaks require Source');
    const style = ({ strong: 'bold', emphasis: 'italic', delete: 'strike' } as Record<string, string>)[node.type];
    if (style) return inlines(node.children || [], source, { ...styles, [style]: true }, wiki);
    // A scheme the editor may not make actionable is still the file's bytes: the
    // group stays protected rather than losing its destination on the next edit.
    if (node.type === 'link' && !node.title) {
      if (!safeUrl(node.url || '')) throw new Error('This link scheme requires Source');
      return [{ type: 'link', href: node.url || '', content: inlines(node.children || [], source, styles, false) }];
    }
    throw new Error(`Unsupported inline ${node.type}`);
  });
}
function importNode(node: Node, source: string, spread: Map<string, boolean>, nested = false): SourceBlock[] {
  const children = node.children || [];
  if (node.type === 'paragraph' || node.type === 'heading') return [block(node.type, inlines(children, source), node.type === 'heading' ? { level: node.depth || 1 } : {})];
  if (node.type === 'code') {
    if (node.meta || (nested && node.lang === 'age')) throw new Error('Protected code');
    if (node.lang === 'age') return [block('secret', undefined, { ciphertext: node.value || '' })];
    // An empty fence has no diagram in it: the block would paint its own "add one" placeholder over bytes the file does not have.
    if (node.lang === 'mermaid' && (node.value || '').trim()) return [block('diagram', node.value || '')];
    return [block('codeBlock', [text(node.value || '')], { language: node.lang || 'text' })];
  }
  if (node.type === 'blockquote' && children.length === 1 && children[0].type === 'paragraph') return [block('quote', inlines(children[0].children || [], source))];
  if (node.type === 'list') return children.map((item, index) => {
    const parts = item.children || [];
    if (node.ordered && typeof item.checked === 'boolean') throw new Error('Ordered tasks require Source');
    if (!parts.length || parts[0].type !== 'paragraph' || parts.slice(1).some(n => n.type !== 'list')) throw new Error('Complex list');
    const imported = block(typeof item.checked === 'boolean' ? 'checkListItem' : node.ordered ? 'numberedListItem' : 'bulletListItem', inlines(parts[0].children || [], source), typeof item.checked === 'boolean' ? { checked: item.checked } : node.ordered ? { start: (node.start ?? 1) + index } : {}, parts.slice(1).flatMap(n => importNode(n, source, spread, true)));
    // Looseness is the source list's, not the editor's: BlockNote has no prop
    // for it, so an edited item is reprinted from what the file already said.
    // A blank line inside one item makes the whole list loose, whatever the list node says.
    spread.set(imported.id, !!node.spread || (node.children || []).some(child => !!child.spread));
    return imported;
  });
  if (node.type === 'table' && !node.align?.some(Boolean)) return [block('table', { type: 'tableContent', headerRows: 1, rows: children.map(row => ({ cells: (row.children || []).map(cell => inlines(cell.children || [], source)) })) })];
  throw new Error(`Unsupported ${node.type}`);
}
function inlineNodes(content: SourceBlock['content']): Node[] {
  if (typeof content === 'string') return [{ type: 'text', value: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): Node[] => {
    if (item.type === 'wikiLink') return [{ type: 'wikiLink', value: `[[${item.props.target}]]` }];
    if (item.type === 'link') return safeUrl(item.href) ? [{ type: 'link', url: item.href, children: inlineNodes(item.content) }] : inlineNodes(item.content);
    if (item.type !== 'text') throw new Error('Unsupported inline content');
    if (Object.entries(item.styles).some(([key, value]) => value && !['bold', 'italic', 'strike', 'code'].includes(key))) throw new Error('This formatting requires Source');
    let node: Node = { type: item.styles.code ? 'inlineCode' : 'text', value: item.text };
    for (const [style, type] of [['bold', 'strong'], ['italic', 'emphasis'], ['strike', 'delete']]) if (item.styles[style]) node = { type, children: [node] };
    return [node];
  });
}
export const listItemTypes = ['bulletListItem', 'numberedListItem', 'checkListItem'];
const listType = (b: SourceBlock) => listItemTypes.includes(b.type);
const plain = (content: SourceBlock['content']): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(x => x.type === 'text' ? x.text : '').join('') : '';
function exportNodes(blocks: readonly SourceBlock[], loose: (block: SourceBlock) => boolean = () => false): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (listType(b)) {
      const items: Node[] = [];
      const ordered = b.type === 'numberedListItem';
      let spread = false;
      do {
        const item = blocks[i];
        // Only list items nest under a list item: any other child comes back from
        // Markdown as an unimportable group ('Complex list'), so it never goes out.
        if (item.children.some(child => !listType(child))) throw new Error('This nesting requires Source');
        spread = spread || loose(item);
        items.push({ type: 'listItem', spread: false, checked: item.type === 'checkListItem' ? !!item.props.checked : null, children: [{ type: 'paragraph', children: inlineNodes(item.content) }, ...exportNodes(item.children, loose)] });
        i++;
      } while (i < blocks.length && listType(blocks[i]) && (blocks[i].type === 'numberedListItem') === ordered);
      i--;
      nodes.push({ type: 'list', spread, ordered, start: ordered ? Number(b.props.start ?? 1) : undefined, children: items });
      continue;
    }
    if (b.children.length) throw new Error('This nesting requires Source');
    switch (b.type) {
      case 'paragraph': nodes.push({ type: 'paragraph', children: inlineNodes(b.content) }); break;
      case 'heading': nodes.push({ type: 'heading', depth: Number(b.props.level || 1), children: inlineNodes(b.content) }); break;
      case 'quote': nodes.push({ type: 'blockquote', children: [{ type: 'paragraph', children: inlineNodes(b.content) }] }); break;
      case 'codeBlock': nodes.push({ type: 'code', lang: String(b.props.language || '') === 'text' ? null : String(b.props.language || ''), value: plain(b.content) }); break;
      case 'diagram': nodes.push({ type: 'code', lang: 'mermaid', value: plain(b.content) }); break;
      case 'secret': nodes.push({ type: 'code', lang: 'age', value: String(b.props.ciphertext || '') }); break;
      case 'table': {
        const table = b.content as TableContent;
        nodes.push({ type: 'table', children: table.rows.map(row => ({ type: 'tableRow', children: row.cells.map(cell => ({ type: 'tableCell', children: inlineNodes(Array.isArray(cell) ? cell : cell.content) })) })) }); break;
      }
      default: throw new Error(`Edit ${b.type} in Source`);
    }
  }
  return nodes;
}
// Only Markdown-bearing props participate: BlockNote fills in presentation defaults.
function semantic(blocks: readonly SourceBlock[]): string {
  return JSON.stringify(blocks.map(b => ({ id: b.id, type: b.type, props: Object.fromEntries((({ heading: ['level'], numberedListItem: ['start'], checkListItem: ['checked'], codeBlock: ['language'], secret: ['ciphertext'], source: ['source', 'metadata'] } as Record<string, string[]>)[b.type] || []).map(k => [k, b.props[k] ?? (k === 'start' ? 1 : undefined)])), content: b.type === 'diagram' ? plain(b.content) : b.type === 'source' || b.type === 'secret' ? null : b.type === 'table' ? inlineTable(b.content as TableContent) : inlineNodes(b.content), children: JSON.parse(semantic(b.children || [])) })));
}
function inlineTable(table: TableContent) { return table.rows.map(row => row.cells.map(cell => inlineNodes(Array.isArray(cell) ? cell : cell.content))); }

// MDAST supplies fence boundaries even inside lists and quotes. Prefix extraction
// is only for retaining the bytes around a replacement body, never Markdown parsing.
function secretSlices(source: string): SecretSlice[] {
  const found: SecretSlice[] = [];
  const visit = (node: Node) => {
    if (node.type === 'code' && node.lang === 'age' && node.position) {
      const start = node.position.start.offset, end = node.position.end.offset;
      const openingEnd = source.indexOf('\n', start);
      if (openingEnd < 0 || openingEnd >= end) return;
      const bodyStart = openingEnd + 1;
      const lastLine = source.lastIndexOf('\n', end - 1) + 1;
      const closing = source.slice(lastLine, end).match(/[`~]{3,}[ \t]*$/);
      let bodyEnd = closing ? lastLine : end;
      if (source[bodyEnd - 1] === '\n') bodyEnd--;
      if (source[bodyEnd - 1] === '\r') bodyEnd--;
      bodyEnd = Math.max(bodyStart, bodyEnd);
      const ciphertext = source.slice(bodyStart, bodyEnd);
      const indent = ciphertext.match(/^[ \t>]*/)?.[0] || (closing ? source.slice(lastLine, lastLine + closing.index!) : '');
      found.push({ start, end, bodyStart, bodyEnd, ciphertext, indent });
    } else for (const child of node.children || []) visit(child);
  };
  visit(parse(source));
  return found;
}

export class SourceSession {
  readonly blocks: SourceBlock[];
  readonly markdown: string;
  private readonly groups: Group[];
  private readonly snapshot: string;
  private readonly allowedSource = new Map<string, Set<string>>();
  private readonly secretSource = new Map<string, Map<string, string>>();
  private readonly endRequired = new Map<string, boolean>();
  private readonly listSpread = new Map<string, boolean>();
  /* micromark strips a leading BOM before tokenising, so every offset it reports
     is into the text WITHOUT it. `body` is the text those offsets index; the BOM
     is a prefix of the file rather than of a group, so it is re-emitted first
     and can never travel with the block that happened to be written after it. */
  private readonly bom: string;
  private readonly body: string;
  constructor(markdown: string) {
    this.markdown = markdown;
    this.bom = markdown.startsWith('﻿') ? '﻿' : '';
    this.body = markdown.slice(this.bom.length);
    const body = this.body;
    const nodes = parse(body).children || [];
    this.groups = nodes.flatMap((node, index) => {
      const start = node.position!.start.offset, end = node.position!.end.offset;
      const gaps: Group[] = [];
      const previousNode = nodes[index - 1];
      // Same-family lists may merge when edited markers normalize; whitespace
      // between them cannot promise an independent paragraph.
      if (previousNode && !(node.type === 'list' && previousNode.type === 'list' && node.ordered === previousNode.ordered)) {
        // MDAST omits separators. Empty groups give extra space an editable
        // identity without owning its bytes; deleting one breaks adjacency.
        const previousEnd = previousNode.position!.end.offset;
        const newlines = [...body.slice(previousEnd, start).matchAll(/\n/g)];
        for (let i = 1; i < newlines.length - 1; i += 2) {
          const offset = previousEnd + newlines[i].index! + 1;
          const blocks = [block('paragraph', [])];
          gaps.push({ start: offset, end: offset, blocks, snapshot: semantic(blocks) });
        }
      }
      const metadata = node.type === 'yaml' || node.type === 'toml';
      let blocks: SourceBlock[];
      try { blocks = importNode(node, body, this.listSpread); } catch { blocks = [block('source', undefined, { source: body.slice(start, end), label: metadata ? 'Metadata' : 'Source', metadata })]; }
      if (blocks[0].type === 'source') this.allowedSource.set(blocks[0].id, new Set([semantic(blocks)]));
      if (blocks[0].type === 'secret') {
        const raw = body.slice(start, end);
        const secret = secretSlices(raw)[0];
        if (secret) blocks[0].props.ciphertext = secret.ciphertext;
        this.secretSource.set(blocks[0].id, new Map([[String(blocks[0].props.ciphertext), raw]]));
      }
      // A following MDAST sibling already proves this retained group can end.
      if (index < nodes.length - 1 && ['source', 'secret', 'codeBlock', 'diagram'].includes(blocks[0].type)) this.endRequired.set(body.slice(start, end), false);
      return [...gaps, { start, end, blocks, snapshot: semantic(blocks) }];
    });
    this.blocks = this.groups.flatMap(g => g.blocks);
    this.snapshot = semantic(this.blocks);
  }
  serialize(blocks: readonly SourceBlock[]): string { return this.render(blocks).markdown; }
  requiresEnd(source: string): boolean {
    if (!this.endRequired.has(source)) {
      const nodes = parse(source + '\n\nznotes-boundary-probe').children || [];
      this.endRequired.set(source, nodes.at(-1)?.position?.start.offset !== source.length + 2);
    }
    return this.endRequired.get(source)!;
  }
  requiresEndBlock(blockId: string): boolean {
    const group = this.groups.find(group => group.blocks.some(block => block.id === blockId));
    return !!group && this.requiresEnd(this.body.slice(group.start, group.end));
  }
  private render(blocks: readonly SourceBlock[], normalizeLeading = false): { markdown: string; ranges: Map<string, { start: number; end: number; line: number }> } {
    // BlockNote appends an empty paragraph after atoms. It is not prose after
    // an EOF-dependent source group until the user types into it.
    let end = blocks.length;
    while (end && blocks[end - 1].type === 'paragraph' && !blocks[end - 1].children.length && Array.isArray(blocks[end - 1].content) && (blocks[end - 1].content as Inline[]).every(item => item.type === 'text' && !item.text)) end--;
    const last = blocks[end - 1];
    const ranges = new Map<string, { start: number; end: number; line: number }>();
    const known = new Map(this.groups.flatMap((g, index) => g.blocks.map(b => [b.id, { g, index }] as const)));
    const seen = new Set<string>();
    const validate = (items: readonly SourceBlock[], depth: number) => { for (const b of items) {
      if (seen.has(b.id)) throw new Error('Duplicate block identity'); seen.add(b.id);
      const original = known.get(b.id)?.g;
      if (b.props.textAlignment && b.props.textAlignment !== 'left') throw new Error('Alignment requires Source');
      if (['textColor', 'backgroundColor'].some(key => b.props[key] && b.props[key] !== 'default')) throw new Error('Colors require Source');
      if (this.allowedSource.has(b.id) && !this.allowedSource.get(b.id)!.has(semantic([b]))) throw new Error('Protected source requires Source editing');
      if (original?.blocks[0].type === 'secret' && b.type !== 'secret') throw new Error('Secret conversion requires Source');
      if (['source', 'secret'].includes(b.type) && depth) throw new Error('Protected blocks cannot be nested');
      if (b.type === 'source' && b.props.metadata && blocks[0]?.id !== b.id) throw new Error('Metadata must remain first');
      validate(b.children || [], depth + 1);
      // Duplicate/paste creates a new identity whose first accepted source is
      // its protected baseline; only replaceSecret may authorize later edits.
      if (b.type === 'source' && !this.allowedSource.has(b.id)) this.allowedSource.set(b.id, new Set([semantic([b])]));
    } };
    validate(blocks, 0);
    if (end < blocks.length && last && (last.type === 'source' ? this.requiresEnd(String(last.props.source)) : ['secret', 'codeBlock', 'diagram'].includes(last.type) && this.requiresEndBlock(last.id))) blocks = blocks.slice(0, end);
    const emit = (items: readonly SourceBlock[]) => print(exportNodes(items, item => this.listSpread.get(item.id) === true));
    /* The group this block still opens unchanged, if it does: its bytes are kept
       verbatim, so nothing printed may reach across it. */
    const retainedGroup = (index: number) => {
      const held = known.get(blocks[index].id);
      return held && held.g.blocks[0].id === blocks[index].id && semantic(blocks.slice(index, index + held.g.blocks.length)) === held.g.snapshot ? held : undefined;
    };
    const heldGroups = new Map<number, NonNullable<ReturnType<typeof retainedGroup>>>();
    const covered = new Array<number>(blocks.length).fill(-1);
    for (let i = 0; i < blocks.length; i++) {
      const group = retainedGroup(i);
      if (!group) continue;
      heldGroups.set(i, group);
      for (let n = 0; n < group.g.blocks.length; n++) covered[i + n] = i;
      i += group.g.blocks.length - 1;
    }
    /* A blank line is the only separator available between retained bytes and a
       printed block, and in CommonMark that makes one LOOSE list of two adjacent
       lists of the same family. So a retained list group touching a printed list
       item of its own family gives up its bytes and joins the run instead; its
       markers then normalise, as any edited group's do. Dropping one can expose
       the next, hence the fixed point. */
    const family = (index: number) => index >= 0 && index < blocks.length && listType(blocks[index]) ? (blocks[index].type === 'numberedListItem' ? 'ordered' : 'bullet') : '';
    for (let dropped = true; dropped;) {
      dropped = false;
      for (const [start, group] of heldGroups) {
        const own = family(start), after = start + group.g.blocks.length;
        // A retained neighbour counts too unless the two groups were adjacent in the
        // original (their own separator and markers already keep them apart).
        const merges = (index: number, offset: number) => family(index) === own &&
          (covered[index] < 0 || heldGroups.get(covered[index])!.index !== group.index + offset);
        if (!own || !(merges(start - 1, -1) || merges(after, 1))) continue;
        heldGroups.delete(start);
        for (let n = start; n < after; n++) covered[n] = -1;
        dropped = true;
      }
    }
    let markdown = this.bom, previous = -1, previousUnchanged = false, line = 1;
    const append = (source: string) => { markdown += source; line += source.split('\n').length - 1; };
    for (let i = 0; i < blocks.length;) {
      const b = blocks[i], entry = known.get(b.id), held = heldGroups.get(i);
      let count = 1, source: string, groupIndex = -1, unchanged = false, retained = true;
      if (held) {
        count = held.g.blocks.length; source = this.body.slice(held.g.start, held.g.end); groupIndex = held.index; unchanged = true;
      } else if (b.type === 'source') { source = String(b.props.source); groupIndex = entry?.index ?? -1; }
      else if (b.type === 'secret' && this.secretSource.get(b.id)?.has(String(b.props.ciphertext))) {
        source = this.secretSource.get(b.id)!.get(String(b.props.ciphertext))!;
        groupIndex = entry?.index ?? -1;
      }
      else {
        // A list run ends where a group that keeps its bytes begins: printing
        // across that boundary would re-serialise a neighbour nobody touched.
        if (listType(b)) while (i + count < blocks.length && listType(blocks[i + count]) && !heldGroups.has(i + count)) count++;
        source = emit(blocks.slice(i, i + count));
        retained = false;
        if (entry && entry.g.blocks.every((x, n) => blocks[i + n]?.id === x.id) && count === entry.g.blocks.length) groupIndex = entry.index;
      }
      if (retained && i + count < blocks.length && ['source', 'secret', 'codeBlock', 'diagram'].includes(b.type) && this.requiresEnd(source)) {
        if (b.type === 'source' || b.type === 'secret') throw new Error('This block must remain last; edit it in Source');
        source = emit(blocks.slice(i, i + count)); unchanged = false;
      }
      if (i === 0 && normalizeLeading) {
        if (b.type === 'source') {
          const opening = source.match(/^[^\r\n]*/)![0];
          source = print(parse(opening).children || []) + source.slice(opening.length);
        } else source = emit(blocks.slice(i, i + count));
        unchanged = false;
      }
      if (i === 0) append(this.groups.length && groupIndex === 0 ? this.body.slice(0, this.groups[0].start) : '');
      else {
        let separator = previous >= 0 && groupIndex === previous + 1 ? this.body.slice(this.groups[previous].end, this.groups[groupIndex].start) : '\n\n';
        // An odd gap's final separator can be short while its synthetic blank
        // stays empty, but newly cleared prose needs its own paragraph's space.
        const blankBoundary = unchanged && source === '' || source !== '' && previousUnchanged && previous >= 0 && this.groups[previous].start === this.groups[previous].end;
        if (!(unchanged && previousUnchanged || blankBoundary) && separator.split('\n').length < 3) separator = (separator.includes('\r\n') ? '\r\n\r\n' : '\n\n') + separator.slice(separator.lastIndexOf('\n') + 1);
        append(separator);
      }
      const start = markdown.length;
      const range = { start, end: start + source.length, line };
      append(source);
      const put = (roots: readonly SourceBlock[]) => { for (const root of roots) { ranges.set(root.id, range); put(root.children || []); } };
      put(blocks.slice(i, i + count));
      previous = groupIndex; previousUnchanged = unchanged; i += count;
    }
    if (blocks.length && this.groups.length) markdown += this.body.slice(this.groups.at(-1)!.end);
    if (semantic(blocks) === this.snapshot) markdown = this.markdown;
    else if (!normalizeLeading && !blocks[0]?.props.metadata && /^(?:\uFEFF)?(?:---|\+\+\+)/.test(markdown) && ['yaml', 'toml'].includes(parse(markdown).children?.[0]?.type || '')) {
      // A relocated delimiter can acquire meaning from a later delimiter.
      // Only canonicalize its spelling when the combined doc becomes metadata.
      return this.render(blocks, true);
    }
    return { markdown, ranges };
  }
  range(id: string, blocks: readonly SourceBlock[] = this.blocks) { return this.render(blocks).ranges.get(id); }
  ranges(blocks: readonly SourceBlock[] = this.blocks) { return this.render(blocks).ranges; }
  secrets(blocks: readonly SourceBlock[] = this.blocks, rendered = this.render(blocks)): SecretIdentity[] {
    return blocks.flatMap(b => {
      if (!['source', 'secret'].includes(b.type)) return [];
      const range = rendered.ranges.get(b.id)!;
      const source = rendered.markdown.slice(range.start, range.end);
      return secretSlices(source).map((secret, ordinal) => ({
        id: b.type === 'secret' ? b.id : `${b.id}:secret:${ordinal}`,
        blockId: b.id, ciphertext: secret.ciphertext, indent: secret.indent,
        start: range.start + secret.start, end: range.start + secret.end,
        line: range.line + source.slice(0, secret.start).split('\n').length - 1,
      }));
    });
  }
  sourceParts(blockId: string, blocks: readonly SourceBlock[] = this.blocks): Array<{ source: string } | { secret: SecretIdentity }> {
    const rendered = this.render(blocks), range = rendered.ranges.get(blockId);
    if (!range) return [];
    const parts: Array<{ source: string } | { secret: SecretIdentity }> = [];
    let cursor = range.start;
    for (const secret of this.secrets(blocks, rendered).filter(s => s.blockId === blockId)) {
      if (secret.start > cursor) parts.push({ source: rendered.markdown.slice(cursor, secret.start) });
      parts.push({ secret }); cursor = secret.end;
    }
    if (cursor < range.end) parts.push({ source: rendered.markdown.slice(cursor, range.end) });
    return parts;
  }
  replaceSecret(id: string, ciphertext: string, blocks: readonly SourceBlock[] = this.blocks): string {
    const rendered = this.render(blocks), secrets = this.secrets(blocks, rendered);
    const identity = secrets.find(secret => secret.id === id);
    if (!identity) throw new Error('Secret block no longer exists');
    const target = blocks.find(b => b.id === identity.blockId)!;
    const range = rendered.ranges.get(target.id)!;
    const source = rendered.markdown.slice(range.start, range.end);
    const ordinal = secrets.filter(secret => secret.blockId === target.id).findIndex(secret => secret.id === id);
    const slice = secretSlices(source)[ordinal];
    const next = source.slice(0, slice.bodyStart) + ciphertext + source.slice(slice.bodyEnd);
    if (target.type === 'source') {
      target.props.source = next;
      this.allowedSource.get(target.id)!.add(semantic([target]));
    } else {
      target.props.ciphertext = ciphertext;
      if (!this.secretSource.has(target.id)) this.secretSource.set(target.id, new Map());
      this.secretSource.get(target.id)!.set(ciphertext, next);
    }
    return this.serialize(blocks);
  }
}
