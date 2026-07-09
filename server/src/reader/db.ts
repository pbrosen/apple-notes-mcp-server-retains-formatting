import Database from "better-sqlite3";
import { gunzipSync, inflateSync } from "node:zlib";
import type { NoteRow } from "../types.js";

// Column names confirmed on macOS 26.5.1 / Notes 4.13 (docs/phase0-findings.md).
const T_OBJ = "ZICCLOUDSYNCINGOBJECT";
const T_DATA = "ZICNOTEDATA";
const COL_NOTE_TITLE = "ZTITLE1"; // notes store their title here
const COL_FOLDER_NAME = "ZTITLE2"; // folders store their name here (NOT ZTITLE1)
const COL_MODIFIED = "ZMODIFICATIONDATE1";
const COL_FOLDER_FK = "ZFOLDER";
const COL_DATA_NOTE_FK = "ZNOTE";
const COL_DATA_BLOB = "ZDATA";
const COL_TRASHED = "ZMARKEDFORDELETION";

/** Query the snapshot for all non-trashed note rows exactly matching `title`. */
export function findNoteRows(snapshotPath: string, title: string): NoteRow[] {
  const db = new Database(snapshotPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT o.Z_PK          AS pk,
                o.${COL_NOTE_TITLE}   AS title,
                o.${COL_MODIFIED}     AS modified,
                f.${COL_FOLDER_NAME}  AS folder,
                d.Z_PK          AS dataPk
         FROM ${T_OBJ} o
         JOIN ${T_DATA} d ON d.${COL_DATA_NOTE_FK} = o.Z_PK
         LEFT JOIN ${T_OBJ} f ON o.${COL_FOLDER_FK} = f.Z_PK
         WHERE o.${COL_NOTE_TITLE} = ?
           AND (o.${COL_TRASHED} IS NULL OR o.${COL_TRASHED} = 0)`,
      )
      .all(title) as Array<{
        pk: number; title: string; modified: number | null;
        folder: string | null; dataPk: number;
      }>;
    return rows.map((r) => ({
      pk: r.pk, title: r.title, folder: r.folder ?? null,
      account: null, modified: r.modified ?? null, dataPk: r.dataPk,
    }));
  } finally {
    db.close();
  }
}

/** Fetch and decompress the ZDATA blob for a data-row pk. */
export function getNoteData(snapshotPath: string, dataPk: number): Uint8Array {
  const db = new Database(snapshotPath, { readonly: true });
  try {
    const row = db
      .prepare(`SELECT ${COL_DATA_BLOB} AS blob FROM ${T_DATA} WHERE Z_PK = ?`)
      .get(dataPk) as { blob: Buffer } | undefined;
    if (!row?.blob) return new Uint8Array();
    return decompress(row.blob);
  } finally {
    db.close();
  }
}

function decompress(buf: Buffer): Uint8Array {
  // ZDATA is gzip (magic 1f 8b) on this OS; fall back to raw zlib inflate just in case.
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
  return inflateSync(buf);
}
