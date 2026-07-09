# Future directions & design notes

**Status:** The current architecture is intentionally **frozen** (2026-07-09). It works for the
primary use case (managing a structured checklist note, e.g. a Cowork scheduled task). The options
below are captured so the path exists if the tool ever needs to grow — not as planned work. Don't
rebuild a working tool on spec (YAGNI); revisit only when a real need appears (see triggers at the
end).

## What the tool is today

- **Reader** (SQLite snapshot → protobuf) returns an opinionated shape: `{title, sections:[{header,
  items:[{text, checked}]}]}`. Sections are inferred (`first line = title; any non-empty,
  non-checklist line = header; checklist rows belong to the header above`). Empty *named* sections
  are included; nesting, prose, bullets/numbered lists, tables, and attachments are not modeled.
- **Writer** (Accessibility API) exposes four high-level, section-name-based tools: `read_note`,
  `append_checklist_items`, `set_item_checked`, `move_checked_items`. Every edit is targeted and
  additive; nothing is ever select-all/retyped; each mutation is verified by re-reading.

## Hard constraints that bound every design

These are physics, not preferences — any redesign lives inside them:

1. **Access can't move to the client.** Checked-state and structure exist only in the gzipped
   protobuf in `NoteStore.sqlite`. Only the server can read them.
2. **Write mechanics can't move to the client.** The only way to write a checklist without flattening
   it is driving Notes' UI via Accessibility. AppleScript/`body` text writes destroy checkboxes — the
   exact problem this project exists to solve. So the server must own "how to make a checklist row,"
   and the **bold-on-finalize artifact lives here regardless of API shape**.
3. **The note is shared and synced.** It lives on iCloud across the user's devices. Anything that
   writes large regions (esp. full-note replacement) risks **last-writer-wins clobbering** of edits
   made elsewhere. Small targeted ops are merge-friendly; whole-note writes are not.
4. **Unmodeled content is real.** Notes can contain attachments, images, tables, links, and inline
   formatting the current model doesn't represent. Targeted edits preserve them; anything that
   reconstructs the note from our model would delete them.

## Option A — Faithful raw read (safest, highest-value)

Add a lower-level read that returns the **raw paragraph list with attributes** instead of the
inferred section grouping:

```
paragraphs: [{ index, text, type: "checklist"|"heading"|"bullet"|"number"|"body",
               checked, indent, bold }]
```

- **Wins:** dissolves the whole "unusual note structure" fragility (no heuristic to be wrong),
  surfaces nesting/prose/lists faithfully, and lets a capable client (Cowork) do its own grouping.
- **Cost/risk:** low. Purely additive on the read side; the existing `read_note` stays as a
  convenience wrapper.
- **Recommended first step if we ever expand.**

## Option B — Position-based write primitives

Add index-addressed write ops the client composes itself:
`insert_checklist_rows(afterIndex, lines[])`, `set_checked(index, bool)`,
`move_paragraph(fromIndex, afterIndex)`, and a new `delete_paragraph(index)`.

- **Wins:** pushes *interpretation/decisions* (what's a section, what to move) to the client while the
  server keeps the AX mechanics; more flexible than section-name-based tools.
- **Cost/risk:** medium. Index stability across edits, and a delete op we don't have yet. Keep the
  four high-level tools as wrappers for simple cases.

## Option C — Declarative `sync_note(desiredState)`

Let the client submit a desired note state; the server makes the note match it.

- **Only implement as diff → minimal targeted edits.** The server diffs desired-vs-*fresh* current
  state and applies the smallest set of append/toggle/move/delete ops.
- **Never implement as full retype** (select-all + rewrite). That version maximizes every risk at
  once: the bold artifact becomes universal (whole note bold on every write), the corruption blast
  radius becomes the entire note, unmodeled content is destroyed, and cross-device clobbering is
  worst-case. It also violates the original safety rails.
- **Even the diff version:** read-immediately-before-write and diff against fresh state, never a
  long-lived cached copy; the iCloud note is the source of truth, not the client's memory.
- **Cost/risk:** highest (diff engine, matching/reorder handling, delete op, clobber policy).

## The bold known issue (orthogonal to all of the above)

Notes renders a checklist paragraph in the bold "Emphasized" system font when it *finalizes* one
created via automation; an appended item goes bold once another lands below it (the most-recent one
stays regular). Confirmed via the AX font data. Five reversals were tried and failed (embedded
newlines, ⌘B, re-toggling Checklist, Body style, settle delays). It's **cosmetic** — text, checked
state, and section are correct, and existing human-typed items are never affected. A redesign does
**not** fix it (it's in the write mechanics); full-retype (Option C-retype) would make it universal.
The one untried, bounded idea is **paste/rich-insert** (build items as rich content and paste them,
bypassing per-line finalization) — no guarantee it works.

## When to revisit (triggers)

Only pick this up if one of these actually happens:

- A note the tool needs to manage has a structure it reads wrong (→ Option A).
- The client needs to do edits the four tools can't express (→ Option B).
- The bold issue becomes a real day-to-day annoyance (→ bounded paste/rich-insert experiment).

Until then: **frozen.**
