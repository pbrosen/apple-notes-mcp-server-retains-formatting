# Apple Notes Checklist MCP Server — Design

**Date:** 2026-07-08
**Status:** Approved (brainstorming complete)
**Source spec:** `.context/attachments/sU9b5P/apple-notes-checklist-mcp-spec.md`

## Goal

A stdio MCP server (TypeScript) that reads Apple Notes checklists with **true
checked-state** — which AppleScript/JXA cannot see, because checklist-ness is a
paragraph style stored in a gzip-compressed protobuf blob inside
`NoteStore.sqlite`, not in the flattened HTML the scripting bridge exposes — and
mutates them (append unchecked items, check/uncheck, move checked items between
sections) via the macOS Accessibility API rather than pixel-clicking.

## Environment (verified on this machine)

- macOS 26.5.1 (build 25F80), Notes.app 4.13
- Node v22.18.0 / npm 10.9.3, Swift 6.3, sqlite3 3.51.0
- `NoteStore.sqlite` present at `~/Library/Group Containers/group.com.apple.notes/` (~48 MB)
- **Full Disk Access confirmed working** for the responsible app (**Conductor.app**):
  a read-only `sqlite3 'file:…?mode=ro' .backup` snapshot succeeds.
- Accessibility permission for Conductor still to be granted (needed at the Writer phase).

## Key decisions

1. **Reader = self-contained TypeScript.** `better-sqlite3` + `zlib` + `protobufjs`
   with a trimmed `notes.proto`, all in the Node process. No Ruby/Python runtime
   dependency. (`apple_cloud_notes_parser` is the schema *reference*, not a runtime dep.)
2. **Writer = System Events first, escalate to Swift only if needed.** Prototype via
   `osascript` + System Events UI-scripting (AX tree by role + text, no coordinates).
   Permissions attribute to Conductor (same app as FDA) and stay stable across rebuilds.
   Promote to a compiled Swift `ApplicationServices` helper only if Phase 0 / testing
   shows System Events can't do precise positioning.
3. **Note lookup = exact title, refuse on ambiguity.** One match → use it; zero → error;
   more than one → refuse and list candidates (folder, account, last-modified). Exclude
   Recently Deleted. Match across all accounts. Tool schemas stay exactly as specified
   (title only); disambiguation lives in the error message.
4. **Section model = checklist-only, spec-faithful.** `read_note` returns exactly the
   spec's shape. Non-checklist body paragraphs are parsed internally (Writer needs them
   for positioning + safety rails) but omitted from output.

## Architecture

- **MCP server** — Node/TS, `@modelcontextprotocol/sdk`, stdio transport, registers the
  4 spec tools.
- **Reader** (in-process): snapshot `NoteStore.sqlite` → gunzip `ZDATA` → parse protobuf
  → structured JSON. Read-only, off a snapshot copy, never touches the live DB.
- **Writer** (in-process): spawns `osascript` System Events scripts (AX by role + text,
  no coordinates), JSON in/out. Documented escalation to a Swift AX helper (same JSON
  contract) if range-level control is required.
- **Verify-after-write**: every mutation runs the Writer, then re-reads via a fresh
  Reader snapshot to confirm the change landed before returning success — belt-and-
  suspenders given the reverse-engineered format.

## Data model

```
Note    = { title, sections: Section[] }
Section = { header: string | null, items: Item[] }
          // header from Title/Heading/Subheading body paragraphs; null = leading section
Item    = { text: string, checked: boolean }
          // checklist rows only; non-checklist body parsed internally, omitted from output
```

- The note's own title line → top-level `title` (not a section).
- Checklist items before the first heading → a leading section with `header: null`.

## Tool surface (exactly per spec, unchanged)

- `read_note(noteTitle)`
- `append_checklist_items(noteTitle, section, items[])`
- `set_item_checked(noteTitle, itemText, checked)`
- `move_checked_items(noteTitle, fromSections[], toSection)`

Each mutating tool: perform via Writer, then re-read via Reader and verify before
returning success.

## Reader pipeline

1. Snapshot via `sqlite3 'file:…?mode=ro' .backup` (proven) — consistent snapshot, no
   WAL/lock contention, never touches the live file.
2. `ZICCLOUDSYNCINGOBJECT` → title / folder / account / modification date.
   `ZICNOTEDATA.ZDATA` → gzip-compressed protobuf content, keyed back to the note row.
3. Gunzip `ZDATA` (`zlib`).
4. Parse with `protobufjs` against `notes.proto`:
   `NoteStoreProto → Document → Note → note_text + attribute_run[]` with
   `ParagraphStyle{ style_type, checklist{ uuid, done } }`.
