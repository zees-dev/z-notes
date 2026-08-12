/* ============================================================
   docs.ts — the doc/folder/trash transaction owner.

   Every vault mutation the HTTP surface offers runs here: create, CAS-write,
   rename/move with backlink rewrites and rollback, delete-to-trash, restore,
   purge, the retention sweep, and the git commit that seals each one. The
   router in index.ts holds no doc logic — each route is one delegation.

   HUMAN-ONLY, STRUCTURALLY: the assistant's propose_edits accepts
   exactly replace | insert_after | create | rewrite; ai.ts writes through
   vault.writeDocAtomic and nothing else, and nothing in ai.ts can reach the
   move/delete methods below — they are not on the AI deps object, and the AI
   never issues an HTTP request against this server.
   ============================================================ */

import { rm } from "node:fs/promises";
import {
  affectedTargets,
  buildTree,
  hasSecrets,
  linkSafeTarget,
  planLinkRewrites,
  revOf,
  safePath,
  sameNode,
  slugOf,
  titleOf,
  Vault,
  type FileMeta,
} from "./vault.ts";
import type { Index } from "./db.ts";
import type { Reconciler, ChangeReason } from "./watch.ts";
import { Trash, TrashError } from "./trash.ts";
import type { GitSync } from "./git.ts";
import { fail, iso, json } from "./http.ts";

export const isMd = (p: string) => /\.md$/i.test(p);

interface DocStoreDeps {
  vault: Vault;
  index: Index;
  recon: Reconciler;
  trash: Trash;
  git: GitSync;
  broadcast: (event: string, data: unknown) => void;
}

export class DocStore {
  private readonly vault: Vault;
  private readonly index: Index;
  private readonly recon: Reconciler;
  private readonly trash: Trash;
  private readonly git: GitSync;
  private readonly broadcast: (event: string, data: unknown) => void;

  constructor(deps: DocStoreDeps) {
    this.vault = deps.vault;
    this.index = deps.index;
    this.recon = deps.recon;
    this.trash = deps.trash;
    this.git = deps.git;
    this.broadcast = deps.broadcast;
  }

  metaOf(row: {
    path: string;
    title: string;
    slug: string;
    size: number;
    mtimeMs: number;
    empty: number;
    hasSecrets: number;
  }): FileMeta {
    return {
      type: "file",
      path: row.path,
      name: row.path.split("/").pop()!,
      title: row.title,
      slug: row.slug,
      bytes: row.size,
      mtime: iso(row.mtimeMs),
      empty: !!row.empty,
      hasSecrets: !!row.hasSecrets,
    };
  }

  async treeResponse() {
    const files = this.index.allFileMeta().map((r) => this.metaOf(r));
    return {
      vault: { name: this.vault.name, root: this.vault.realRoot, docCount: files.length },
      tree: buildTree(files, this.index.folderOpen(), await this.vault.scanFolders()),
    };
  }

  /**
   * Everything here is derived from the bytes just read — never from the sqlite
   * row. The row can lag disk (the reconcile pass is debounced), and pairing
   * fresh markdown with a stale `rev` would make PUT's compare-and-swap validate
   * against content that is no longer there: an external edit would be silently
   * overwritten instead of raising 409.
   */
  async docBody(path: string) {
    const disk = await this.vault.readDoc(path);
    if (!disk) return null;
    const md = disk.markdown;
    return {
      type: "file",
      path,
      name: path.split("/").pop()!,
      title: titleOf(md, path.split("/").pop()!),
      slug: slugOf(path),
      markdown: md,
      rev: revOf(md),
      bytes: disk.size,
      mtime: iso(disk.mtimeMs),
      empty: !md.trim(),
      hasSecrets: hasSecrets(md),
    };
  }

  /**
   * macOS resolves several distinct strings to the same file (case-insensitive,
   * NFC/NFD-insensitive). A write would land while every index lookup keyed on the
   * client's spelling missed, so resolve to the spelling the index actually holds.
   */
  canonicalDocPath(p: string): string {
    if (this.index.file(p)) return p;
    const want = p.normalize("NFC").toLowerCase();
    for (const row of this.index.allFileMeta()) {
      if (row.path.normalize("NFC").toLowerCase() === want) return row.path;
    }
    return p;
  }

