# 0006 — Change the assistant's effort from the model chip

## Problem Statement

The chat panel's header shows the **model chip** (`app/index.html:648`,
`.model-chip`): `<model> · <effort>`, painted by `updateSessionUI()`
(`app/chat.js`) from `state.session` — whose `effort` field is the server's
`effortInUse()`, i.e. the configured `ai.effort` after any degradation-ladder
walk. The chip is read-only. Changing effort today means leaving the chat for
Settings → AI, saving, and coming back. The user wants to change the
assistant's effort directly from that chip, mid-session.

The server already supports everything needed: `PUT /api/settings` with a
patch that **names** `ai.effort` resets the effort rung of the degradation
ladder even when the stored value did not move (`server/settings.ts`
`putRoute`, the `picksEffort` branch → `fanout.aiEffortChanged()`), announces
`ai-status` if the derived status changed, broadcasts `settings-changed` with
the full settings body, and schedules a vault sync. **This spec changes no
server code and no API contract** — it is a frontend affordance over the
existing surface.

## Solution

Make the model chip a button. Clicking it opens a small popover (same `.pop`
pattern as the session popover `#sessPop`, `app/index.html:669`) listing one
option per entry of `state.meta.efforts` (served by settings `META`,
`server/settings.ts:93` — `["low","medium","high"]`), the session's current
effort marked. Picking an option calls `api.patchSettings({ ai: { effort } })`
(`app/api.js:225`), then refetches the session (`api.getSession()`) and
repaints via `updateSessionUI()` — the refetch, not the pick, is what the chip
displays, because the chip's contract is *effort actually in use*, which only
the server knows.

Additionally, an adopted remote save that changed `ai.effort` refreshes the
session the same way, so the chip cannot go stale when another device moves
the setting: the `settings-changed` handler composition lives in
`app/shell.js` (`onSettingsChanged: adoptSettings`, line ~266), which already
imports both `adoptSettings` and `updateSessionUI` — wrap the handler there.

## User Stories

1. As the vault owner mid-chat, I want to click the model chip and pick a
   different effort, so that the next turn uses it without leaving the chat.
2. As the vault owner, I want the menu to mark the effort currently in use, so
   that I know what I am changing from.
3. As the vault owner whose endpoint has walked effort down (or to `none` via
   the `chat-completions`/`reasoning` rungs), I want picking an effort — even
   the one already configured — to reset the walk, so that the chip reflects a
   deliberate re-choice (this is existing server behavior; the UI must simply
   not suppress the PUT when the picked value equals the shown value).
4. As the vault owner, when the save fails (endpoint down, validation error),
   I want an error toast and an unchanged chip, so that the UI never claims an
   effort the server did not accept.
5. As a keyboard user, I want the chip focusable and the menu operable with
   Tab/Enter and dismissable with an outside click, matching the session
   popover's behavior.
6. As the vault owner with the Settings page open in another tab/device, I
   want the effort segmented control there to reflect the pick — this already
   happens via the `settings-changed` broadcast → `adoptSettings`; the spec
   adds the reverse direction (remote save → chip repaint, Solution ¶2).

## Implementation Decisions

- **`app/index.html`** — the chip (line 648) becomes
  `<button class="model-chip" id="modelChip" data-act="effort"
  aria-haspopup="dialog" aria-expanded="false" title="Reasoning effort">`,
  keeping the `.live` dot and `#modelName` / `#modelEffort` spans. A new
  `<div class="pop" id="effortPop" role="dialog" aria-label="Reasoning
  effort">` sits next to `#sessPop` inside `.chat` — options are built at
  runtime from `state.meta.efforts` (do NOT hardcode the three values;
  `ai.effort` is deliberately open, `server/settings.ts:619`).