5. Reconstruct paragraphs by splitting `note_text` on run boundaries, tagging each with
   its paragraph style + checked flag; group into sections by heading paragraphs.

**Phase 0 confirms empirically** (before the parser is written): the exact enum value
that marks a checklist paragraph vs. bullet/dashed/numbered, the heading enum values,
and whether `done` lives inline on the run or in a separate embedded object.

## Writer pipeline (System Events)

Requires Accessibility granted to **Conductor** + one-time Automation approval. Bring
Notes frontmost, ensure the target note is open, walk the AX tree by role + text:

- **append(section, items[])**: locate the header element matching `section`, find the
  last checklist row under it (immediately before the next header), set the insertion
  point at the end of that row's text (via AX selection, not a mouse click), post a
  synthetic Return, type each item's text. New rows inherit the unchecked checklist
  style. Header not found → abort with error.
- **set_checked(itemText, checked)**: locate the row's checkbox AX element, read its
  current `AXValue`; act only if current ≠ desired (press action, or set value if
  directly settable); re-read `AXValue` to confirm. Never blind-toggle.
- **move_checked(fromSections[], toSection)**: for each checked row under any
  `fromSections`, select the full line and Cmd+X, paste at the end of `toSection`.
  Never disturbs unchecked siblings.

**Safety rails** (carried over from the manual process): never edit the title or any
header text; abort on unexpected structure rather than guess; additive/targeted edits
only — never select-all, never retype existing rows.

**Escalation trigger**: if Phase 0 shows the note is one monolithic AX text area (rows
as internal text ranges, not individually addressable elements), System Events can't
position reliably → build the Swift `ApplicationServices` helper with the same
JSON-in/JSON-out contract so the server layer is unchanged.

## Error handling

- Missing FDA → explicit error naming System Settings → Privacy & Security → Full Disk Access.
- Missing Accessibility → explicit error naming System Settings → Privacy & Security → Accessibility.
- Note not found / ambiguous → error; ambiguous lists candidates (folder, account, modified).
- Header/section not found or unexpected structure → abort with no mutation.
- Post-write verify mismatch → report failure (possible partial edit) and tell the user to check the note.
- Notes not running / target note not open → attempt to open; if that fails, error.

## Testing

- **Phase 0**: schema dump + real checklist blob decode + AX-tree dump on this device.
- **Phase 1**: `read_note` against a real checklist scratch note, compared to on-screen state.
- **Phase 2**: Writer append / set_checked / move against a **throwaway scratch note only**,
  until reliable.
- **Phase 5**: acceptance checklist (below).
- Unit-test the protobuf paragraph reconstruction against a captured fixture blob.

### Phase 5 acceptance checklist (from spec)

- [ ] `read_note` matches on-screen state exactly, including checked items.
- [ ] `append_checklist_items` adds unchecked rows to the correct section only, never
      touches other sections or the title.
- [ ] `set_item_checked` flips only the targeted row.
- [ ] `move_checked_items` relocates checked rows without disturbing unchecked siblings.
- [ ] Killing/restarting Notes mid-operation doesn't corrupt the note.
- [ ] FDA + Accessibility requirements documented in README with exact System Settings paths.

## Project layout

```
apple-notes-checklist-mcp/
  server/
    src/
      index.ts        # MCP server entrypoint, tool registration, verify-after-write
      reader.ts       # snapshot + gunzip + protobuf parse
      writer.ts       # spawns osascript (System Events) helper, JSON in/out
      notes.proto     # trimmed protobuf schema
    package.json
    tsconfig.json
  helper/             # Swift AX helper — ONLY if escalated from Phase 2
    Package.swift
    Sources/notes-ax-helper/main.swift
  README.md           # setup, permissions (exact System Settings paths), how to run
```

## Build order

Phase 0 probe → Phase 1 Reader → Phase 2 Writer (System Events) → Phase 3 Swift (only if
needed) → Phase 4 MCP wiring + verify-after-write + safety rails → Phase 5 acceptance.

## Known risks (surface, don't paper over)

- Relies on a reverse-engineered on-disk format Apple has never documented and can change
  without notice — expect to re-verify Phase 0 after major OS upgrades. macOS 26 is very new.
- Writing is still UI automation (element-based, not pixel-based) and can fail if Notes'
  internal view hierarchy changes. Keep a manual fallback until this has a track record.
- FDA + Accessibility must be granted once, manually, in System Settings — cannot be done
  programmatically, by Apple's design.
- Always validate against a disposable scratch note before running against a real note.