  /* ============================================================
     File ops — PATCH (rename/move) + DELETE.

     HUMAN-ONLY, STRUCTURALLY. The assistant has no delete and no
     rename: `propose_edits` accepts exactly `replace | insert_after | create |
     rewrite`, ai.ts writes through `writeDocAtomic` and nothing else, and nothing
     in ai.ts can reach the two functions below — they are not exported, not on
     the AI deps object, and the AI never issues an HTTP request against this
     server. The absence is the guarantee.

     Both ops are ONE git commit and are atomic in the sense that matters: the
     vault is never left half-moved. The order is rename → rewrite backlinks →
     reconcile → commit; a failure anywhere in the write phase restores every file
     already touched (the phase-4 accept() rollback pattern) and answers 500.
     ============================================================ */



  /**
   * PATCH /api/docs/{path} `{to}` and DELETE /api/docs/{path}.
   *
   * Runs under the reconcile lock, and OPENS with a full reconcile pass: the
   * whole plan below is computed against the sqlite backlink graph, and that
   * graph is only true if the index has seen every byte on disk. Holding the lock
   * from that pass through the write means nothing can drift underneath it.
   */
  /** POST /api/docs — mint a doc or folder, implicit parents rolled back on failure. */
  async create(body: any): Promise<Response> {
    const p = safePath(body?.path);
    if (!p) return fail(400, "bad-path", { message: "Path escapes the vault." });
    // safePath is lexical; abs() also resolves symlinks, so this is what stops a
    // link inside the vault from becoming a create outside it
    if (!this.vault.abs(p)) return fail(400, "bad-path", { message: "Path escapes the vault." });
    const type = body?.type === "folder" ? "folder" : "doc";

    /* The same guard the MOVE applies to its destinations, applied at birth.
       `safePath` stops traversal and `.znotes`, but says nothing about "]" or a
       line break — and a doc whose path carries either cannot survive the
       `[[…]]` that a later rename would splice it into, so the move refuses to
       produce that name. Minting it directly was the way around that refusal.
       A folder is checked too — every doc created under it inherits the bad
       segment. */
    if (!linkSafeTarget(p.replace(/\.md$/i, "")) || !linkSafeTarget(slugOf(p))) {
      return fail(400, "bad-path", {
        message: `${p} cannot be a name: "]" and line breaks break out of the [[link]] that would point at it.`,
      });
    }

    if (type === "folder") {
      if (await this.vault.exists(p)) return fail(409, "exists", { message: `${p} already exists.` });
      const blocker = await this.vault.blockedByFile(p);
      if (blocker) return fail(409, "exists", { message: `${blocker} is a doc, not a folder.` });
      return this.recon.lock(async () => {
        // re-checked under the lock: the gate above raced anything already held
        if (await this.vault.exists(p)) return fail(409, "exists", { message: `${p} already exists.` });
        /* implicit parents, and a real rollback for them: `a/b/c` makes a and
           a/b on the way, and a failure must not leave that tree standing */
        const implicit = await this.vault.missingFolders(p, true);
        try {
          await this.vault.makeFolder(p);
        } catch (err) {
          await this.vault.pruneEmptyFolders(implicit);
          return fail(500, "write-failed", { message: `${p} could not be created.` });
        }
        this.index.setFolderOpen(p, true);
        return json({ type: "folder", path: p, name: p.split("/").pop()! }, 201);
      });
    }

    const file = p.replace(/\.md$/i, "") + ".md";
    if (await this.vault.exists(file)) return fail(409, "exists", { message: `${file} already exists.` });
    const blocker = await this.vault.blockedByFile(file);
    if (blocker) return fail(409, "exists", { message: `${blocker} is a doc, not a folder.` });
    const markdown = typeof body?.markdown === "string" ? body.markdown : "";
    return this.recon.lock(async () => {
      if (await this.vault.exists(file)) return fail(409, "exists", { message: `${file} already exists.` });
      const implicit = await this.vault.missingFolders(file, false);
      try {
        await this.vault.writeDocAtomic(file, markdown);
      } catch (err) {
        await this.vault.pruneEmptyFolders(implicit);
        return fail(500, "write-failed", { message: `${file} could not be created.` });
      }
      await this.recon.reconcileHeld(new Map<string, ChangeReason>([[file, "created"]]));
      const out = await this.docBody(file);
      if (out) return json(out, 201);
      await this.vault.pruneEmptyFolders(implicit);
      return fail(500, "write-failed", { message: "The new doc vanished after writing." });
    });
  }

