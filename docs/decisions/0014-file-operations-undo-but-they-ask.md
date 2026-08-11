# 0014 — One undo timeline for the whole app, and file operations ask

## Status

Accepted, 2026-08-11. **Supersedes the undo half of
[0013](0013-a-collapsed-caret-makes-x-and-c-take-the-line.md)**, which put every
Raw text edit on the textarea's own undo stack and deliberately bound nothing.
0013's `applyRawEdit` stays exactly as it is — it is still how a structural edit
mutates a textarea, and still what fires the `input` event the app listens to —
but the *history* is now the app's, not the browser's.

## Context

A session is one ordered list of things a person did: edited a.md, edited b.md,
deleted a.md. Walking it back is one gesture, and where it lands is wherever
the next step happens to be.

The browser's undo cannot express that list. It is per-TEXTAREA, and
`renderDoc` builds a new textarea for every doc opened — so the history dies at
each doc switch, and "undo my change to b.md while I am looking at a.md" is not
representable in it at all. Neither is a file operation: the trash drawer could
put a delete back four interactions later, and the chord every file manager
spends on exactly this did nothing.

Two stacks would have been the smaller change and the wrong one. Text and file
operations interleave in real use — the scenario above is three steps, of three
different kinds, in one order — and a person pressing ⌘Z three times means
"back, back, back", not "back through my edits, and separately back through my
deletions".

## Decision

**One timeline**, holding text edits and file operations in the order they
happened. ⌘Z walks it back, ⌘⇧Z walks it forward, and each step **takes the
pane to the document it is about** — an undo that silently rewrote a file you
were not looking at would be indistinguishable from nothing happening.

A delete undoes to a restore; a create undoes to a delete; a text edit undoes
to the text before it. Each direction is the other's mirror on redo.

### Typing is one entry per RUN

A run opens on the first edit to a doc and closes on the first of: a 700ms
pause, a save, a mode switch, a doc switch, a file operation, or the ⌘Z itself.
That is the granularity a person means by "what I just typed", and the
granularity every editor's undo has. `textMark` holds each doc's text as of its
last closed run — the `before` of whatever run opens next — and is re-seeded
from `setBaseline`, i.e. every route by which a document arrives from the
server. None of those is an edit, and recording one as if it were would make
⌘Z fight the server.

**File operations ask first; text edits do not.** That asymmetry is the point
of this ADR. A text undo is instant and reversible by the same
keystroke; these move a file on disk, through git, on a path another device may
be looking at. The chord is also one keystroke from a chord people press
reflexively in an editor, and the cost of a mis-fired ⌘Z here is a doc that
vanishes while the cost of the prompt is one Return.

The prompt is the app's existing `confirmDialog`, wearing the chrome that
matches the verb: a restore is **constructive** and takes the safe chrome
(`danger: false`), because a red button under a warning triangle over an action
that puts a file *back* tells the user the opposite of what the button does. A
delete keeps the destructive pattern and the trash-retention footer.

### The three ways it could have gone wrong

- **It must not take ⌘Z from a field that has its own.** The app owns the
  chord in `#rawArea` and nowhere else: the settings fields, the composer, the
  terminal line and an inline rename all keep the browser's native undo, which
  is the right history for a field. `typing()` — already the guard for ⌘C —
  makes that one distinction.
- **It must not swallow the chord when it has nothing to do with it.** With an
  empty timeline `pendingHistory` returns null and the handler returns before
  `preventDefault`, so the chord reaches the browser untouched.
- **It must not act underneath its own dialog.** `overlayOpen()` stands the
  chord down while any veil is up, so a second ⌘Z cannot swap the question out
  from under a pointer already on its way to Confirm.

### Where the state lives

`app/history.js` — a LEAF holding the two stacks and nothing else. Which module
knows how to put a *document* back and which knows how to put a *file* back is
injected by the composition root, the same `wireDialogs` shape dialogs.js
already uses. That is what lets a leaf drive editor.js and tree.js without
importing either of them, and it is why the timeline can be one list while the
two halves stay in the modules that own their subject.

Bounded at 60 entries, because each text entry holds two copies of a document.
Notes are small; sixty of them are not what will run this tab out of memory.

**A delete is not remembered by its trash id.** The id is resolved at undo
time, from the newest trash entry naming the path, because between the delete
and the ⌘Z that entry may have been restored from another device, purged, or
aged out — in which case the honest answer is "it is not in the trash any
more", not a 404 from a stale id.

**A restore goes through the trash, never through a re-create.** A file that
was deleted still has its bytes there, and re-creating it from the empty string
would be a different file wearing the same name. The create fallback exists
only for the case where the trash has no entry, and then it uses the markdown
the history captured on the way out.

**The stacks move only when the operation lands.** A restore refused because
something now occupies the path, a prompt the user cancels, and a delete the
Raw exit guard is still asking about all leave the entry where it was, still
offering. That is why `doDelete` reports completion through an `onDone`
callback rather than a returned boolean: it returns `false` for "deferred
behind the guard" as well as for "failed", and only the callback can tell those
apart.

**A deleted doc's older text entries stay on the timeline.** They are older
than the delete, so ⌘Z always reaches the delete first and the file is back
before any of them is applied. Dropping them — which the first cut of this did
— is what made "undo, undo, undo" stop one step short of the edit it was
walking back to. `applyTextHistory` still refuses an entry whose doc is
missing, for the one path that produces it: a restore the user declined.

**An undo is an edit.** It leaves the buffer dirty and the ordinary save path
takes it from there, rather than writing to disk itself. And a dirty buffer
being left behind by a step that navigates is SAVED, not discarded and not
turned into a modal: the chord is supposed to be seamless, and the buffer it is
leaving is the user's.

## Consequences

- `doDelete` returns a boolean and takes `noRecord` / `onDone`. Every existing
  caller (`askDelete`, the row affordance, the context menu, the Delete key on
  a focused row) is unchanged and now records its operation.
- Creates record from both routes — `commitCreate` and `createFromLink`.
- **Renames and moves are deliberately not in the history.** They are not
  destructive in the way a delete is, they already have an inverse the user can
  perform directly, and a rename undone under a `[[link]]` rewrite is a
  different and much larger question. Undoing one is still a rename.
- Ten cases are measured in `ux-e2e.test.ts`. Seven on the file half: the
  restore (asserted on the file's *bytes*, since a restore that re-created an
  empty file at the same path would pass every other assertion), the redo, a
  declined prompt leaving the undo on offer, a create undoing to a delete, the
  editor keeping its own ⌘Z, the empty stack leaving the chord alone, and the
  `?` overlay listing the chord. Three on the timeline: the full
  edit-a/edit-b/delete-a walk with its three ⌘Z landing in three different
  places, the same list walked forward again, and a run of typing coming back
  as ONE step rather than one per keystroke.
- The e2e fixtures that seed `#rawArea` by assignment now dispatch the `input`
  event too. The timeline learns a document's text from that event, so a value
  written behind its back would leave ⌘Z pointing at the text the doc had
  before the fixture ran — a property of the feature, surfaced by the tests
  rather than papered over in them.
