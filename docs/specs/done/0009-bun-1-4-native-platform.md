# 0009 — Bun 1.4: the native platform pass

## Problem Statement

The repo runs on Bun 1.4.0 locally, but `deploy/Dockerfile` (three `FROM
oven/bun:1.3.14-slim` stages) and `.github/workflows/ci.yml`
(`BUN_VERSION: "1.3.14"`) still pin 1.3.14, and three modules carry
implementation weight that exists only to route around that version:

1. **`server/terminal.ts`** — the header (lines 4–8) says "Bun 1.3.14 has no
   PTY" and `killTree()` (lines 558–600) spawns `ps -A -o pid=,ppid=`,
   regex-parses the table, and walks the parent→child map to signal a
   cancelled command's subtree, because (comment at line 559) "Bun.spawn has
   no `detached`, and there is no `setsid` on macOS". `deploy/Dockerfile`
   installs `procps` (line 95, comment 86–90) solely so that `ps` exists in
   the image.
2. **`server/ai-edits.ts`** — the `diff` npm package is a runtime dependency
   used in exactly one place: `import { structuredPatch } from "diff"` (line
   20), consumed by `buildDiff()` (line 374) to render a proposal's diff rows.
   `node:util.diff` is `undefined` at runtime on Bun 1.4.0 (verified by
   execution), so the platform offers no replacement; the dependency has to
   be replaced by our own code or kept.
3. **The test suite** (47 files, ~12 min) runs serially although every file
   already spawns its own server on its own port against its own temp vault
   (`tests/helpers.ts` `startServer()`): the isolation Bun 1.4's `--isolate`
   exists to impose is already this harness's design.

Facts established by probing Bun 1.4.0 (do not re-verify these; build on them):

- `Bun.spawn(argv, { detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe" })`
  makes the child its own process-group leader (pgid == pid); `process.kill(-pid, sig)`
  then reaches the whole group — a `sleep 300 &` grandchild died with the shell.
  stdin writes and exit codes are unaffected.
- `Bun.spawn({ terminal: {...} })` (the new PTY) overrides `stdout`/`stderr`
  pipes: all three fds become the PTY and the output is ONE merged stream.
  The HTTP contract (`docs/specs/done/0002-http-api-v0.md`, § Terminal)
  streams `stdout` and `stderr` as separate SSE events, so the PTY is NOT
  usable here.
- `proc.killed` is still `true` for a child that exited 0 on 1.4.0. The
  workaround at `server/git.ts:784–789` stays; only its comment changes.
- `bun --no-orphans <script>` is accepted on 1.4.0 and makes the child exit
  when its parent dies.
- Static-file serving stays hand-rolled: `Bun.serve` `{ dir }` routes ignore a
  `headers` option (no way to send `cache-control: no-cache`), and a
  `Response(Bun.file(...))` from `fetch()` gets no ETag/304 (Range/206 it now
  gets for free). `tests/api.test.ts:123`, `tests/routing.test.ts:143,160` and
  `tests/secrets.test.ts:644–655` pin the current ETag behaviour.
- `bun test --parallel[=N]` (implies `--isolate`), `{ retry: n }`, `--timings`
  exist on 1.4.0.

## Solution

Bump the pin to 1.4.0 everywhere, then let the platform carry what it now
carries:

- **Terminal:** spawn the shell `detached: true` and signal the process group
  with `process.kill(-pid, signal)`. Delete `killTree()` and the `procps`
  package. The contract (separate `stdout`/`stderr` events, cd persistence
  via the wrapper, stdin, cancel semantics) is byte-for-byte unchanged.
- **Diff:** replace the `diff` package with an in-house line-level Myers diff
  inside `server/ai-edits.ts` that produces the same rows `buildDiff()`
  produces today (hunks with 2 lines of context, `+`/`-`/` ` markers, CRLF
  stripped from row text, the 1 s deadline that yields the "diff too large"
  row). `diff` leaves `package.json`; `bun.lock` is regenerated. The repo's
  runtime dependency list becomes `age-encryption` only.
- **Tests:** `bun test --parallel` for the local `test` script and the CI
  full-suite job, sized by measurement; `--no-orphans` on the harness's
  server spawn.
- **Scripts:** `scripts/build-mermaid.ts` hashes with `Bun.CryptoHasher`
  instead of `node:crypto` (same sha256 hex, same banner).
  `scripts/make-icons.ts` keeps its rasteriser and hands the pixels to
  `Bun.Image` for PNG encoding IF `new Bun.Image(rgba, { width, height, channels: 4 })`
  is verified to treat the buffer as raw pixels (decode the result back and
  check width/height; look at the PNG). If it does not, leave the script
  untouched and say so in the report.

## User Stories

1. As the operator, I want the image and CI to run the Bun the repo is
   developed on, so that measured workarounds and the shipped runtime agree.
2. As a terminal user, when I press Stop/Ctrl+C on `sleep 300` (or a build that
   forked children), I want every process the command started to die, so that
   the output stream closes and the next command can run — on macOS and in
   the Linux container, with no `ps` binary required.
