# Phase 0 Findings — on-device probe

Machine: macOS 26.5.1 (build 25F80), Notes.app 4.13. Probed 2026-07-08.

## SQLite schema (confirmed)

- DB: `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`
- Read via `sqlite3 'file:…?mode=ro' .backup` snapshot (Full Disk Access confirmed).
- Notes, folders, and accounts all share one table `ZICCLOUDSYNCINGOBJECT`, distinguished by `Z_ENT`.

| Purpose | Table.Column | Notes |
|---|---|---|
| Note title | `ZICCLOUDSYNCINGOBJECT.ZTITLE1` | note pk lives in `Z_PK` |
| **Folder name** | `ZICCLOUDSYNCINGOBJECT.ZTITLE2` | ⚠️ folders use `ZTITLE2`, NOT `ZTITLE1` |
| Modification date | `ZICCLOUDSYNCINGOBJECT.ZMODIFICATIONDATE1` | Core Data epoch (seconds since 2001-01-01) |
| Folder FK | `ZICCLOUDSYNCINGOBJECT.ZFOLDER` | → folder row `Z_PK` |
| Trash flag | `ZICCLOUDSYNCINGOBJECT.ZMARKEDFORDELETION` | filter `IS NULL OR = 0` (robust; avoids locale-dependent "Recently Deleted" string) |
| Note→data link | `ZICNOTEDATA.ZNOTE` | → note `Z_PK` |
| Content blob | `ZICNOTEDATA.ZDATA` | gzip-compressed protobuf |

`ZICNOTEDATA` schema: `Z_PK, Z_ENT, Z_OPT, ZNOTE, ZCRYPTOINITIALIZATIONVECTOR, ZCRYPTOTAG, ZDATA`.
(Crypto columns exist for password-locked notes; scratch note is unlocked, `ZDATA` is plain gzip.)

### Deviations from plan defaults
- Folder name is `ZTITLE2` (plan Task 9 assumed `f.ZTITLE1`). **Fix db.ts accordingly.**
- Trash filter uses `ZMARKEDFORDELETION` flag, not folder-name string match. **Fix db.ts/resolve accordingly.**

### Scratch note row (confirmed)
- note `Z_PK` = 2928, `ZTITLE1` = "MCP Scratch List", `ZFOLDER` → "Notes", `ZMARKEDFORDELETION` = 0
- data `Z_PK` = 1361, `ZNOTE` = 2928, `length(ZDATA)` = 3575 bytes
- Working Reader query verified:
  ```sql
  SELECT o.Z_PK, o.ZTITLE1, o.ZMODIFICATIONDATE1, f.ZTITLE2 AS folder, d.Z_PK AS dataPk
  FROM ZICCLOUDSYNCINGOBJECT o
  JOIN ZICNOTEDATA d ON d.ZNOTE = o.Z_PK
  LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON o.ZFOLDER = f.Z_PK
  WHERE o.ZTITLE1 = ? AND (o.ZMARKEDFORDELETION IS NULL OR o.ZMARKEDFORDELETION = 0);
  ```

## Protobuf layout (confirmed empirically)

`ZDATA` = gzip (`1f 8b 08` magic) → protobuf. Confirmed by decoding a real note and
checking that per-run lengths sum exactly to `note_text.length` (2465 = 2465 ✓).

| Message.field | Number | Wire | Notes |
|---|---|---|---|
| `NoteStoreProto.document` | 2 | msg | |
| `Document.note` | 3 | msg | |
| `Note.note_text` | 2 | string | `\n`-separated paragraphs |
| `Note.attribute_run` | **5** | msg (repeated) | 59 runs summed to full text length |
| `AttributeRun.length` | 1 | varint | chars this run covers |
| `AttributeRun.paragraph_style` | 2 | msg | absent for plain paragraphs |
| `ParagraphStyle.style_type` | 1 | varint | **absent** for body/plain lines |
| `ParagraphStyle.checklist` | 5 | msg | present ⇒ the paragraph is a checklist row |
| `Checklist.done` | 2 | varint | `1` = checked, absent/`0` = unchecked |

(Field 3 under `Note` is a different repeated structure — not attribute_run — ignore it.)

### Confirmed enum / detection rules
- **Checklist row:** `style_type == 103` AND a `checklist` submessage is present. Checked ⇔ `checklist.done == 1`. (Matched documented default of 103.)
- **⚠️ Headings are NOT reliably style-typed.** In the probed note, the section labels
  ("Personal", "High Priority", "Today", "Done", …) have **`style_type` absent** — they
  are plain text lines, not Notes "Heading" style. So section detection **cannot** rely on
  Title/Heading/Subheading style; a section header is better defined as **any non-empty,
  non-checklist paragraph** (excluding the note's first title line). This is a design change
  from the plan's assumption — pending confirmation of how the user's real notes are built.
- The note's first line (its title) also had `style_type` absent; use `ZTITLE1` (or the
  first line) as the title, not `style_type == 0`.

### Privacy note
The probed note ("MCP Scratch List") turned out to contain **real, sensitive personal
content**, not throwaway data. Its decoded blob was NOT committed and has been deleted from
disk. A genuinely disposable note is needed before building the fixture and testing the Writer.

## Accessibility tree

_(to be filled by Task 3)_
