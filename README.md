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
- ✅ Verify-after-write on every mutation; aborts rather than guessing on missing/ambiguous targets
- ✅ No screenshots, no pixel-clicking, no direct database writes

## Tools

| Tool | Arguments | Effect |
|---|---|---|
| `read_note` | `noteTitle` | Returns `{ title, sections: [{ header, items: [{ text, checked }] }] }`. |
| `append_checklist_items` | `noteTitle`, `section`, `items[]` | Appends new **unchecked** items to the end of a section. |
| `set_item_checked` | `noteTitle`, `itemText`, `checked` | Checks/unchecks one item; no-op if already in that state. |
| `move_checked_items` | `noteTitle`, `fromSections[]`, `toSection` | Moves every checked item into the target section, keeping checked state. |

## Quick start

```bash
git clone https://github.com/pbrosen/apple-notes-mcp-server-retains-formatting.git apple-notes-checklist-mcp
cd apple-notes-checklist-mcp
./scripts/setup.sh          # builds the Swift helper + the TypeScript server
```

Then:

1. **Grant permissions to your MCP client app** (the app that launches the server — the **Claude**
   app for Claude Desktop, **Terminal/iTerm** for Claude Code):
   - System Settings → Privacy & Security → **Full Disk Access** (so the Reader can read the notes DB)
   - System Settings → Privacy & Security → **Accessibility** (so the Writer can drive Notes)
   - Restart the client after granting. The first edit also prompts once to **"control Notes"** — allow it.
2. **Add the server** to your client, pointing at the absolute path to `server/dist/index.js`.

👉 **Full step-by-step (Claude Desktop & Claude Code config, example prompts, troubleshooting):
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

## Known limitations & risks

- Relies on a **reverse-engineered, undocumented** on-disk format that Apple can change in any
  macOS/Notes update. It's verified for macOS 26 / Notes 4.13; re-verify after major upgrades using the
  Phase 0 probe (see [`docs/phase0-findings.md`](docs/phase0-findings.md)).
- Writing is UI automation via the Accessibility API. It **never writes the Notes database directly**, so
  an interrupted edit can't corrupt your store — but it can leave a half-typed line, like being
  interrupted while typing. Keep Notes frontmost during writes.
- Full Disk Access + Accessibility must be granted once, manually — by Apple's design.
- **Always validate on a disposable scratch note before pointing this at a note you rely on.**

## Development

```bash
cd server && npm test        # unit tests + a live-DB read integration test
```

Layout: `server/` (TypeScript MCP server + Reader/Writer), `helper/` (Swift Accessibility helper),
`docs/` (usage guide, Phase 0 reverse-engineering findings, design & implementation notes).

## License

No license is set yet — add one before wide distribution.
