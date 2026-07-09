# apple-notes-checklist-mcp

> An [MCP](https://modelcontextprotocol.io) server that reads and edits **Apple Notes checklists —
> including their true checked / unchecked state** — which the standard AppleScript/JXA bridge cannot do.

Point Claude (or any MCP client) at your checklist notes and ask it to read them with real
checked-state, add items, tick things off, and sweep completed items into a "Done" section — safely,
by driving the Notes app itself rather than editing files behind its back.

```
You: "What's still open on my 'To-Do' note, and move everything that's checked into Done."
Claude → read_note → move_checked_items → "Moved 3 completed items to Done. 5 items still open in Today…"
```

## Why this exists

Apple Notes checklists are a paragraph **style** stored in a gzip-compressed protobuf blob inside
`NoteStore.sqlite`. AppleScript's `body` property only exposes a flattened HTML rendering with **no
checked/unchecked state** — so AppleScript-based tools read every checklist line as a plain bullet and
turn checkboxes back into bullets when they write. That's a limitation of Apple's scripting bridge
itself, not of any one tool.

This server works around it with two subsystems:

- **Reader** — reads a **read-only snapshot** of `NoteStore.sqlite`, decompresses the note blob, and
  parses the protobuf to recover section headers, item text, and **true checked-state**. It never
  touches the live database.
- **Writer** — edits the live note through the macOS **Accessibility API** (a small compiled Swift
  helper), positioning by text/selection rather than pixel coordinates. It opens the target note,
  verifies it's the right one, makes the edit, then **re-reads via the Reader to confirm** before
  reporting success.

## Features

- ✅ Read a note's real structure: headers → items → **checked/unchecked** (impossible via AppleScript)
- ✅ Append new **unchecked** items to a specific section
- ✅ Check / uncheck a specific item (exact or fuzzy match; no-op if already in that state)
- ✅ Move all checked items from one/more sections into a target section, **preserving checked state**
- ✅ Archive all checked items into a **separate** completed-tasks note (created if missing), at the top, kept checked
- ✅ Verify-after-write on every mutation; aborts rather than guessing on missing/ambiguous targets
- ✅ No screenshots, no pixel-clicking, no direct database writes

## Tools

| Tool | Arguments | Effect |
|---|---|---|
| `read_note` | `noteTitle` | Returns `{ title, sections: [{ header, items: [{ text, checked }] }] }`. |
| `append_checklist_items` | `noteTitle`, `section`, `items[]` | Appends new **unchecked** items to the end of a section. |
| `set_item_checked` | `noteTitle`, `itemText`, `checked` | Checks/unchecks one item; no-op if already in that state. |
| `move_checked_items` | `noteTitle`, `fromSections[]`, `toSection` | Moves every checked item into the target section, keeping checked state. |
| `archive_completed_items` | `noteTitle`, `archiveNoteTitle?` | Moves every checked item into a **separate** completed-tasks note (default "Completed To-Do's", created if missing), at the top, kept checked. Copies + verifies before deleting from the source, so a task is never lost. |

## Quick start

```bash
git clone https://github.com/pbrosen/apple-notes-mcp-server-retains-formatting.git apple-notes-checklist-mcp
cd apple-notes-checklist-mcp
./scripts/setup.sh          # builds the Swift helper + the TypeScript server
```

Then:

1. **Register the server** with your client, pointing at the absolute path to `server/dist/index.js`.
   For **Claude Desktop / Claude Cowork**: Settings → Connectors → Add connector → "Local command",
   command `node`, argument = that path. For **Claude Code**:
   `claude mcp add apple-notes-checklist -- node /abs/path/server/dist/index.js`.
2. **Grant Full Disk Access + Accessibility** — but read this carefully, it's the #1 gotcha:
   - **Claude Desktop / Claude Cowork:** grant them to the **`node` binary** (e.g. `/usr/local/bin/node`),
     **not** the Claude app — Claude Desktop disclaims TCC responsibility for the subprocess, so
     granting the app does nothing.
   - **Claude Code in Terminal/iTerm:** grant the **terminal app**.
   - If unsure, grant the `node` binary (works in every case). Then **fully quit + relaunch** the client.
     The first edit raises a one-time **"control Notes"** prompt — allow it.

👉 **Full step-by-step (finding the exact `node` path, Connectors UI, example prompts, troubleshooting):
[docs/USING-WITH-CLAUDE.md](docs/USING-WITH-CLAUDE.md).**

## Requirements

- macOS with Apple Notes signed in — **verified on macOS 26.5.1, Notes 4.13**
- Node.js 18+ and npm
- Swift toolchain (Xcode Command Line Tools) to build the helper
- The target note must be a normal (not password-locked) note with a **unique title**

## Behavior & safety rails

- **Note lookup** is by exact title; if more than one note shares it, the call fails and lists the
  candidates rather than guessing. Recently Deleted is excluded.
- A **section header** is any non-empty, non-checklist line (the note's first line is its title). Notes
  "Heading"-styled lines work too. Non-checklist body text is parsed internally but omitted from output.
- Edits never touch the note title or other sections, are additive/targeted (never select-all or retype),
  and are verified before returning. The Writer confirms the correct note is frontmost before editing.

## Note structure it expects

The Reader models a note as: **the first line is the title; any non-empty line that isn't a checklist
row is a section header; checklist rows belong to the header above them.** Reading the
**checked/unchecked state is reliable no matter how the note is laid out** — that comes from Apple's
underlying data, not from guessing at structure.

**Works well:**
- Section labels as plain text *or* as Notes "Heading" style
- One section, many sections, or a flat checklist with no sections (items come back ungrouped)
- Any mix of checked/unchecked items, with blank lines between things

**Can be misread** (because any non-checklist line is treated as a header):
- Prose/notes written *between* checklist items → treated as a new section header
- Bulleted or numbered list items mixed in with checklists → treated as headers
- Nested / indented sub-items → flattened (checked state preserved, hierarchy lost)
- Tables, images, and attachments → not represented
- Duplicate section names or item text → the write tools **refuse and ask you to disambiguate**
  rather than edit the wrong line

In short: it's built for the common **"optional section labels + checklist items"** to-do pattern.
More freeform notes will still read their checkboxes correctly but may report extra "sections."

## Known limitations & risks

- Relies on a **reverse-engineered, undocumented** on-disk format that Apple can change in any
  macOS/Notes update. It's verified for macOS 26 / Notes 4.13; re-verify after major upgrades using the
  Phase 0 probe (see [`docs/phase0-findings.md`](docs/phase0-findings.md)).
- Writing is UI automation via the Accessibility API. It **never writes the Notes database directly**, so
  an interrupted edit can't corrupt your store — but it can leave a half-typed line, like being
  interrupted while typing. Keep Notes frontmost during writes.
- Full Disk Access + Accessibility must be granted once, manually — by Apple's design.
- **Known issue — appended items can render bold:** Notes applies a bold ("Emphasized") style when it
  *finalizes* a checklist paragraph that was created via automation. An appended item becomes bold once
  another item is placed below it in the same section — so in a multi-item append every item except the
  last comes out bold, and a single appended item can turn bold later when you append another beneath it.
  The most-recently-appended item in a section stays regular. Items are otherwise correct (right text,
  unchecked, correct section), and existing (human-typed) items are never affected. Standard un-bolding
  (⌘B, re-applying Body/Checklist, timing changes) did not reliably reverse it in testing; a proper fix
  is still being investigated. The same cosmetic bold can appear on items placed by
  `archive_completed_items` (it pastes each item into a fresh line, which finalizes the previous one).
- **Always validate on a disposable scratch note before pointing this at a note you rely on.**

## Development

```bash
cd server && npm test        # unit tests + a live-DB read integration test
```

Layout: `server/` (TypeScript MCP server + Reader/Writer), `helper/` (Swift Accessibility helper),
`docs/` (usage guide, Phase 0 reverse-engineering findings, design & implementation notes). The
architecture is intentionally frozen for now; possible future changes and their trade-offs are
captured in [docs/future-directions.md](docs/future-directions.md).

## License

[MIT](LICENSE) © pbrosen
