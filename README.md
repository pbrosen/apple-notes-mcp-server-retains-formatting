# apple-notes-checklist-mcp

An MCP server that reads and edits **Apple Notes checklists with their true checked-state** —
something the standard AppleScript/JXA bridge cannot do.

## Why this exists

Apple Notes checklists are a paragraph *style* stored in a gzip-compressed protobuf blob inside
`NoteStore.sqlite`. AppleScript's `body` property only exposes a flattened HTML rendering with
no checked/unchecked state, so AppleScript-based tools read every checklist line as a plain
bullet and turn checkboxes back into bullets when they write. This server works around that with
two subsystems:

- **Reader** — reads a read-only snapshot of `NoteStore.sqlite`, decompresses the note blob, and
  parses the protobuf to recover section headers, item text, and true checked-state. It never
  touches the live database.
- **Writer** — edits the live note through the macOS **Accessibility API** (a small compiled
  Swift helper), positioning by text/selection rather than pixel coordinates. Every mutation is
  verified by re-reading via the Reader before returning success.

Verified on **macOS 26.5.1, Notes.app 4.13**. The on-disk format is reverse-engineered and
undocumented by Apple; re-verify after major macOS/Notes upgrades (see `docs/phase0-findings.md`
and Phase 0 in `docs/superpowers/plans/`).

## Requirements

- macOS with Apple Notes set up
- Node.js 18+ (developed on 22) and npm
- Swift toolchain (for building the AX helper) — `swift build`
- Two macOS permissions granted to **the app that runs this server** (Terminal, iTerm,
  Conductor, Claude Desktop — whichever launches the Node process). Neither can be granted
  programmatically; you must toggle them by hand:

  1. **Full Disk Access** (for the Reader to read `NoteStore.sqlite`)
     System Settings → Privacy & Security → **Full Disk Access** → enable the host app.
  2. **Accessibility** (for the Writer to drive Notes)
     System Settings → Privacy & Security → **Accessibility** → enable the host app.
     The first edit may also prompt *"<app> wants to control System Events / Notes"* — allow it.

  The Swift helper inherits the host app's Accessibility grant (it does not need its own entry).

## Download & install

```bash
git clone <REPO_URL> apple-notes-checklist-mcp
cd apple-notes-checklist-mcp
./scripts/setup.sh          # builds the Swift helper + the TS server
```

Then grant permissions and add it to your Claude client — full step‑by‑step in
**[docs/USING-WITH-CLAUDE.md](docs/USING-WITH-CLAUDE.md)**.

## Build (manual)

```bash
# 1. Build the Swift Accessibility helper
cd helper && swift build -c release && cd ..

# 2. Build the TypeScript server
cd server && npm install && npm run build
```

## Run / configure in an MCP client

Point your MCP client at the built server over stdio:

```jsonc
{
  "mcpServers": {
    "apple-notes-checklist": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/server/dist/index.js"]
    }
  }
}
```

Optional env var `NOTES_AX_HELPER` overrides the path to the compiled helper binary
(default: `helper/.build/release/notes-ax-helper` relative to the repo).

## Tools

| Tool | Arguments | Effect |
|---|---|---|
| `read_note` | `noteTitle` | Returns `{ title, sections: [{ header, items: [{ text, checked }] }] }`. |
| `append_checklist_items` | `noteTitle`, `section`, `items[]` | Appends new **unchecked** items to the end of a section. |
| `set_item_checked` | `noteTitle`, `itemText`, `checked` | Checks/unchecks one item (exact or fuzzy text match); no-op if already in that state. |
| `move_checked_items` | `noteTitle`, `fromSections[]`, `toSection` | Moves every checked item out of the source sections into the target, preserving checked state. |

Notes on behavior:
- **Note lookup** is by exact title; if more than one note has that title the call fails and
  lists the candidates (folder / account / modified) rather than guessing. Recently Deleted is
  excluded.
- **Sections**: a section header is any non-empty, non-checklist line (the first line is the
  note title). Non-checklist body text is parsed internally but omitted from output.
- **Safety rails**: edits never touch the note title or header text; operations abort with an
  error if an expected section/item is missing or ambiguous; edits are additive/targeted (never
  select-all or retype existing rows). Every mutation is re-read and verified before returning.

## Testing

```bash
cd server && npm test          # unit tests + a live-DB read integration test
```

Unit tests parse a captured (fake, disposable) note blob in `server/test/fixtures/`. The Writer
was validated end-to-end against a disposable scratch note.

## Known risks

- Relies on a reverse-engineered, undocumented on-disk format that Apple can change in any
  macOS/Notes update — re-verify the Phase 0 findings after major upgrades.
- Writing is UI automation via the Accessibility API; it can fail if Notes' view hierarchy
  changes. Keep a manual fallback until it has a track record.
- Full Disk Access + Accessibility must be granted once, manually — by Apple's design.
- **Always validate against a disposable scratch note before pointing this at a note you rely
  on.** Synthetic key events drive the frontmost app, so keep Notes focused during writes.
```
