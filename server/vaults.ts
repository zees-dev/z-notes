/* ============================================================
   vaults.ts — the vault registry.

   One primary vault, N secondary vaults, one address grammar.

   The PRIMARY vault is the one `ZNOTES_VAULT` names. Its stack is built by
   index.ts exactly as it always was and handed here; its doc paths stay bare,
   which is what keeps every existing URL, client and test valid unchanged.

   A SECONDARY vault is a direct subdirectory of the vaults home whose name is a
   vault id. It gets the SAME stack the primary has — Vault + Index + Settings +
   Reconciler + Trash + GitSync + DocStore — so per-vault git sync, trash,
   retention, search index and fs watcher come for free rather than being
   re-implemented. Its docs are addressed `@<id>/<vault-relative path>`.

   THE PREFIX STOPS HERE. Nothing below this module ever sees an `@<id>/`:
   paths going down are stripped to the bare vault-relative form, and paths
   coming back up are re-qualified. That is what keeps markdown, `[[links]]`
   and git pathspecs free of it, so a vault repo stays portable.

   THE REGISTRY IS THE FILESYSTEM. There is no registry file and no sqlite
   table — a second source of truth is exactly what a clone or a restore of the
   vaults home would silently miss. Directories carry their own `.znotes/` and
   describe themselves.
   ============================================================ */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Index, type SearchHit } from "./db.ts";
import { GitSync, sanitizeRemote, validRemoteUrl } from "./git.ts";
import { Settings, type SettingsFanout } from "./settings.ts";
import { Trash, isTrashId } from "./trash.ts";
import { Reconciler, type DocChange } from "./watch.ts";
import { DocStore } from "./docs.ts";
import { safePath, Vault } from "./vault.ts";

/** The primary vault's id — reserved, and never spelled as a prefix. */
export const PRIMARY_VAULT_ID = "vault";

/** The id grammar. Also the directory-name grammar under the vaults home. */
export function validVaultId(s: unknown): s is string {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(s);
}

/** A vault-relative path as the outside world addresses it. Identity for the primary. */
export function qualify(id: string, rel: string): string {
  return id === PRIMARY_VAULT_ID ? rel : `@${id}/${rel}`;
}

/** Deep-copy a `buildTree` result with every `path` prefixed. Empty prefix ⇒ the same nodes. */
export function prefixTree<T>(nodes: T[], prefix: string): T[] {
  if (!prefix) return nodes;
  return nodes.map((n) => {
    const node = n as any;
    return node.type === "folder"
      ? { ...node, path: prefix + node.path, children: prefixTree(node.children ?? [], prefix) }
      : { ...node, path: prefix + node.path };
  }) as T[];
}

export interface VaultStack {
  /** `vault` for the primary. */
  id: string;
  vault: Vault;
  index: Index;
  settings: Settings;
  recon: Reconciler;
  trash: Trash;
  git: GitSync;
  docs: DocStore;
}

/** What `GET /api/vaults` and the `vaults[]` array of `GET /api/docs` carry. */
export interface VaultDescriptor {
  id: string;
  label: string;
  root: string;
  docCount: number;
  remote: string | null;
  repo: boolean;
  prefix: string;
  sync: unknown;
  git?: unknown;
  tree?: unknown;
}

/** Where a qualified path resolved to, or why it did not. */
export type DocTarget =
  | { stack: VaultStack; rel: string }
  | { unknownVault: string };

export type AddResult =
  | { ok: true; vault: VaultDescriptor }
  | { ok: false; status: number; body: { error: string; message: string; [k: string]: unknown } };

interface RegistryDeps {
  primary: VaultStack;
  /** `ZNOTES_VAULTS_DIR`, already resolved. Not created until a vault is added. */
  vaultsDir: string;
  /** the shared SSE bus */
  broadcast: (event: string, data: unknown) => void;
  /** the ONE vault epoch, persisted in the primary index */
  bumpEpoch: () => void;
  log: (line: string) => void;
  /** argv-only, like the primary's — never handed an environment */
  gitLog: (line: string) => void;
}

const errorBody = (error: string, message: string, extra: Record<string, unknown> = {}) => ({
  error,
  message,
  ...extra,
});

/* ============================================================
   VaultRegistry
   ============================================================ */

export class VaultRegistry {
  readonly primary: VaultStack;
  private readonly secondary = new Map<string, VaultStack>();
  /** true when the vaults home and the primary vault nest — see `checkNesting`. */
  private readonly nested: boolean;
  private announcing = false;
  private announceAgain = false;