  /** GET /api/docs/{path} — .md gate, canonical spelling, disk-derived body. */
  async read(decoded: string): Promise<Response> {
    // a doc is a .md file. Without this, GET hands out any file that
    // happens to sit in the vault (.env, an ssh key) even though it is in no
    // tree and no search result.
    if (!isMd(decoded)) return fail(404, "not-found", { message: `No doc at ${decoded}` });
    const p = this.canonicalDocPath(decoded);
    const out = await this.docBody(p);
    return out ? json(out) : fail(404, "not-found", { message: `No doc at ${p}` });
  }

  /** PUT /api/docs/{path} — compare-and-swap under the reconcile lock. */
  async putDoc(decoded: string, body: any): Promise<Response> {
    if (!isMd(decoded)) return fail(404, "not-found", { message: `No doc at ${decoded}` });
    const p = this.canonicalDocPath(decoded);
    if (typeof body?.markdown !== "string") return fail(400, "bad-body", { message: "markdown must be a string." });
    const markdown: string = body.markdown;
    const wantRev: string | undefined = typeof body.rev === "string" && body.rev ? body.rev : undefined;

    // the whole read-compare-write runs under the reconcile lock: atomic
    return this.recon.lock(async () => {
      const current = await this.docBody(p);
      if (!current) return fail(404, "not-found", { message: `No doc at ${p}` });
      if (wantRev && wantRev !== current.rev) {
        return fail(409, "rev-conflict", {
          rev: current.rev,
          markdown: current.markdown,
          message: "This doc changed since you read it.",
        });
      }
      if (markdown === current.markdown) {
        // identical bytes ⇒ same rev, no write, no doc-changed
        return json({ path: p, rev: current.rev, bytes: current.bytes, mtime: current.mtime });
      }
      await this.vault.writeDocAtomic(p, markdown);
      await this.recon.reconcileHeld(new Map<string, ChangeReason>([[p, "write"]]));
      // read the result back off disk: a write that landed must never be
      // reported as a server fault because an index lookup missed
      const after = await this.docBody(p);
      if (!after) return fail(500, "write-failed", { message: "The doc vanished after writing." });
      return json({ path: p, rev: after.rev, bytes: after.bytes, mtime: after.mtime });
    });
  }

  /** POST /api/trash/purge — no body/{} = the retention sweep on demand; {all:true} = Empty trash. */
  async trashPurge(body: any): Promise<Response> {
    if (body?.all === true) {
      return this.recon.lock(async () => {
        const { purged, entryPaths } = await this.trash.purgeAll();
        if (entryPaths.length) await this.commitFileOp(entryPaths, `trash: empty (${purged.length})`);
        if (purged.length) await this.announceTrash();
        return json({ purged, retentionDays: this.trash.retentionDays(), all: true });
      });
    }
    return json({ purged: await this.sweepTrash("requested"), retentionDays: this.trash.retentionDays(), all: false });
  }

  /** GET /api/trash/{id}. */
  async trashEntry(id: string): Promise<Response> {
    const found = await this.trash.entry(id);
    return found ? json(found.out) : fail(404, "not-found", { message: `No trash entry ${id}.` });
  }

