/* ============================================================
   block-editor.tsx — the isolated visual view over a Markdown source session.
   Callbacks keep doc transactions and decrypted DOM in their existing owners.
   ============================================================ */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, defaultStyleSpecs, filterSuggestionItems, HistoryExtension, plainContentToString } from '@blocknote/core';
import { en } from '@blocknote/core/locales';
import { createReactBlockSpec, createReactInlineContentSpec, getDefaultReactSlashMenuItems, SideMenuController, SuggestionMenuController } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { createReactDiagramBlockSpec, defaultMermaidOptions, getDiagramSlashMenuItems, initializeMermaid } from '@blocknote/diagram-block';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import mermaid from 'mermaid';
import '@blocknote/mantine/style.css';
import { listItemTypes, SourceSession, type SourceBlock, type SecretIdentity } from './markdown-source';

/* A fence is untrusted input (ADR 0010): a vault syncs over git and the AI relay
   writes docs. The diagram block initializes mermaid once, lazily; claiming that
   one shot here and re-initializing keeps production's locks, whatever the
   block's or mermaid's defaults become. `secure` names the keys an in-diagram
   `%%{init}%%` or YAML directive may NOT override, and mermaid REPLACES that
   array rather than extending it, so every locked name is re-listed. */
initializeMermaid();
mermaid.initialize({
  // htmlLabels:false per diagram family; the bare name every family flattens to
  // is re-stated here because a foreignObject label is the surface behind most
  // mermaid XSS reports against an embedder.
  ...defaultMermaidOptions,
  htmlLabels: false,
  startOnLoad: false,
  securityLevel: 'strict',
  secure: [
    'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
    'htmlLabels', 'dompurifyConfig', 'themeCSS', 'fontFamily', 'altFontFamily', 'theme', 'layout', 'look',
  ],
  // A note is not a dashboard, and securityLevel does nothing about the
  // infinite-loop advisories. maxEdges only covers flowcharts.
  maxTextSize: 20000,
  maxEdges: 200,
  // Mermaid's own error graphic injects itself into document.body and orphans
  // the node; set, it throws instead and the block owns the error surface.
  suppressErrorRendering: true,
});

export type { SecretIdentity } from './markdown-source';
export interface EditorOptions {
  markdown: string;
  onChange(markdown: string): void;
  onSource(line: number): void;
  renderSecret(secret: SecretIdentity): HTMLElement;
  copyText?(text: string): void | Promise<void>;
  resolveWikiLink?(target: string): string | undefined;
  onWikiLink?(target: string): void;
  /** The screen could not be written back as Markdown. `getMarkdown()` still
      holds the last text that could, so the app must stop treating it as the
      document until a later edit serializes. */
  onError?(message: string): void;
}
export interface EditorController {
  destroy(): void;
  getMarkdown(): string;
  setMarkdown(markdown: string): void;
  focus(): void;
  /** `line` and the returned `line` are 1-based source lines. `anchor` is the
      pixel row inside the scroll pane the block must keep (ADR 0027). */
  revealLine(line: number, anchor?: number): void;
  anchorLine(): { line: number; anchor: number } | null;
  getSecrets(): SecretIdentity[];
  replaceSecret(id: string, ciphertext: string): boolean;
  /** Whether the island's OWN history holds a step. False means ⌘Z/⌘⇧Z is the
      app timeline's again — a file operation is only ever recorded there
      (ADR 0014). */
  canUndo(): boolean;
  canRedo(): boolean;
}

/* `I.copy`, the shell's glyph — restated rather than imported, because the
   island imports npm packages and the source adapter only (ADR 0037). */
const copyIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>';
/** The link spellings that carry a URL worth copying. A `[[wiki]]` link names a
    doc in this vault, not an address, and gets no button (spec 0016). */
const copyableHref = /^(https?|mailto|tel):/i;
const linkCopyKey = new PluginKey<DecorationSet>('zLinkCopy');

const toolbarOffsetKey = 'znotes.toolbarOffset';
const clampToolbarOffset = (value: number) => Number.isFinite(value) ? Math.max(-160, Math.min(160, value)) : 0;

