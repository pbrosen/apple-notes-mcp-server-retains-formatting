import { readNote } from "../reader/reader.js";
import { readNoteUntil } from "./writer.js";
import { openNote, createNote } from "./notesApp.js";
import { runHelper } from "./helper.js";
import { NoteNotFoundError, StructureError, VerifyError } from "../errors.js";
import { sleepSync } from "../util.js";
import type { Note } from "../types.js";

/** All checked item texts across every section, in top-to-bottom (source) order. */
export function checkedItemTexts(note: Note): string[] {
  return note.sections.flatMap((s) => s.items).filter((i) => i.checked).map((i) => i.text);
}

function hasItem(note: Note, text: string): boolean {
  return note.sections.some((s) => s.items.some((i) => i.text === text));
}

/** Poll until `title` is readable (tolerating NoteNotFoundError while iCloud/Notes flushes). */
function pollUntilReadable(title: string, timeoutMs = 5000, intervalMs = 300): Note | null {
  const start = Date.now();
  for (;;) {
    try {
      return readNote(title);
    } catch (e) {
      if (!(e instanceof NoteNotFoundError)) throw e;
    }
    if (Date.now() - start > timeoutMs) return null;
    sleepSync(intervalMs);
  }
}

/**
 * Move every checked item from `sourceTitle` into the archive note (default "Completed To-Do's"),
 * at the top, keeping them checked. Creates the archive note if it doesn't exist. For each item:
 * copy → paste into archive → verify → then delete from source (never lose a task on failure).
 * Items are pasted in reverse source order so the batch reads source-order at the top.
 */
export function archiveCompletedItems(sourceTitle: string, archiveTitleArg?: string) {
  const archiveTitle = (archiveTitleArg && archiveTitleArg.trim()) || "Completed To-Do's";
  if (archiveTitle === sourceTitle) {
    throw new StructureError(`Archive note must be different from the source note ("${sourceTitle}").`);
  }

  const source = readNote(sourceTitle); // throws NoteNotFound/Ambiguous as usual
  const checked = checkedItemTexts(source);
  if (checked.length === 0) {
    return { ok: true, archived: 0, archiveNoteTitle: archiveTitle, createdArchive: false, note: source };
  }

  // Ensure the destination exists.
  let createdArchive = false;
  let dest: Note | null = null;
  try {
    dest = readNote(archiveTitle);
  } catch (e) {
    if (!(e instanceof NoteNotFoundError)) throw e; // AmbiguousNoteError etc. propagate
  }
  if (dest === null) {
    createNote(archiveTitle);
    createdArchive = true;
    dest = pollUntilReadable(archiveTitle);
    if (dest === null) throw new StructureError(`Could not create or read archive note "${archiveTitle}".`);
  }

  // Move each checked item, in REVERSE source order, so the batch reads source-order at the top.
  for (const text of [...checked].reverse()) {
    openNote(sourceTitle);
    runHelper({ op: "copy_line", expectTitle: sourceTitle, lineText: text });

    openNote(archiveTitle);
    runHelper({ op: "paste_at_top", expectTitle: archiveTitle });
    const inDest = readNoteUntil(archiveTitle, (n) => hasItem(n, text));
    if (!hasItem(inDest, text)) {
      throw new VerifyError(`Archive not confirmed: "${text}" did not appear in "${archiveTitle}"; source left unchanged.`);
    }

    openNote(sourceTitle);
    runHelper({ op: "delete_line", expectTitle: sourceTitle, lineText: text });
    const src2 = readNoteUntil(sourceTitle, (n) => !hasItem(n, text));
    if (hasItem(src2, text)) {
      throw new VerifyError(`"${text}" was copied to "${archiveTitle}" but not removed from "${sourceTitle}"; check both notes.`);
    }
  }

  return {
    ok: true,
    archived: checked.length,
    archiveNoteTitle: archiveTitle,
    createdArchive,
    note: readNote(sourceTitle),
  };
}