  async fileOp(method: "PATCH" | "DELETE", rel: string, body: unknown): Promise<Response> {
    return this.recon.lock(async () => {
      await this.recon.reconcileHeld();

      const kind = await this.vault.exists(rel);
      if (!kind) return fail(404, "not-found", { message: `Nothing at ${rel}` });
      // a doc is a .md file. Anything else that happens to sit in the
      // vault is in no tree, no search result, and is not renamable or deletable
      // through this API either.
      if (kind === "file" && !isMd(rel)) return fail(404, "not-found", { message: `No doc at ${rel}` });
      const from = kind === "file" ? this.canonicalDocPath(rel) : rel;

      const beforeDocs = await this.vault.scanDocs();
      const subtree = kind === "file" ? [from] : beforeDocs.filter((d) => d.startsWith(from + "/"));
      /* Every FILE the op will actually touch, `.md` or not: `moveNode` is one
         rename(2) and the trash move another, so a folder carries its images and
         its README along. Naming only the `.md` children in the
         commit left those deleted-in-the-worktree and alive-in-HEAD forever — the
         bulk `stage()` is `.md`-only too, so nothing downstream could ever heal
         it, and `dirtyOutsideAllowlist()` then wedged every future push. */
      const payload = kind === "file" ? [from] : await this.vault.scanTree(from);

      return method === "DELETE"
        ? this.deleteNode(from, kind, subtree, payload)
        : this.moveNodeOp(from, kind, beforeDocs, subtree, payload, body);
    });
  }

