import { rmSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { snapshotDb } from "./snapshot.js";
import { findNoteRows, getNoteData } from "./db.js";
import { resolveNote } from "./resolve.js";
import { parseNoteProto } from "./proto.js";
import { paragraphsToNote } from "./paragraphs.js";
import type { Note } from "../types.js";

/**
 * Read a note's full checklist structure from a read-only snapshot of NoteStore.sqlite.
 * Never touches the live database. Throws PermissionError / NoteNotFoundError /
 * AmbiguousNoteError as appropriate.
 */
export function readNote(title: string): Note {
  const snap = snapshotDb();
  try {
    const rows = findNoteRows(snap, title);
    const row = resolveNote(rows, title);
    const blob = getNoteData(snap, row.dataPk);
    const note = paragraphsToNote(parseNoteProto(blob));
    if (!note.title) note.title = row.title; // fall back to the DB title
    return note;
  } finally {
    if (existsSync(snap)) rmSync(dirname(snap), { recursive: true, force: true });
  }
}
