# Archive Completed Items to a Separate Note — Design

**Date:** 2026-07-09
**Status:** Approved (brainstorming complete)

## Goal

Add a tool that sweeps **all checked items** out of a source to-do note and moves them to a
separate "completed tasks" note, placing them at the **top** of that note and keeping them
**checked**. Creates the destination note if it doesn't exist. This is additive — the existing
frozen read/append/check/move paths are untouched.

## Decisions (from brainstorming)

1. **Title = heading.** The destination note's title (first line, bold in Notes) serves as the
   heading. No separate heading line.
   - If a destination name is given → the note is titled with that name.
   - If no name is given → the note is titled **"Completed To-Do's"**.
2. **Source scope = all checked items** in the source note, across all sections.
3. **Archived items stay checked** (kept as checked checklist items).
4. **Mechanism = copy/paste-based cross-note move** (Approach 1): preserves the checkbox + checked
   state and avoids the bold bug (pasting keeps original formatting rather than re-typing).

## Tool surface

```jsonc
{
  "name": "archive_completed_items",
  "description": "Move every checked item from a source note into a separate completed-tasks note, at the top, keeping them checked. Creates the destination note if it doesn't exist.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "noteTitle": { "type": "string" },            // source to-do note (required)
      "archiveNoteTitle": { "type": "string" }       // destination (optional; default "Completed To-Do's")
    },
    "required": ["noteTitle"]
  }
}
```

Returns a summary, e.g. `{ ok: true, archived: <n>, archiveNoteTitle: "...", createdArchive: <bool>, note: <fresh read of source> }`.

## Behavior

1. Read the source note; collect **all checked items** (every section), in top-to-bottom order.
2. If nothing is checked → no-op, return `{ ok: true, archived: 0 }`.
3. Resolve the destination note by title (`archiveNoteTitle` or default "Completed To-Do's"):
   - if it exists → use it;
   - if not → **create it** via AppleScript with its title = that name (title line = bold heading).
4. Move each checked item **source → top of destination** (directly under the title line, above any
   existing archived items), preserving checked state. The newly-archived batch appears in **source
   order** at the top (item that was highest in the source ends up highest in the batch).

## Mechanism & new units (all additive)

- **`createNote(title)`** — TS layer, via `osascript` (like the existing `openNote`). Creating an
  empty titled note doesn't involve checklists, so AppleScript is safe here. Created in the default
  folder/account.
- **Swift helper ops** (each reuses the existing "select the whole paragraph" logic from `move`):
  - `copy_line(lineText)` — select the paragraph, ⌘C.
  - `paste_at_top()` — position at the end of the destination's title line, Return, ⌘V (prepend).
  - `delete_line(lineText)` — select the paragraph (incl. trailing newline), delete it.
- **Server orchestration** in a new `archive.ts` (keeps `writer.ts` focused): reads source via the
  Reader, ensures the destination, and runs the per-item safe sequence below.

## Safety — copy-verify-before-delete (never lose a task)

For each checked item, in order:
1. `openNote(source)`, `copy_line(item)`.
2. `openNote(destination)`, `paste_at_top()`; **verify** (Reader) the item now exists in the
   destination.
3. Only after that verify passes: `openNote(source)`, `delete_line(item)`; **verify** it's gone from
   the source.

If any step fails, abort with an error and **leave the source item in place** — a mid-run failure
never loses a task (worst case: an item exists in both notes, which the user can see and reconcile).

## Ordering

Each `paste_at_top` inserts directly under the destination's title (the top-most item position). To
make the archived batch read **top-to-bottom in source order**, process the collected checked items
in **reverse source order** (bottom-most checked item first). The last item pasted — the one that was
highest in the source — ends up highest in the destination, so the batch reads in source order, above
any older archived items.

## Error handling

- Source note not found / ambiguous title → error (existing `resolveNote` behavior).
- Destination title must differ from the source title → error if equal.
- Destination ambiguous (multiple notes with that title) → error listing candidates.
- Duplicate checked items with identical text in the source → matched by exact text; if a copy/delete
  would be ambiguous, process one occurrence per pass or flag it (exact-text matching, as elsewhere).
- Missing permissions (FDA / Accessibility / Automation) → existing typed errors.

## Testing

- **Unit:** the "collect all checked items across sections, in order" function (pure, over a parsed
  note) and the batch-ordering logic.
- **Live (two disposable scratch notes):**
  - destination **created** when missing, titled correctly;
  - items land at the **top**, in source order, **still checked**, **not bold**;
  - source note is **emptied** of the checked items, unchecked items untouched;
  - **verify-before-delete**: simulate a paste-verify failure and confirm the source item is retained;
  - re-run on a note with nothing checked → clean no-op.

## Trade-offs & risks

- **Slower / more UI surface:** per-item, with repeated note switching (copy in source, paste in
  destination). Fine for a handful of completed items; heavily test on scratch notes.
- Cross-note note-switching adds flakiness vs. single-note ops; the verify-before-delete ordering is
  what keeps that flakiness from causing data loss.
- Still subject to iCloud cross-device clobbering in the general sense, but targeted per-item ops are
  merge-friendly (no whole-note rewrite).

## Out of scope (v1)

- De-duplication (if an item is already in the archive, it's added again).
- Choosing the destination folder/account (uses the default).
- Archiving anything other than checked checklist items.