3. As a terminal user, I want stdout and stderr to keep arriving as separate
   `stdout`/`stderr` events, so that the panel's tagging and the AI's
   transcript are unchanged.
4. As a terminal user, I want a command that typed to stdin (`read x`) and a
   command that exits non-zero to behave exactly as before.
5. As the operator, when the server shuts down with a command running, I want
   that command's whole group killed, as today.
6. As an AI-proposal reviewer, I want the diff card to show the same rows it
   shows today (context 2, `+`/`-` markers, CRLF-free text, "diff too large to
   render" when the diff cannot be computed in 1 s, "… diff truncated" past
   `MAX_DIFF_LINES`), so that nothing about the review surface changes.
7. As a maintainer, I want the runtime dependency list to be `age-encryption`
   alone, so that the zero-dependency rule has one exception, not two.
8. As a developer, I want `bun test` to finish in minutes, not twelve, with no
   test becoming flaky from the parallelism (port collisions, Chromium
   contention), so that the suite is run more often.
9. As a developer, when a test worker dies, I want the servers it spawned to
   die with it, so that no orphaned `bun server/index.ts` lingers.
10. As a maintainer regenerating the mermaid bundle, I want the same banner and
    the same sha256 hex as before, so `tests/mermaid.test.ts` still parses it.

## Implementation Decisions

**Pin bump.**
- `deploy/Dockerfile` lines 43, 68, 79: `oven/bun:1.3.14-slim` → `oven/bun:1.4.0-slim`
  (tag verified to exist on Docker Hub).
- `.github/workflows/ci.yml:31`: `BUN_VERSION: "1.4.0"`.
- Every comment naming `1.3.14` is updated to say what was measured on 1.4.0
  (`grep -rn "1.3.14" server deploy .github scripts tests` — note
  `tests/api.test.ts` has NUL bytes; use `grep -a`).

**Terminal (`server/terminal.ts`).**
- The spawn at line 689 gains `detached: true`. Everything else about the
  spawn (argv `[shell, "-lc", this.wrap(command)]`, `cwd`, `env`, the three
  pipes) is unchanged.
- `killTree(pid, signal)` is deleted. Its three call sites — `cancelRun()`
  (lines 613 and 616) and the shutdown path (line 1027) — call a new
  `private signalGroup(pid: number, signal: NodeJS.Signals)` that does
  `process.kill(-pid, signal)` and, if that throws (ESRCH: the group is
  already gone, or a platform without groups), falls back to
  `process.kill(pid, signal)` inside its own try/catch. It is synchronous;
  drop the `await`s and `.catch(() => {})` that only existed for the `ps`
  spawn.
- Header comment (lines 4–8 and the paragraph at 559): rewrite to the truth —
  Bun 1.4 has a PTY (`Bun.spawn({ terminal })`) but it merges stdout and
  stderr, which this contract streams separately, so the runner stays
  pipe-based; `detached: true` makes the shell a process-group leader and
  cancel signals the group. Keep the rest of the header (cd persistence,
  auth) verbatim.
- `deploy/Dockerfile`: remove `procps` from the `apt-get install` line (95)
  and its comment block (86–90); reword the "Three packages" line to two.
