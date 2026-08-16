# 0022 — Asking before leaving edits is a preference

## Status

Accepted, 2026-08-16. Amends the unconditional Raw-exit question in
[the product spec](../specs/done/0001-z-notes-v1.md) §4 and the guard consequence
in [ADR 0012](0012-save-state-is-a-statusbar-pip.md).

## Context

The Raw exit gate protects source bytes that have not reached disk. Its only
policy was to stop every controllable exit and ask the user to Save or Discard.
That is the safest general default, but it adds a choice for users who always
want the staged buffer saved. Removing the gate for those users would be wrong:
a navigation must still wait for the write, and a failed write must not carry
the pane away from the only copy of the edits.

## Decision

**Whether a dirty Raw exit asks or saves first is a stored Editor preference.**

- `editor.confirmBeforeExit` is a boolean, defaults to `true`, and is exposed
  as the brief Settings switch **Ask before leaving edits**.
- When on, the existing staged-diff dialog and Save / Discard choices are
  unchanged.
- When off, the same `guardRawExit` gate mounts no dialog. It holds the caller's
  destination, saves the active document, then replays that caller's own action
  only after the server confirms the write. A failed or conflicted write keeps
  Raw, its bytes and the destination in place.
- Only one exit owns the pending destination while its automatic save is in
  flight. A second gesture cannot stack another move behind the same write.
- Every existing in-app funnel shares the policy: Raw → Preview, another doc,
  Settings, browser Back, and a confirmed file action. The Settings-draft guard
  is a separate surface and does not read this preference.
- `visibilitychange` / `pagehide` retain their quiet keepalive flush. That page
  boundary cannot depend on an app modal or await a custom navigation gate.

## Consequences

- The shipped behavior does not change until the user turns the switch off.
- “No prompt” means save-before-leave, never discard-before-leave and never
  navigate-while-saving.
- The setting is committed with the vault, validated and healed with the other
  booleans, and applies live through the existing settings-changed path.
- Real-browser coverage pins the default question and the disabled policy at
  both a mode change and a document navigation.