  constructor(private readonly deps: RegistryDeps) {
    this.primary = deps.primary;
    this.nested = this.checkNesting();
  }

  /* ---------- membership ---------- */

  /** Primary first, then the secondaries by id — the order every aggregate uses. */
  stacks(): VaultStack[] {
    return [this.primary, ...[...this.secondary.keys()].sort().map((id) => this.secondary.get(id)!)];
  }

  get(id: string): VaultStack | null {
    if (id === PRIMARY_VAULT_ID) return this.primary;
    return this.secondary.get(id) ?? null;
  }

  /* ---------- addressing ---------- */

  /**
   * `@work/inbox.md` → that stack + `inbox.md`; `notes/a.md` → the primary.
   *
   * The `@<id>` segment is resolved BEFORE `safePath`, which is what makes the
   * grammar unambiguous: `safePath` refuses every `@`-prefixed segment, so a
   * first segment that looks like a vault reference can never also be a real
   * primary-vault folder. Null = not a legal path at all (400 bad-path).
   */
  resolveDocPath(p: unknown): DocTarget | null {
    if (typeof p !== "string" || !p) return null;
    const cut = p.indexOf("/");
    const head = cut < 0 ? p : p.slice(0, cut);
    const m = /^@([a-z0-9-]+)$/.exec(head);
    if (!m) {
      const rel = safePath(p);
      return rel ? { stack: this.primary, rel } : null;
    }
    const stack = this.get(m[1]);
    if (!stack) return { unknownVault: m[1] };
    const rel = cut < 0 ? null : safePath(p.slice(cut + 1));
    return rel ? { stack, rel } : null;
  }

  /**
   * The trash-route pre-gate: `@work/m7k2x9-4f1a8b3c` → that stack + the bare
   * id. Null when what is left is not an id this server minted.
   */
  resolveTrashId(raw: unknown): { stack: VaultStack; id: string } | { unknownVault: string } | null {
    if (typeof raw !== "string") return null;
    const m = /^@([a-z0-9-]+)\/(.*)$/.exec(raw);
    const stack = m ? this.get(m[1]) : this.primary;
    if (!stack) return { unknownVault: m![1] };
    const id = m ? m[2] : raw;
    return isTrashId(id) ? { stack, id } : null;
  }