- `docs/specs/done/0002-http-api-v0.md` § Terminal (line ~1278, "bun has no
  PTY, so full-screen ... cannot work"): reword to "the runner is deliberately
  not a PTY (Bun's PTY merges stdout and stderr, which this contract streams
  separately), so full-screen ...". No shape changes anywhere in the spec.

**Diff (`server/ai-edits.ts`).**
- Remove `import { structuredPatch } from "diff"`. Add, non-exported, in the
  "Unified diff" section:
  ```ts
  /** Line-level Myers diff → hunks with `context` lines, or null past the deadline. */
  function lineHunks(pre: string, post: string, context: number, deadlineMs: number): string[][] | null
  ```
  returning, per hunk, the rows as jsdiff did (`"+text"`, `"-text"`, `" text"`),
  so the loop in `buildDiff()` (lines 386–398) keeps its shape minus the
  `line.startsWith("\\")` skip, which no longer applies. Split both sides on
  `\n` (a trailing empty element after a final newline is dropped on both
  sides). Myers O(ND) with the greedy forward pass over an edit-graph
  (V array per D); check `performance.now()` against the deadline once per D
  iteration and return `null` when it passes — that is what keeps the
  measured 4k–10k-line worst case from stopping the one replica (see the
  comment at lines 361–371, keep it, reword "jsdiff" to "Myers").
- `buildDiff()` calls `lineHunks(f.pre, f.post, 2, 1000)`; `null` → the
  existing "diff too large to render" row. Row text still has `\r$` stripped.
- `package.json`: delete `"diff": "9.0.0"`. Run `bun install` so `bun.lock`
  drops it. `bun pm ls` must show `age-encryption` as the only runtime dep.
- `AGENTS.md` hard rule: "Zero runtime deps beyond `age-encryption`; no
  frontend build step." Keep the file ≤ 100 lines (`bun run lint:docs`).
- `docs/style.md`: if it names `diff` as a dependency, update the sentence.
- New ADR `docs/decisions/0029-the-proposal-diff-is-in-house.md` (format: copy
  `0025-the-chat-panel-answers-to-alt-c.md` — Status / Context / Decision /
  Consequences). Context: one call site, `node:util.diff` absent on Bun 1.4.0,
  the zero-dependency rule. Decision: the Myers implementation in
  `ai-edits.ts` is the diff; it is bounded by a deadline, not by size.
  Register it in the ADR sentence list in `AGENTS.md` (the long paragraph
  ending "...before its lines are scored.").

**Test runner.**
- `tests/helpers.ts:420`: `Bun.spawn(["bun", "--no-orphans", "server/index.ts"], …)`.
- Measure: `time bun test` (serial, once) vs `time bun test --parallel` and
  `--parallel=4` on this machine, twice each; note failures. Pick the fastest
  setting with zero new failures for `package.json` `"test"`. In
  `.github/workflows/ci.yml` the `full suite` job's `bun test` step (line ~224)
  gets `--parallel=2` (2-vCPU runners; two headless Chromiums at once is the
  safe ceiling). The six `gates` steps stay as they are.
- If `freePort()` (`tests/helpers.ts:172–178`) produces a port collision under
  `--parallel`, fix it at the source: have `startServer` pass `ZNOTES_PORT=0`
  ONLY if the server prints the bound port on its ready line — check
  `server/index.ts`'s "listening on" line; if it prints `PORT` from env, keep
  `freePort()` and add a bounded retry (3 attempts) on an `EADDRINUSE` in the
  spawned server's stderr. Do not add retries to tests to paper over this.

**Scripts.**
- `scripts/build-mermaid.ts:27,60`: `new Bun.CryptoHasher("sha256").update(js).digest("hex")`;
  drop the `node:crypto` import. Regenerating is NOT required (output is
  unchanged); do not run it.
- `scripts/make-icons.ts`: attempt `Bun.Image` as described in Solution; if
  adopted, regenerate `app/icons/*.png` with `bun scripts/make-icons.ts`,
  decode each back with `Bun.Image` and assert the expected dimensions
  (180/192/512), and keep `node:zlib` out. If not adopted, no change.

**Comments.** `server/git.ts:784`: "Bun 1.3.14 sets that" → "Bun (measured on
1.3.14 and 1.4.0) sets that".

## Testing Decisions

Seams: the existing HTTP-seam suites and pure-module imports. No new test
files except one.

- `tests/terminal.test.ts` (prior art for everything terminal): add one test —
  run `sleep 300 & echo child=$!; wait` through `POST /api/terminal/exec`,
  read the child pid from the `stdout` event, `POST /api/terminal/cancel`,
  then assert (via `process.kill(pid, 0)` throwing) that the grandchild is
  gone within 2 s and that the exec stream ended. If a test of this shape
  already exists, extend it rather than duplicating.
- `tests/ai-edits.test.ts` (new; pure import of `buildDiff` from
  `../server/ai-edits`): (a) a one-line replacement in a 6-line doc yields
  rows `[" ", " ", "-", "+", " ", " "]`-shaped with 2 lines of context;
  (b) identical pre/post yields no rows; (c) CRLF input yields rows with no
  `\r`; (d) a pre/post pair of 20k unrelated lines yields the "diff too large
  to render" row (the deadline path) — keep this case's inputs small enough
  to construct fast. `tests/ai.test.ts:596–612` already asserts the
  proposal-level shape and must stay green.
- `tests/mermaid.test.ts` must stay green (banner parse).
- Full check: `bun run gates`, `bun run lint:docs`, then the full `bun test`
  with the chosen parallelism.

## Out of Scope

- Migrating static serving to `Bun.serve` `{ dir }` routes or the `/api`
  route table to `routes:` (probed: no `cache-control` control, contract
  ordering risks, three tests pin the current ETags).
- `Bun.markdown` (cannot match the ADR 0021 dialect), `Bun.TOML.stringify`
  (the settings writer injects comments), `Bun.password` (rejected in-source),
  `Bun.secrets` (ADR 0004), `Bun.WebView` replacing puppeteer-core (no Linux
  story), an SSE helper (none exists).
- Replacing `node:fs`/`node:path`/`node:crypto` imports with other spellings —
  Bun implements them natively; there is nothing to gain.
- Removing `age-encryption` (ADR 0004: the crypto is client-side, and Bun has
  no age implementation) or the two devDependencies.
- Any React/bundler/build-step change (ADR 0001, the no-build rule).
- Using `Bun.spawn({ terminal })` for the terminal (contract, see above).
- Adding `{ retry }` to tests — flakiness is fixed at its source or reported.
- Rebuilding/republishing the Docker image or touching `deploy/k3s/`.

## Further Notes

- Source-text tests (`docs/style.md` gotchas): `tests/fileops.test.ts` greps
  the three `ai*.ts` modules for rename/delete identifiers — the new diff code
  must not introduce identifiers like `rename`, `unlink`, `rm` or `delete` in
  `server/ai-edits.ts`; use `removed`/`dropped`.
- `tests/api.test.ts` contains NUL bytes; sweeps must use `grep -a`.
- Keep the gates green after every task; run single files while iterating.