  async moveNodeOp(
    from: string,
    kind: "file" | "dir",
    beforeDocs: string[],
    subtree: string[],
    payload: string[],
    body: any
  ): Promise<Response> {
    const to = safePath(body?.to);
    if (!to || !this.vault.abs(to)) {
      return fail(400, "bad-path", { message: "`to` must be a vault-relative path that stays inside the vault." });
    }
    if (kind === "file" && !isMd(to)) return fail(400, "bad-path", { message: "A doc path must end in .md." });
    /* The no-op answers first, for a folder exactly as for a doc: `to === from`
       is not "moved inside itself", it is nothing at all, and answering 400 for
       one entity kind and 200 for the other is a contract the client cannot
       reason about. */
    if (to === from) {
      // an explicit no-op is not an error; answer as if it had been done
      const same = kind === "file" ? await this.docBody(from) : null;
      return json(this.moveOut(kind, from, from, same, [], 0, kind === "dir" ? new Map() : undefined));
    }
    if (kind === "dir" && to.startsWith(from + "/")) {
      return fail(400, "bad-path", { message: "A folder cannot be moved inside itself." });
    }

    const absFrom = this.vault.abs(from)!;
    const absTo = this.vault.abs(to)!;
    const taken = await this.vault.exists(to);
    // ...unless the two spellings are the same inode: on macOS `Foo.md` →
    // `foo.md` is a legal rename that `exists()` reports as a collision
    if (taken && !sameNode(absFrom, absTo)) return fail(409, "exists", { message: `${to} already exists.` });
    const blocker = await this.vault.blockedByFile(to);
    if (blocker) return fail(409, "exists", { message: `${blocker} is a doc, not a folder.` });

    /* ---------- plan ---------- */

    const mapping = new Map<string, string>();
    if (kind === "file") mapping.set(from, to);
    else for (const d of subtree) mapping.set(d, to + d.slice(from.length));

    /* Every spelling the rewriter could emit for a destination has to survive a
       `[[…]]` round trip. It does not for a name carrying `]]` (or a bare `]`, or
       a line break): the rewrite splices it in unescaped, so `[[x]]y]]` lands in
       the prose of every referrer, the renderer paints a broken pill and dumps
       the tail as text, and `LINK_RE` can never see the mangled occurrence again
       — renaming back answers 200 with `backlinksUpdated:0` and repairs nothing.
       Refuse the move instead; nothing has been written yet.

       A folder's own destination is checked alongside its subtree's: the
       mapping holds only the `.md` docs under it, so an EMPTY folder (or one
       carrying only non-`.md` files) had nothing to check and could take a name
       `POST /api/docs` refuses to mint — a dead zone nothing can be created in
       or moved into. Empty and non-empty folders are refused identically. */
    for (const dest of kind === "dir" ? [to, ...mapping.values()] : mapping.values()) {
      if (!linkSafeTarget(dest.replace(/\.md$/i, "")) || !linkSafeTarget(slugOf(dest))) {
        return fail(400, "bad-path", {
          message: `${dest} cannot be a name: "]" and line breaks break out of the [[link]] that would point at it.`,
        });
      }
    }

    /* Candidates = the docs the backlink graph says carry a target whose
       resolution changes. That is a superset of the docs that actually need a
       rewrite (the graph indexes links inside ordinary code fences too, which the
       rewriter refuses to touch) and never a subset. */
    const affected = affectedTargets(beforeDocs, mapping, this.index.linkTargets());
    const candidates: Array<{ path: string; markdown: string }> = [];
    for (const src of this.index.backlinkSources(affected)) {
      const disk = await this.vault.readDoc(src);
      if (!disk) continue; // vanished between the pass and here
      candidates.push({ path: mapping.get(src) ?? src, markdown: disk.markdown });
    }
    const rewrites = planLinkRewrites(beforeDocs, mapping, candidates);
    const pre = new Map(candidates.map((c) => [c.path, c.markdown]));

    /* ---------- write (rename first, then the rewrites) ---------- */

    let moved: { created: string | null } | null = null;
    const written: string[] = [];
    try {
      moved = await this.vault.moveNode(from, to);
      for (const r of rewrites) {
        await this.vault.writeDocAtomic(r.path, r.markdown);
        written.push(r.path);
      }
    } catch (err) {
      const message = String((err as Error)?.message || err);
      for (const p of written.reverse()) {
        try {
          await this.vault.writeDocAtomic(p, pre.get(p)!);
        } catch (rollbackErr) {
          process.stderr.write(`[z-notes] move rollback FAILED for ${p} — ${String(rollbackErr)}\n`);
        }
      }
      if (moved) {
        try {
          await this.vault.moveNode(to, from);
          // the scaffolding mkdir -p made for a target that no longer exists
          if (moved.created) await rm(moved.created, { recursive: true, force: true }).catch(() => {});
        } catch (rollbackErr) {
          process.stderr.write(`[z-notes] move rollback FAILED for ${to} — ${String(rollbackErr)}\n`);
        }
      }
      await this.recon.reconcileHeld().catch(() => {});
      return fail(500, "move-failed", {
        path: from,
        message: `Could not move ${from} → ${to}: ${message}. Nothing was changed.`,
      });
    }

    if (kind === "dir") this.index.moveFolders(from, to);
    /* An applied AI proposal's pre-image is addressed by PATH. Leaving it behind
       made every revert below it unreachable forever: the drift guard read the
       old path, saw nothing, and answered 409 naming a file the user could no
       longer see. The change stack follows the doc. */
    this.index.moveProposalFiles(mapping);

    /* ---------- announce ---------- */

    const hints: ChangeHints = new Map<string, ChangeHint>();
    for (const [o, n] of mapping) {
      hints.set(o, { reason: "moved", to: n });
      hints.set(n, { reason: "moved", from: o });
    }
    for (const r of rewrites) if (!hints.has(r.path)) hints.set(r.path, "write");
    await this.recon.reconcileHeld(hints);

    /* ---------- one commit: a rename rewrites all backlinks in it ---------- */

    const links = rewrites.reduce((n, r) => n + r.links, 0);
    const message =
      `move: ${from} → ${to}` +
      (rewrites.length
        ? `\n\nRewrote ${links} [[link]]${links === 1 ? "" : "s"} in ${rewrites.length} doc${rewrites.length === 1 ? "" : "s"}.`
        : "");
    /* Both spellings of every file the rename actually touched — the `.md` docs
       the mapping knows about AND the non-`.md` payload only the filesystem saw. */
    const paths = [
      ...new Set([
        ...mapping.keys(),
        ...mapping.values(),
        ...payload,
        ...payload.map((p) => to + p.slice(from.length)),
        ...rewrites.map((r) => r.path),
      ]),
    ];
    const commit = await this.commitFileOp(paths, message);

    const doc = kind === "file" ? await this.docBody(to) : null;
    return json({
      ...this.moveOut(kind, from, to, doc, rewrites.map((r) => r.path).sort(), links, mapping),
      ...commit,
    });
  }