  /**
   * Rewrite the path-bearing fields of a stack's JSON reply into the addresses
   * the caller used. Identity for the primary, and for 204s and non-JSON.
   *
   * Values are rewritten in place on an already-parsed object, so the key order
   * the contract pins survives the round trip.
   */
  async requalify(stack: VaultStack, res: Response): Promise<Response> {
    if (stack.id === PRIMARY_VAULT_ID) return res;
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;
    const text = await res.text();
    if (!text) return new Response(null, { status: res.status, headers: res.headers });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return new Response(text, { status: res.status, headers: res.headers });
    }
    requalifyBody(stack.id, body);
    return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
  }

  /* ---------- display ---------- */

  /**
   * What the tree calls this vault. From the cached snapshot — no git spawn.
   *
   * The raw basename, NOT `vaultName()`'s parent-borrowing rule: that rule
   * exists for the legacy `vault.name` field and would make two vaults named
   * `vault` both read as their parent directory.
   */
  labelOf(stack: VaultStack): string {
    const snap = stack.git.snapshot();
    const base = basename(resolve(stack.vault.root));
    if (snap.remote) return snap.remote.split("/").filter(Boolean).pop() || base;
    return snap.state === "offline" ? `${base} (unsynced)` : base;
  }

  /** The descriptor minus `tree`, plus the per-vault `git` block. Never spawns. */
  descriptor(stack: VaultStack): VaultDescriptor {
    const git = (stack.settings.get().settings as any).git ?? {};
    return {
      ...this.baseDescriptor(stack, stack.index.allFileMeta().length),
      git: {
        branch: git.branch,
        autoSync: git.autoSync,
        autoSyncSeconds: git.autoSyncSeconds,
        tokenMasked: git.tokenMasked,
      },
    };
  }

  private baseDescriptor(stack: VaultStack, docCount: number): VaultDescriptor {
    const snap = stack.git.snapshot();
    return {
      id: stack.id,
      label: this.labelOf(stack),
      root: stack.vault.realRoot,
      docCount,
      remote: snap.remote,
      // "offline" is published exactly when the directory is not a repository
      repo: snap.state !== "offline",
      prefix: stack.id === PRIMARY_VAULT_ID ? "" : `@${stack.id}/`,
      sync: snap,
    };
  }

  /** `GET /api/vaults`, and the payload of every `vaults-changed` frame. */
  vaultsBody(): { vaults: VaultDescriptor[] } {
    return { vaults: this.stacks().map((s) => this.descriptor(s)) };
  }

  announceVaults(): void {
    this.deps.broadcast("vaults-changed", this.vaultsBody());
  }

  /** The vault (other than `exclude`) already holding this remote, if any —
      one remote, one vault, whether it arrives via add or via re-point. */
  remoteTakenBy(url: string, exclude: string): string | null {
    const wanted = sanitizeRemote(url);
    if (!wanted) return null;
    for (const stack of this.stacks()) {
      if (stack.id !== exclude && stack.git.snapshot().remote === wanted) return stack.id;
    }
    return null;
  }

  /* ---------- aggregates ---------- */

  /**
   * `GET /api/docs`. `vault` and `tree` are the PRIMARY's, byte-compatible with
   * the single-vault contract; `vaults[]` is the whole picture, each secondary
   * tree carrying qualified paths so the client uses them verbatim.
   */
  async treeBody(): Promise<{ vault: unknown; tree: unknown; vaults: VaultDescriptor[] }> {
    let legacy: { vault: unknown; tree: unknown } | null = null;
    const vaults: VaultDescriptor[] = [];
    for (const stack of this.stacks()) {
      const t = await stack.docs.treeResponse();
      if (stack === this.primary) legacy = t;
      vaults.push({
        ...this.baseDescriptor(stack, (t.vault as any).docCount),
        tree: prefixTree(t.tree as unknown[], stack.id === PRIMARY_VAULT_ID ? "" : `@${stack.id}/`),
      });
    }
    return { vault: legacy!.vault, tree: legacy!.tree, vaults };
  }

  /** `GET /api/search` across every stack: qualify, merge, re-sort, clamp. */
  search(q: string, limit: number): SearchHit[] {
    if (!this.secondary.size) return this.primary.index.search(q, limit);
    const out: SearchHit[] = [];
    for (const stack of this.stacks()) {
      for (const hit of stack.index.search(q, limit)) {
        out.push(stack.id === PRIMARY_VAULT_ID ? hit : { ...hit, path: qualify(stack.id, hit.path) });
      }
    }
    out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return out.slice(0, limit);
  }

  /**
   * The one trash drawer. Every entry says which vault it came from; a
   * secondary's `id` and `path` are qualified, so restoring one is the same
   * round trip as restoring a primary entry.
   *
   * `retentionDays` is the primary's — each entry's own `purgeAt` already
   * carries the truth for the vault it lives in.
   */
  async trashView(): Promise<{ retentionDays: number; entries: unknown[] }> {
    const entries: any[] = [];
    for (const stack of this.stacks()) {
      for (const e of await stack.trash.list()) {
        const out: any = { ...e, vault: stack.id };
        if (stack.id !== PRIMARY_VAULT_ID) {
          out.id = qualify(stack.id, e.id);
          out.path = qualify(stack.id, e.path);
          if (out.blockedBy) out.blockedBy = qualify(stack.id, out.blockedBy);
        }
        entries.push(out);
      }
    }
    entries.sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt) || a.id.localeCompare(b.id));
    return { retentionDays: this.primary.trash.retentionDays(), entries };
  }

  /**
   * The aggregate view, pushed. Every DocStore's `trash-changed` is routed here
   * instead of onto the bus (see `docsBroadcast`), so one vault's delete still
   * produces one frame — carrying the whole drawer, which is what the panel
   * renders.
   */
  async announceTrash(): Promise<void> {
    /* Single-flight with a queued rerun, like the sync pipeline: building the
       aggregate walks every vault's trash directory, and a delete that lands
       during that walk must produce another frame rather than be dropped. */
    this.announceAgain = true;
    if (this.announcing) return;
    this.announcing = true;
    try {
      while (this.announceAgain) {
        this.announceAgain = false;
        this.deps.broadcast("trash-changed", await this.trashView());
      }
    } catch (err) {
      process.stderr.write(`[z-notes] trash-changed failed: ${String(err)}\n`);
    } finally {
      this.announcing = false;
    }
  }

  /** `POST /api/trash/purge` — every stack, one merged reply, ids qualified. */
  async trashPurge(body: any): Promise<{ purged: string[]; retentionDays: number; all: boolean }> {
    const purged: string[] = [];
    for (const stack of this.stacks()) {
      const res = await stack.docs.trashPurge(body);
      const out = (await res.json().catch(() => null)) as { purged?: string[] } | null;
      for (const id of out?.purged ?? []) purged.push(qualify(stack.id, id));
    }
    return { purged, retentionDays: this.primary.trash.retentionDays(), all: body?.all === true };
  }

  /* ---------- lifecycle ---------- */

  /**
   * Adopt every vault already on disk. Per-stack boot mirrors the primary's
   * order and is never fatal: a vault whose index or checkout is broken must
   * cost exactly itself, not the whole app.
   */
  async boot(): Promise<void> {
    if (this.nested) return;
    let names: string[];
    try {
      names = (await readdir(this.deps.vaultsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return; // no vaults home yet: the ordinary single-vault install
    }
    const primaryRoot = realish(this.primary.vault.root);
    for (const name of names) {
      const root = resolve(this.deps.vaultsDir, name);
      /* The primary lives here in the default layout, already built and already
         loaded. Skipped SILENTLY and by real path, not by name: registering it
         a second time would give one directory two indexes, two watchers and
         two git pipelines, and `vaults/notes` is as much the primary as
         `vaults/vault` is when ZNOTES_VAULT says so. */
      if (realish(root) === primaryRoot) continue;
      if (name === PRIMARY_VAULT_ID || !validVaultId(name)) {
        process.stderr.write(`[z-notes] vaults: skipping ${name} — not a vault id.\n`);
        continue;
      }
      try {
        const stack = await this.makeStack(name, root);
        await stack.recon.reconcile();
        stack.recon.start();
        await stack.git.start().catch(() => {});
        this.secondary.set(name, stack);
        this.deps.log(`vaults: @${name} ready (${this.labelOf(stack)})`);
      } catch (err) {
        process.stderr.write(`[z-notes] vaults: @${name} failed to load — ${String((err as Error)?.message || err)}\n`);
      }
    }
  }

  /**
   * Add a vault: the ADR 0017 attach, run against a directory this call just
   * created. Every guarantee attach makes is inherited, and every failure past
   * the mkdir removes the directory again — safe because nothing but this call
   * has ever written to it.
   */
  async addVault(url: unknown, name?: unknown, token?: unknown): Promise<AddResult> {
    if (this.nested) {
      return {
        ok: false,
        status: 409,
        body: errorBody(
          "vaults-nested",
          "The vaults home is inside the primary vault (or the other way round); secondary vaults are disabled until they are separated."
        ),
      };
    }

    const target = validRemoteUrl(String(url ?? ""));
    if (!target) {
      // the same refusal attachRemote answers with, made before any directory exists
      return {
        ok: false,
        status: 400,
        body: errorBody(
          "bad-url",
          "A remote must be an https://, http:// or file:// URL, or an absolute path, and must not carry a username or password."
        ),
      };
    }

    const wanted = sanitizeRemote(target);
    const asked = typeof name === "string" && name.trim() ? name.trim().slice(0, 64) : lastSegment(wanted);
    const id = slugifyVaultId(asked);
    if (!validVaultId(id)) {
      return { ok: false, status: 400, body: errorBody("bad-name", "A vault name must contain a letter or a digit.") };
    }
    if (id === PRIMARY_VAULT_ID) {
      return { ok: false, status: 400, body: errorBody("bad-name", "`vault` is the primary vault's id.") };
    }
    if (this.get(id)) {
      return { ok: false, status: 409, body: errorBody("exists", `A vault @${id} is already connected.`) };
    }
    for (const stack of this.stacks()) {
      if (wanted && stack.git.snapshot().remote === wanted) {
        return {
          ok: false,
          status: 409,
          body: errorBody("exists", `@${stack.id} is already connected to ${wanted}.`),
        };
      }
    }

    const dir = resolve(this.deps.vaultsDir, id);
    try {
      mkdirSync(this.deps.vaultsDir, { recursive: true });
      // a directory that is already there was either a boot-scanned vault or is
      // not ours to write into — either way this call did not create it, so the
      // rollback below could not honestly remove it
      mkdirSync(dir);
    } catch {
      // `exists` only when it does: an EACCES or a full disk is not a name
      // collision, and telling the user to pick another name would not help
      if (existsSync(dir)) {
        return {
          ok: false,
          status: 409,
          body: errorBody("exists", `${dir} already exists — remove it by hand, or add the vault under another name.`),
        };
      }
      return { ok: false, status: 500, body: errorBody("write-failed", `${dir} could not be created.`) };
    }

    let stack: VaultStack | null = null;
    const undo = async (): Promise<void> => {
      if (stack) {
        stack.recon.stop();
        stack.git.stop();
        stack.index.close();
      }
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    };

    try {
      stack = await this.makeStack(id, dir);
      /* One account, N repos is the common case, so the primary's token is
         COPIED into the new vault's own store unless the caller said otherwise.
         An explicit empty string is how you attach anonymously. */
      const explicit = typeof token === "string" ? token : null;
      const inherited = explicit === null ? this.primary.settings.credential("git.token") : null;
      const use = explicit ?? inherited;
      if (use) stack.index.setCredential("git.token", use);

      const attached = await stack.git.attachRemote(target);
      if (!attached.ok) {
        await undo();
        return { ok: false, status: attached.status, body: attached.body };
      }

      /* putRoute rather than a bare write, exactly as the primary's attach
         route does it: it opens with reloadIfChanged(), which is what adopts a
         settings.toml that just arrived in the checkout. */
      const saved = await stack.settings.putRoute({ git: { branch: attached.branch } });
      if (saved.status !== 200) {
        process.stderr.write(
          `[z-notes] vaults: @${id} git.branch=${attached.branch} was not persisted (${(saved.body as any)?.error ?? saved.status})\n`
        );
      }

      this.secondary.set(id, stack);
      await stack.recon.reconcile();
      stack.recon.start();
      // there is no public status refresh but start(); trigger() both pushes
      // whatever the checkout brought and leaves the snapshot truthful
      await stack.git.trigger("manual").catch(() => {});
      const descriptor = this.descriptor(stack);
      this.announceVaults();
      this.deps.log(`vaults: @${id} added (${descriptor.label})`);
      return { ok: true, vault: descriptor };
    } catch (err) {
      this.secondary.delete(id);
      await undo();
      return {
        ok: false,
        status: 502,
        body: errorBody("attach-failed", `Could not add the vault: ${String((err as Error)?.message || err)}`),
      };
    }
  }

  /**
   * Disconnect a vault. THE DIRECTORY STAYS ON DISK — disconnecting is a
   * registry operation and deleting is a human one, so a mis-click can never
   * cost a repository.
   */
  async removeVault(id: string): Promise<boolean> {
    if (id === PRIMARY_VAULT_ID) throw new Error("the primary vault cannot be disconnected");
    const stack = this.secondary.get(id);
    if (!stack) return false;
    this.secondary.delete(id);
    stack.recon.stop();
    stack.git.stop();
    stack.index.close();
    this.announceVaults();
    this.deps.log(`vaults: @${id} disconnected (${stack.vault.root} stays on disk)`);
    return true;
  }

  /* ---------- construction ---------- */

  /**
   * The primary's wiring shape, for a secondary. Everything per-vault points at
   * this stack; the AI hooks are no-ops because there is one relay and it
   * belongs to the primary.
   */
  private async makeStack(id: string, root: string): Promise<VaultStack> {
    mkdirSync(root, { recursive: true });
    const vault = new Vault(root);
    const index = new Index(vault.dbPath);
    // adoptEnvToken=false: ZNOTES_GIT_TOKEN is primary-only provisioning — a
    // secondary's credential is the explicit token, the deliberate copy of the
    // primary's, or nothing at all (an anonymous attach stays anonymous)
    const settings = new Settings(vault, index, false);
    await settings.load();

    let git!: GitSync;
    const recon = new Reconciler(vault, index, (change) => {
      this.deps.bumpEpoch();
      this.deps.broadcast("doc-changed", qualifyChange(id, change));
      git.schedule();
    });
    const trash = new Trash({ vault, settings, log: this.deps.log });
    git = new GitSync({
      vault,
      settings,
      index,
      onStatus: (s) => this.deps.broadcast("sync-status", { ...s, vault: id }),
      log: this.deps.gitLog,
    });
    const docs = new DocStore({ vault, index, recon, trash, git, broadcast: this.docsBroadcast });
    const stack: VaultStack = { id, vault, index, settings, recon, trash, git, docs };

    const fanout: SettingsFanout = {
      applyGit: () => git.applySettings(),
      scheduleSync: () => git.schedule(),
      aiSettingsSaved: async () => {},
      aiEffortChanged: () => {},
      aiAnnounce: () => {},
      /* A secondary's settings.toml is NOT the app's settings — only its `git`
         and `trash` sections are consumed here, and the rest rides along for
         whatever other install uses that repo as ITS primary. Publishing it as
         `settings-changed` would let it overwrite the app's own settings in
         every open client. The registry announces `vaults-changed` instead. */
      broadcast: (event, data) => {
        if (event !== "settings-changed") this.deps.broadcast(event, data);
      },
      retentionDays: () => trash.retentionDays(),
      sweepTrash: (why) => docs.sweepTrash(why),
      announceTrash: () => docs.announceTrash(),
    };
    settings.wire(fanout);
    return stack;
  }

  /**
   * The broadcast every DocStore gets, the primary's included. `trash-changed`
   * is the one event no single stack can answer — the drawer is the union — so
   * it is turned into the registry's aggregate announcement. Everything else
   * goes straight to the bus.
   */
  readonly docsBroadcast = (event: string, data: unknown): void => {
    if (event === "trash-changed") {
      this.announceTrash().catch(() => {});
      return;
    }
    this.deps.broadcast(event, data);
  };

  /**
   * Which overlaps of the two paths are a mistake, and which one is the layout.
   *
   * THE LAYOUT: the primary sitting directly inside the vaults home
   * (`vaults/vault`) is the DEFAULT — one directory, one subdirectory per
   * repository. Nothing is indexed twice because `boot()` skips whichever
   * subdirectory is the primary, by real path, before it registers anything.
   *
   * THE MISTAKES, both of which double-index:
   *   · the home INSIDE the primary — the primary's own scan walks down into
   *     every secondary, so their docs become its docs;
   *   · the primary DEEPER than a direct child (`vaults/a/b`) — the scan
   *     registers `a` as a vault whose tree contains the primary.
   * Either one costs the secondaries, never the app.
   */
  private checkNesting(): boolean {
    const home = realish(this.deps.vaultsDir);
    const primary = realish(this.primary.vault.root);
    if (dirname(primary) === home) return false; // the default layout
    const nested = home === primary || home.startsWith(primary + "/") || primary.startsWith(home + "/");
    if (nested) {
      process.stderr.write(
        `[z-notes] vaults: ${home} and the primary vault ${primary} are nested; secondary vaults are disabled.\n`
      );
    }
    return nested;
  }
}

/* ---------- helpers ---------- */

/**
 * The symlink-resolved path, for a path that may not exist yet — the vaults
 * home usually does not. Resolves the deepest existing ancestor and re-attaches
 * the missing tail, because comparing a resolved path with an unresolved one is
 * how `/var/…` and `/private/var/…` come out looking like different places.
 */
function realish(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : resolve(realish(parent), basename(abs));
  }
}

