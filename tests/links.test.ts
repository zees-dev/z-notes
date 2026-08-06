/* ============================================================
   links — the wiki-link rewrite planner, tested through its public seam.

   planLinkRewrites/affectedTargets are the pure heart of rename/move: which
   `[[target]]` spellings must change so every link that resolved before the
   move resolves to the SAME doc after it. Until now this logic was reachable
   only through PATCH /api/docs/* e2e; these are the direct unit tests.

   The rules under test (vault.ts "Links" section):
   - a bare `[[slug]]` resolves only while exactly one doc carries that slug;
   - a path-qualified `[[a/b]]` resolves iff `a/b.md` exists;
   - the planner prefers the SHORTEST spelling that still resolves;
   - links inside code fences and inline code are never rewritten;
   - links that did not resolve before the move are left alone (broken stays
     broken, ambiguous stays ambiguous — no adopt-an-orphan surprises).
   ============================================================ */

import { describe, expect, test } from "bun:test";
import { affectedTargets, planLinkRewrites } from "../server/vault";

const plan = (
  docs: string[],
  mapping: Record<string, string>,
  candidates: Array<{ path: string; markdown: string }>
) => planLinkRewrites(docs, new Map(Object.entries(mapping)), candidates);

describe("planLinkRewrites", () => {
  test("a rename rewrites the bare slug to the new bare slug", () => {
    const out = plan(
      ["a/foo.md", "other.md"],
      { "a/foo.md": "a/bar.md" },
      [{ path: "other.md", markdown: "see [[foo]] twice: [[foo]]\n" }]
    );
    expect(out).toEqual([{ path: "other.md", markdown: "see [[bar]] twice: [[bar]]\n", links: 2 }]);
  });

  test("no-op when the spelling still resolves to the same doc (folder move, bare slug)", () => {
    const out = plan(
      ["a/foo.md", "other.md"],
      { "a/foo.md": "b/foo.md" },
      [{ path: "other.md", markdown: "see [[foo]]\n" }]
    );
    expect(out).toEqual([]); // the bare slug still finds the doc at its new home
  });

  test("path-qualified links track a folder move even when the slug is stable", () => {
    const out = plan(
      ["a/foo.md", "c/foo.md", "other.md"],
      { "a/foo.md": "b/foo.md" },
      [{ path: "other.md", markdown: "see [[a/foo]] not [[c/foo]]\n" }]
    );
    // slug "foo" collides, so the qualified spelling is kept qualified
    expect(out).toEqual([{ path: "other.md", markdown: "see [[b/foo]] not [[c/foo]]\n", links: 1 }]);
  });

  test("a move that CREATES a slug collision forces qualification of the survivor's links", () => {
    const out = plan(
      ["a/foo.md", "b/note.md", "other.md"],
      { "b/note.md": "b/foo.md" },
      [{ path: "other.md", markdown: "see [[foo]]\n" }]
    );
    // after the move two docs carry slug foo — the bare spelling would go
    // ambiguous, so it is pinned to the doc it used to mean
    expect(out).toEqual([{ path: "other.md", markdown: "see [[a/foo]]\n", links: 1 }]);
  });

  test("rewrites are forced, never cosmetic: a still-valid spelling is left alone", () => {
    const out = plan(
      ["a/foo.md", "c/foo.md", "other.md"],
      { "c/foo.md": "c/baz.md" },
      [{ path: "other.md", markdown: "see [[a/foo]] and [[c/foo]]\n" }]
    );
    // c/foo leaves the collision. [[a/foo]] could now shorten to [[foo]] — but
    // it still resolves to the same doc, so the planner does not touch it.
    // Only [[c/foo]], which would break, follows the rename (bare baz is unique).
    expect(out).toEqual([{ path: "other.md", markdown: "see [[a/foo]] and [[baz]]\n", links: 1 }]);
  });

  test("broken and ambiguous links are never adopted", () => {
    const out = plan(
      ["a/foo.md", "c/foo.md", "other.md", "nothing.md"],
      { "a/foo.md": "a/bar.md" },
      [{ path: "other.md", markdown: "[[ghost]] and ambiguous [[foo]]\n" }]
    );
    // [[ghost]] resolves to nothing; [[foo]] resolved to nothing (collision).
    // Neither may be rewritten to point at the moved doc.
    expect(out).toEqual([]);
  });

  test("links inside code fences and inline code are untouched", () => {
    const out = plan(
      ["a/foo.md", "other.md"],
      { "a/foo.md": "a/bar.md" },
      [
        {
          path: "other.md",
          markdown: "real [[foo]]\n\n```\nfenced [[foo]]\n```\n\ninline `[[foo]]` stays\n",
        },
      ]
    );
    expect(out.length).toBe(1);
    expect(out[0].links).toBe(1);
    expect(out[0].markdown).toContain("real [[bar]]");
    expect(out[0].markdown).toContain("fenced [[foo]]");
    expect(out[0].markdown).toContain("`[[foo]]` stays");
  });

  test("the moved doc's own links are rewritten against its new address", () => {
    // self.md moves into sub/: its bare [[peer]] still resolves (slugs are
    // vault-wide, not folder-relative), so nothing changes — the candidate's
    // path is the AFTER path and the planner must not double-apply the move.
    const out = plan(
      ["self.md", "peer.md"],
      { "self.md": "sub/self.md" },
      [{ path: "sub/self.md", markdown: "see [[peer]]\n" }]
    );
    expect(out).toEqual([]);
  });
});

describe("affectedTargets", () => {
  test("names exactly the spellings whose resolution changes", () => {
    const targets = ["foo", "a/foo", "c/foo", "ghost"];
    const out = affectedTargets(
      ["a/foo.md", "c/foo.md", "other.md"],
      new Map([["a/foo.md", "a/bar.md"]]),
      targets
    );
    // "foo" was ambiguous (unresolved) before — not affected. "ghost" never
    // resolved — not affected. "c/foo" still resolves to the same doc.
    expect(out).toEqual(["a/foo"]);
  });

  test("a collision-creating move affects the bare slug of the doc that stays", () => {
    const out = affectedTargets(
      ["a/foo.md", "b/note.md"],
      new Map([["b/note.md", "b/foo.md"]]),
      ["foo", "note"]
    );
    expect(out.sort()).toEqual(["foo", "note"]);
  });
});