  /**
   * `commitPaths` reports every phase-2 guard (mid-merge, detached HEAD, a
   * credential canary, a case-only rename it could not stage) by RETURNING
   * `{committed:false, reason}` — it does not throw. Discarding that, as this
   * used to, meant a move or a delete answered 200/204 with a success toast while
   * nothing reached git and the index was left with a staged change the user was
   * never told about. `ai.accept()` already records the reason on the proposal;
   * the file ops put it on the wire and in the log.
   */
  async commitFileOp(paths: string[], message: string): Promise<{ committed: boolean; commitNote: string | null }> {
    let r = { committed: false, sha: null as string | null, reason: "git commit not attempted" };
    try {
      r = await this.git.commitPaths(paths, message);
    } catch (err) {
      r = { committed: false, sha: null, reason: String((err as Error)?.message || err) };
    }
    if (!r.committed) process.stderr.write(`[z-notes] commit skipped (${message.split("\n")[0]}) — ${r.reason}\n`);
    return { committed: r.committed, commitNote: r.committed ? null : r.reason };
  }

  moveOut(
    kind: "file" | "dir",
    from: string,
    to: string,
    doc: Awaited<ReturnType<typeof docBody>>,
    updated: string[],
    backlinksUpdated: number,
    mapping?: Map<string, string>
  ) {
    return {
      type: kind === "dir" ? "folder" : "file",
      path: to,
      from,
      rev: doc?.rev ?? null,
      bytes: doc?.bytes ?? null,
      mtime: doc?.mtime ?? null,
      backlinksUpdated,
      updated,
      ...(kind === "dir" ? { moved: [...(mapping ?? new Map())].map(([a, b]) => ({ from: a, to: b })) } : {}),
    };
  }