const lastSegment = (s: string | null) => (s ? (s.split("/").filter(Boolean).pop() ?? "") : "");

/** `github.com/z/Work Notes` → `work-notes`. */
function slugifyVaultId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** A `DocChange` with its paths in the caller's address space, key order intact. */
function qualifyChange(id: string, change: DocChange): DocChange {
  const out: any = { ...change };
  out.path = qualify(id, change.path);
  if (typeof out.from === "string") out.from = qualify(id, out.from);
  if (typeof out.to === "string") out.to = qualify(id, out.to);
  if (typeof out.trashId === "string") out.trashId = qualify(id, out.trashId);
  return out as DocChange;
}

/** Every path-bearing field a doc/trash reply can carry, rewritten in place. */
function requalifyBody(id: string, body: unknown): void {
  if (!body || typeof body !== "object") return;
  const b = body as Record<string, any>;
  const q = (v: unknown) => (typeof v === "string" && v ? qualify(id, v) : v);
  for (const k of ["path", "from", "to", "blockedBy", "trashId"]) if (k in b) b[k] = q(b[k]);
  // the only `id` a doc or trash reply carries is a trash id
  if (isTrashId(b.id)) b.id = qualify(id, b.id);
  for (const k of ["updated", "restored", "paths", "purged"]) if (Array.isArray(b[k])) b[k] = b[k].map(q);
  if (Array.isArray(b.moved)) {
    for (const m of b.moved) {
      if (!m || typeof m !== "object") continue;
      m.from = q(m.from);
      m.to = q(m.to);
    }
  }
}