- **`app/chat.js`** — owns the popover: `openEffort()/closeEffort()` (exported
  for `app.js` dispatch), option rendering with the current `state.session.effort`
  marked (`aria-pressed="true"` + a check glyph), and the pick handler:
  `await api.patchSettings({ai:{effort}})` → `state.session = await
  api.getSession()` → `updateSessionUI()` → `closeEffort()`; on throw,
  `apiFail(err, "Could not change effort")` and close without repainting.
  Labels capitalize the id exactly like the Settings segmented control
  (`app/settings.js:220`).
- **`app/app.js`** — dispatch and dismissal, imitating `#sessPop`
  (lines 94–101): `data-act="effort"` toggles, an outside click closes, and
  opening one of sess/effort closes the other.
- **`app/shell.js`** — `onSettingsChanged` becomes a wrapper that calls
  `adoptSettings(payload)` and then, iff `payload.settings.ai.effort` differs
  from `state.session?.effort` in a session that exists, refetches the session
  and calls `updateSessionUI()`. (Cheap: one GET, only on a moved value.)
- **`app/themes/base.css`** — `.model-chip` gains button resets (inherit font,
  no default border/background beyond the existing chip look, `cursor:
  pointer`, the shared `:focus-visible` ring via `--sh-focus`) and `#effortPop`
  option rows reuse existing tokens (`--row-hover-bg`, `--accent`, `--text-2`).
  **No new tokens**, so the dark-token contract in `themes-tokens.test.ts` is
  untouched. Keep the `.degraded` chip styling working on the button.
- **Server: no changes.** `server/ai*.ts` must not be touched at all
  (`tests/fileops.test.ts` greps their source).

## Testing Decisions

One seam: the browser, via `tests/browser.ts` (`launchTestBrowser`,
`newAppPage`/`appDriver`, `waitSettings` helpers) with `tests/mock-upstream.ts`
as the endpoint — the prior art to imitate is `tests/ai-e2e.test.ts`
(specifically the "endpoint status item in the statusbar" describe's shape:
drive the UI, then assert BOTH the DOM and the HTTP truth via the
`tests/helpers.ts` request functions).

New file `tests/effort-chip-e2e.test.ts` (the ai-e2e file is 618 lines and
this is a distinct feature), covering:

1. chip click opens the menu; it lists exactly `meta.efforts` from
   `GET /api/settings`, current one marked;
2. picking a different effort: chip text becomes `<model> · <picked>`, and
   `GET /api/settings` shows `settings.ai.effort === picked` (HTTP seam
   asserts the write, the DOM asserts the repaint);
3. picking the SAME effort still issues the PUT (assert via the settings
   `GET`'s unchanged value plus the menu closing — and, since the mock
   upstream never degrades, via no chip change; the ladder-reset itself is
   server behavior already covered by `tests/settings.test.ts`);
4. outside click closes the menu without a PUT.

A good test here drives real clicks on the real DOM and asserts the
server-side value over HTTP — never `page.evaluate` of internal state.

## Out of Scope

- Any server change: routes, `sessionOut()` shape, PUT semantics, SSE events.
- Changing the *model* from the chip (only effort; the model stays a Settings
  concern).
- Offering efforts beyond `meta.efforts` or free-text effort entry.
- The statusbar AI endpoint item (`#stAi`) and the Settings page UI — both
  already behave correctly and are not modified beyond what `adoptSettings`
  does today.
- Persisting a per-SESSION effort distinct from the `ai.effort` setting.
  Effort is a vault setting; the pick writes it as such and it syncs to other
  machines like any settings save (documented behavior).
- The session popover `#sessPop` contents.

## Further Notes

- The user's word for the chip was "pill"; the codebase and this spec say
  **model chip** (`.model-chip`). `docs/glossary.md` defines the related
  ladder/rung/probe vocabulary — reuse it in comments.
- `ai.effort` is deliberately not validated against `meta.efforts`
  server-side; the menu is what makes the open field feel like an enum, which
  is exactly the settings-page pattern (`buildSeg`).
- Multi-device staleness before this spec: the chip only repainted on session
  load and turn end. The `shell.js` wrapper closes that gap; if it proves
  noisy it can be dropped without touching the core feature.
