import type { Note } from "../types.js";

/** All checked item texts across every section, in top-to-bottom (source) order. */
export function checkedItemTexts(note: Note): string[] {
  return note.sections.flatMap((s) => s.items).filter((i) => i.checked).map((i) => i.text);
}
