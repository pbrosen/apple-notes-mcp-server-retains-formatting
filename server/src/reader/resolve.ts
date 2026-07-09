import type { NoteRow } from "../types.js";
import { NoteNotFoundError, AmbiguousNoteError } from "../errors.js";

/**
 * Resolve a list of candidate rows (already filtered to exact title) to exactly one note.
 * Zero matches -> NoteNotFoundError. More than one -> AmbiguousNoteError listing candidates
 * (we refuse to guess which note the caller meant, since these tools mutate real notes).
 */
export function resolveNote(candidates: NoteRow[], title: string): NoteRow {
  const matches = candidates.filter((c) => c.title === title);
  if (matches.length === 0) {
    throw new NoteNotFoundError(
      `No note titled "${title}" found (excluding Recently Deleted).`,
    );
  }
  if (matches.length > 1) {
    const lines = matches
      .map((m) => `  - folder="${m.folder ?? "?"}" account="${m.account ?? "?"}" modified=${m.modified ?? "?"}`)
      .join("\n");
    throw new AmbiguousNoteError(
      `Multiple notes titled "${title}" found; refusing to guess which one:\n${lines}\n` +
        `Rename one so the title is unique, then retry.`,
    );
  }
  return matches[0];
}