function Toolbar({ children }: { children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(() => {
    try { return clampToolbarOffset(Number(localStorage.getItem(toolbarOffsetKey))); }
    catch { return 0; }
  });
  function move(value: number) {
    const next = clampToolbarOffset(value);
    setOffset(next);
    try { localStorage.setItem(toolbarOffsetKey, String(next)); } catch { /* Calibration works when browser storage is blocked. */ }
  }
  useEffect(() => {
    if (!open) return;
    const island = host.current!.parentElement!;
    function outside(event: PointerEvent) {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      // Native menus consume Escape in place; ordinary editor Escape blurs.
      if (event.key !== 'Escape' || event.defaultPrevented && island.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      if (host.current?.querySelector('.z-toolbar-options')?.contains(document.activeElement)) {
        host.current.querySelector<HTMLButtonElement>('.z-toolbar-more')?.focus({ preventScroll: true });
      }
      setOpen(false);
    }
    document.addEventListener('pointerdown', outside, true);
    island.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      island.removeEventListener('keydown', escape);
    };
  }, [open]);
  return <div ref={host} className="z-block-toolbar" role="toolbar" aria-label="List formatting"
    style={{ '--toolbar-offset': `${offset}px` } as CSSProperties} onPointerDownCapture={event => event.preventDefault()}>
    <div className="z-toolbar-actions">{children}</div>
    <button className="z-toolbar-more" type="button" aria-label="Toolbar options" aria-expanded={open}
      aria-controls="z-toolbar-options" onClick={() => setOpen(!open)}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
    </button>
    <div id="z-toolbar-options" className="z-toolbar-options" data-open={open} inert={!open}>
      <div><div className="z-toolbar-position">
        <span>Position</span>
        <button type="button" aria-label="Move toolbar up" disabled={offset <= -160} onClick={() => move(offset - 8)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 12 6-6 6 6M12 6v14"/></svg>
        </button>
        <button type="button" aria-label="Move toolbar down" disabled={offset >= 160} onClick={() => move(offset + 8)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 12 6 6 6-6M12 18V4"/></svg>
        </button>
        <button type="button" aria-label="Reset toolbar position" onClick={() => move(0)}>Reset</button>
      </div></div>
    </div>
  </div>;
}

function SecretDOM({ identity, render }: { identity: SecretIdentity; render: EditorOptions['renderSecret'] }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // The callback's DOM may contain plaintext. React never receives that text.
    const node = render(identity);
    if (!host.current!.contains(node)) host.current!.replaceChildren(node);
  }, [identity.id, identity.ciphertext, render]);
  return <div className="z-secret-host" contentEditable={false} ref={host} />;
}

export function mountEditor(host: HTMLElement, options: EditorOptions): EditorController {
  let session = new SourceSession(options.markdown);
  let markdown = options.markdown;
  /* The app stopped trusting `markdown` when a transaction refused to serialize.
     The next document that DOES serialize must be announced even when its text
     is the text the app already holds — undoing the refused edit is exactly
     that, and the doc would otherwise stay unsavable until the next keystroke. */
  let stale = false;
  let replacing = false;
  let destroyed = false;
  const lineFor = (id: string) => session.range(id, blocks())?.line ?? 1;
  const nodeFor = (id: string) => host.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const scrollPane = () => host.closest<HTMLElement>('.scroll');
  const source = createReactBlockSpec({
    type: 'source', content: 'none',
    propSchema: { source: { default: '' }, label: { default: 'Protected Markdown' }, metadata: { default: false } },
  }, {
    render: ({ block }) => <div className="z-source-block" contentEditable={false}>
      <strong>{block.props.label}</strong>
      {session.sourceParts(block.id, blocks()).map((part, index) => 'secret' in part
        ? <SecretDOM key={part.secret.id} identity={part.secret} render={options.renderSecret} />
        : <pre key={index}>{part.source}</pre>)}
      <button type="button" onClick={() => options.onSource(lineFor(block.id))}>Edit source</button>
    </div>,
    toExternalHTML: ({ block }) => <pre>{block.props.source}</pre>,
  })();
  const renderSourceView = source.implementation.render;
  source.implementation.render = function (block, editor) {
    if (this.renderType === 'nodeView') return renderSourceView.call(this, block, editor);
    const dom = document.createElement('pre');
    dom.textContent = block.props.source;
    return { dom };
  };
  const secret = createReactBlockSpec({
    type: 'secret', content: 'none', propSchema: { ciphertext: { default: '' } },
  }, {
    render: ({ block }) => <SecretDOM identity={session.secrets(blocks()).find(secret => secret.id === block.id)!} render={options.renderSecret} />,
    toExternalHTML: ({ block }) => <pre><code className="language-age">{block.props.ciphertext}</code></pre>,
  })();
  const renderSecretView = secret.implementation.render;
  secret.implementation.render = function (block, editor) {
    // Internal clipboard HTML also calls render, without node-view props.
    if (this.renderType === 'nodeView') return renderSecretView.call(this, block, editor);
    const dom = document.createElement('span');
    dom.textContent = '[Encrypted secret]';
    return { dom };
  };
  const wikiLink = createReactInlineContentSpec({
    type: 'wikiLink', content: 'none', propSchema: { target: { default: '' } },
  }, {
    render: ({ inlineContent }) => {
      const target = inlineContent.props.target;
      const resolved = options.resolveWikiLink?.(target);
      return <button type="button" contentEditable={false} className={`wiki-link${resolved ? '' : ' broken'}`} data-target={target}
        title={resolved || `Missing doc: ${target} · Create`}
        onClick={() => options.onWikiLink?.(target)}>[[{target}]]</button>;
    },
    toExternalHTML: ({ inlineContent }) => <span>[[{inlineContent.props.target}]]</span>,
  });
  const { paragraph, heading, bulletListItem, numberedListItem, checkListItem, quote, table } = defaultBlockSpecs;
  const codeBlock = { ...defaultBlockSpecs.codeBlock, implementation: { ...defaultBlockSpecs.codeBlock.implementation } };
  const renderCode = codeBlock.implementation.render;
  codeBlock.implementation.render = function (block, editor) {
    const view = renderCode.call(this, block, editor);
    if (this.renderType !== 'nodeView') return view;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'z-code-copy';
    copy.contentEditable = 'false';
    copy.setAttribute('aria-label', 'Copy code');
    copy.textContent = 'Copy';
    copy.onpointerdown = event => event.preventDefault();
    copy.onclick = async event => {
      event.stopPropagation();
      const current = editor.getBlock(block.id);
      if (current?.type !== 'codeBlock') return;
      try { await (options.copyText ?? (text => navigator.clipboard.writeText(text)))(plainContentToString(current.content)); copy.textContent = 'Copied'; }
      catch { copy.textContent = 'Copy failed'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    };
    view.dom.appendChild(copy);
    return { ...view, ignoreMutation: mutation => copy.contains(mutation.target) || (view.ignoreMutation?.(mutation) ?? false) };
  };
  const { bold, italic, strike, code } = defaultStyleSpecs;
  const schema = BlockNoteSchema.create({
    blockSpecs: { paragraph, heading, bulletListItem, numberedListItem, checkListItem, quote, codeBlock, table, source, secret, diagram: createReactDiagramBlockSpec() },
    inlineContentSpecs: { ...defaultInlineContentSpecs, wikiLink },
    styleSpecs: { bold, italic, strike, code },
  });
  type EditorBlock = typeof schema.PartialBlock;
  function copyButton(href: string) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'z-link-copy';
    button.setAttribute('aria-label', 'Copy link');
    button.title = 'Copy link';
    button.innerHTML = copyIcon;
    // Taking the URL is not a place in the text: the caret stays where it was.
    button.onpointerdown = event => event.preventDefault();
    button.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      // A mailto: link copies the address, not the scheme (spec 0016).
      void (options.copyText ?? (text => navigator.clipboard.writeText(text)))(href.replace(/^mailto:/i, ''));
    };
    return button;
  }
  function linkCopyDecorations(state: EditorState) {
    const links: { end: number; href: string }[] = [];
    state.doc.descendants((node, pos) => {
      const href: unknown = node.isText ? node.marks.find(mark => mark.type.name === 'link')?.attrs.href : undefined;
      if (typeof href !== 'string' || !copyableHref.test(href)) return;
      // One link's text can be several text nodes — a bold word inside the label.
      const previous = links.at(-1);
      if (previous && previous.end === pos && previous.href === href) previous.end = pos + node.nodeSize;
      else links.push({ end: pos + node.nodeSize, href });
    });
    return DecorationSet.create(state.doc, links.map(link =>
      // Keyed, so a keystroke elsewhere keeps every button's DOM instead of redrawing it.
      Decoration.widget(link.end, () => copyButton(link.href), { side: 1, ignoreSelection: true, key: link.href })));
  }
  /* A WIDGET, never appended DOM: a node put inside the contenteditable by hand
     would join the document on the next transaction and the clipboard with the
     next copy. A decoration is outside the doc, so undo and the adapter's bytes
     never see it. */
  const linkCopy = Extension.create({
    name: 'zLinkCopy',
    addProseMirrorPlugins: () => [new Plugin({
      key: linkCopyKey,
      state: {
        init: (_config, state) => linkCopyDecorations(state),
        apply: (tr, current, _old, state) => tr.docChanged ? linkCopyDecorations(state) : current,
      },
      props: { decorations: state => linkCopyKey.getState(state) },
    })],
  });
  const editor = BlockNoteEditor.create({
    schema, dictionary: en,
    initialContent: (session.blocks.length ? session.blocks : [{ type: 'paragraph' }]) as EditorBlock[],
    domAttributes: { editor: { 'aria-label': 'Doc editor' } },
    // `_tiptapOptions.extensions` is BlockNote's own undocumented door; it
    // APPENDS to the editor's extension list rather than replacing it.
    _tiptapOptions: { extensions: [linkCopy] },
  });
  let snapshot = JSON.stringify(editor.document);
  let sourceValues = new Map(session.blocks.filter(block => block.type === 'source').map(block => [block.id, new Set([block.props.source])]));
  function blocks(): SourceBlock[] { return editor.document as unknown as SourceBlock[]; }
  function changed() {
    if (replacing || destroyed) return;
    const current = blocks();
    for (const block of current) if (block.type === 'source' && !sourceValues.has(block.id)) sourceValues.set(block.id, new Set([block.props.source]));
    let next: string;
    // The editor swallows a throw from its own listener, and the doc would then
    // follow the screen no further, silently. The last good markdown stands.
    try { next = JSON.stringify(current) === snapshot ? session.markdown : session.serialize(current); }
    catch (error) {
      console.error('This document could not be written as Markdown', error);
      stale = true;
      options.onError?.(error instanceof Error ? error.message : String(error));
      return;
    }
    if (next !== markdown || stale) { stale = false; markdown = next; options.onChange(next); }
  }
  const unsubscribe = editor.onChange(changed);
  const unguard = editor.onBeforeChange(({ tr }) => {
    if (replacing || !tr.docChanged) return;
    const previous = new Map(blocks().filter(block => block.type === 'source' || block.type === 'secret').map(block => [block.id, block]));
    let valid = true;
    const seen = new Set<string>();
    let lastContent = tr.doc.firstChild?.lastChild;
    tr.doc.firstChild?.forEach(node => {
      // BlockNote keeps an empty paragraph after a final nonparagraph block.
      if (node.childCount !== 1 || node.firstChild?.type.name !== 'paragraph' || node.firstChild.childCount) lastContent = node;
    });
    tr.doc.descendants((node, pos) => {
      if (['textColor', 'backgroundColor'].some(key => node.attrs[key] && node.attrs[key] !== 'default')) valid = false;
      if (node.attrs.textAlignment && node.attrs.textAlignment !== 'left') valid = false;
      if ((node.attrs.colspan || 1) !== 1 || (node.attrs.rowspan || 1) !== 1) valid = false;
      if (node.type.name !== 'blockContainer') return;
      const id = String(node.attrs.id);
      const content = node.firstChild!;
      const old = previous.get(id);
      // Some protected Markdown consumes all following source, even across blank lines.
      if (node !== lastContent && (
        content.type.name === 'source' && session.requiresEnd(String(content.attrs.source)) ||
        content.type.name === 'secret' && session.requiresEndBlock(id)
      )) valid = false;
      if (content.attrs.metadata && tr.doc.firstChild?.firstChild?.attrs.id !== id) valid = false;
      // Only a list item nests, and only list items nest under it: any other
      // child comes back from Markdown as a group the adapter cannot import.
      if (node.childCount > 1) {
        if (!listItemTypes.includes(content.type.name)) valid = false;
        else node.child(1).forEach(child => { if (!listItemTypes.includes(child.firstChild!.type.name)) valid = false; });
      }
      const isProtected = content.type.name === 'source' || content.type.name === 'secret';
      if (isProtected && (tr.doc.resolve(pos).depth !== 1 || node.childCount > 1)) valid = false;
      if (old) {
        seen.add(id);
        if (content.type.name !== old.type) valid = false;
        if (old.type === 'source' && !sourceValues.get(id)?.has(content.attrs.source)) valid = false;
      }
    });
    for (const [id, block] of previous) if (block.props?.metadata && !seen.has(id)) valid = false;
    return valid;
  });
  function list(type: 'bulletListItem' | 'numberedListItem' | 'checkListItem') {
    const selected = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
    editor.transact(() => {
      for (const block of selected) if (block.content && block.type !== 'table' && block.type !== 'diagram' && block.type !== 'codeBlock') editor.updateBlock(block, { type });
    });
    editor.focus();
  }
  const root = createRoot(host);
  flushSync(() => root.render(<>
    <BlockNoteView editor={editor} theme="light" slashMenu={false} sideMenu={false}>
      {/* Native heading offsets assume larger fonts than the app themes. */}
      <SideMenuController floatingUIOptions={{ useFloatingOptions: { middleware: [] } }} />
      <SuggestionMenuController triggerCharacter="/" getItems={async query => filterSuggestionItems([
        ...getDefaultReactSlashMenuItems(editor), ...getDiagramSlashMenuItems(editor),
      ], query)} />
    </BlockNoteView>
    <Toolbar>
      <button type="button" aria-label="Bullet list" onClick={() => list('bulletListItem')}>• List</button>
      <button type="button" aria-label="Numbered list" onClick={() => list('numberedListItem')}>1. List</button>
      <button type="button" aria-label="Checklist" onClick={() => list('checkListItem')}>☑ Tasks</button>
      <button type="button" aria-label="Outdent" onClick={() => { editor.unnestBlock(); editor.focus(); }}>←</button>
      <button type="button" aria-label="Indent" onClick={() => { editor.nestBlock(); editor.focus(); }}>→</button>
    </Toolbar>
  </>));
  return {
    destroy() { destroyed = true; unsubscribe(); unguard(); root.unmount(); },
    getMarkdown() { return markdown; },
    setMarkdown(next) {
      // While stale the screen is NOT `markdown`, so even the same text replaces it.
      if (next === markdown && !stale) return;
      replacing = true;
      try {
        session = new SourceSession(next);
        markdown = next;
        stale = false;
        editor.replaceBlocks(editor.document, (session.blocks.length ? session.blocks : [{ type: 'paragraph' }]) as EditorBlock[]);
        snapshot = JSON.stringify(editor.document);
        sourceValues = new Map(session.blocks.filter(block => block.type === 'source').map(block => [block.id, new Set([block.props.source])]));
      } finally { replacing = false; }
    },
    focus() { editor.focus(); },
    revealLine(line, anchor) {
      const docBlocks = blocks();
      const ranges = session.ranges(docBlocks);
      const block = docBlocks.findLast(block => (ranges.get(block.id)?.line ?? Infinity) <= line);
      if (!block) return;
      const node = nodeFor(block.id);
      const pane = anchor === undefined ? null : node && scrollPane();
      if (!pane) node?.scrollIntoView({ block: 'center' });
      if (block.type !== 'source' && block.type !== 'secret') editor.setTextCursorPosition(block.id, 'start');
      // The carried offset is the contract of a mode switch, so it is applied
      // last: the caret's own scrolling must not win over it.
      if (pane) pane.scrollTop = Math.max(0, Math.min(
        pane.scrollTop + node!.getBoundingClientRect().top - pane.getBoundingClientRect().top - anchor!,
        pane.scrollHeight - pane.clientHeight));
    },
    anchorLine() {
      const pane = scrollPane();
      if (!pane) return null;
      const paneTop = pane.getBoundingClientRect().top;
      const docBlocks = blocks();
      const ranges = session.ranges(docBlocks);
      for (const block of docBlocks) {
        const rect = nodeFor(block.id)?.getBoundingClientRect();
        const line = ranges.get(block.id)?.line;
        if (rect && line !== undefined && rect.bottom > paneTop + 1) return { line, anchor: rect.top - paneTop };
      }
      return null;
    },
    canUndo() { const history = editor.getExtension(HistoryExtension); return !!history && editor.canExec(history.undoCommand); },
    canRedo() { const history = editor.getExtension(HistoryExtension); return !!history && editor.canExec(history.redoCommand); },
    getSecrets() { return session.secrets(blocks()); },
    replaceSecret(id, ciphertext) {
      const next = structuredClone(blocks());
      const identity = session.secrets(next).find(secret => secret.id === id);
      if (!identity) return false;
      session.replaceSecret(id, ciphertext, next);
      const block = next.find(block => block.id === identity.blockId)!;
      if (block.type === 'source') sourceValues.get(block.id)?.add(block.props.source);
      replacing = true;
      try {
        editor.transact(tr => {
          // Re-encryption maintains the current secret; prose undo must not restore old armor.
          tr.setMeta('addToHistory', false);
          editor.updateBlock(block.id, { props: block.props });
        });
      }
      finally { replacing = false; }
      changed();
      return true;
    },
  };
}