  /**
   * DELETE — a MOVE TO TRASH rather than an unlink.
   *
   * The doc (or the whole folder subtree) is renamed into `.znotes/trash/<id>/`,
   * which the vault scan, search and the backlink graph cannot see, and the
   * entry, the departure and everything the move carried land in ONE commit,
   * exactly as before. `removeNode` is not on this path any more: nothing in the
   * app unlinks a document the user asked to delete.
   *
   * Backlinks to a deleted doc are still deliberately NOT rewritten — they become
   * broken links, which the preview flags with a create-doc affordance. Rewriting
   * them would erase the only record that something used to be there, and it is
   * now doubly wrong: the doc may well come back.
   */
  async deleteNode(
    from: string,
    kind: "file" | "dir",
    subtree: string[],
    payload: string[]
  ): Promise<Response> {
    const gone = kind === "file" ? [from] : subtree;
    let meta;
    try {
      meta = await this.trash.put(from, kind === "file" ? "doc" : "folder", payload);
    } catch (err) {
      // the move either happened or it did not; there is no half-trashed state
      return fail(500, "delete-failed", {
        path: from,
        message: `Could not delete ${from}: ${String((err as Error)?.message || err)}`,
      });
    }
    if (kind === "dir") this.index.removeFolders(from);

    const hints: ChangeHints = new Map<string, ChangeHint>();
    for (const p of gone) hints.set(p, { reason: "deleted", trashId: meta.id });
    await this.recon.reconcileHeld(hints);

    /* the whole subtree, not just its `.md` docs — the rename took the
       attachments with it and no other git path can ever notice they left — plus
       the trash entry that now holds them, so the delete and its undo are the
       same commit and a clone can restore from it */
    const paths = [...new Set([...gone, ...payload, ...this.trash.entryGitPaths(meta.id, meta)])];
    // DELETE answers 204 with no body, so the skip reason goes to the log
    if (paths.length) await this.commitFileOp(paths, `delete: ${from}`);
    await this.announceTrash();
    /* Sweeping HERE as well as at boot and on the interval is what makes the
       retention window true for a long-lived server that is never restarted. It
       is deliberately after the response's own commit, so a sweep failure cannot
       turn a successful delete into a 500. */
  this.sweepTrash("after a delete").catch(() => {});
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  /* ============================================================
     Trash routes

     Every one of them runs under the reconcile lock, for the same reason the file
     ops do: restore WRITES into the vault, and the plan (is the path free? what
     is in the entry?) is only true while nothing else can move underneath it.
     ============================================================ */

  /** The trash list, pushed to every client — same body `GET /api/trash` serves. */
  async announceTrash() {
    try {
      this.broadcast("trash-changed", await this.trash.view());
    } catch (err) {
      process.stderr.write(`[z-notes] trash-changed failed: ${String(err)}\n`);
    }
  }

  /**
   * Apply the retention policy now. Runs at boot, every `TRASH_SWEEP_MS`, and
   * after every delete. One commit for the whole sweep — it is one decision, made
   * by a schedule, not N user actions.
   */
  async sweepTrash(why: string): Promise<string[]> {
    return this.recon.lock(async () => {
      const { purged, entryPaths } = await this.trash.sweep();
      if (!purged.length) return purged;
      process.stdout.write(
        `[z-notes] trash: purged ${purged.length} expired entr${purged.length === 1 ? "y" : "ies"} (${why})\n`
      );
      if (entryPaths.length) {
        await this.commitFileOp(entryPaths, `trash: purge ${purged.length} expired entr${purged.length === 1 ? "y" : "ies"}`);
      }
      await this.announceTrash();
      return purged;
    });
  }

  /** POST /api/trash/{id}/restore */
  async restoreTrash(id: string): Promise<Response> {
    return this.recon.lock(async () => {
      // the same opening move the file ops make: plan against an index that has
      // seen every byte on disk, with the lock held from that pass through the write
      await this.recon.reconcileHeld();
      let restored;
      try {
        restored = await this.trash.restore(id);
      } catch (err) {
        if (err instanceof TrashError) return fail(err.status, err.code, { message: err.message, ...err.extra });
        return fail(500, "restore-failed", {
          message: `Could not restore ${id}: ${String((err as Error)?.message || err)}`,
        });
      }
      const { meta, entryPaths } = restored;

      const hints: ChangeHints = new Map<string, ChangeHint>();
      for (const p of meta.docs) hints.set(p, { reason: "restored", trashId: meta.id });
      await this.recon.reconcileHeld(hints);

      const paths = [...new Set([...meta.files, ...entryPaths])];
      const commit = await this.commitFileOp(paths, `restore: ${meta.path}`);
      await this.announceTrash();

      const doc = meta.kind === "doc" ? await this.docBody(meta.path) : null;
      return json({
        type: meta.kind === "doc" ? "file" : "folder",
        id: meta.id,
        path: meta.path,
        kind: meta.kind,
        deletedAt: meta.deletedAt,
        restored: meta.docs,
        rev: doc?.rev ?? null,
        bytes: doc?.bytes ?? null,
        mtime: doc?.mtime ?? null,
        ...commit,
      });
    });
  }

  /** DELETE /api/trash/{id} — permanent, and the bytes really do go. */
  async purgeTrashEntry(id: string): Promise<Response> {
    return this.recon.lock(async () => {
      let out;
      try {
        out = await this.trash.purgeEntry(id);
      } catch (err) {
        if (err instanceof TrashError) return fail(err.status, err.code, { message: err.message, ...err.extra });
        return fail(500, "purge-failed", {
          message: `Could not delete trash entry ${id}: ${String((err as Error)?.message || err)}`,
        });
      }
      if (out.entryPaths.length) {
        await this.commitFileOp(out.entryPaths, `trash: delete ${out.meta?.path ?? id}`);
      }
      await this.announceTrash();
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    });
  }
}
