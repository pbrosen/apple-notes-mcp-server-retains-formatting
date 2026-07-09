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

## Protobuf layout (confirmed)

_(to be filled by Task 2)_

## Accessibility tree

_(to be filled by Task 3)_
