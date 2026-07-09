import { readNote } from "../reader/reader.js";
import { runHelper } from "./helper.js";
import { StructureError, VerifyError } from "../errors.js";
import { sleepSync } from "../util.js";
import { openNote } from "./notesApp.js";
import type { Note, Section, Item } from "../types.js";

function sectionByHeader(note: Note, header: string): Section | undefined {
  return note.sections.find((s) => s.header === header);
}

/**
 * Poll the Reader until `pred(note)` holds or the timeout elapses. Synthetic key events are
 * applied by Notes asynchronously and only then flushed to SQLite, so a mutation is not
 * visible immediately after the helper returns. Returns the last note read either way.
 */
export function readNoteUntil(title: string, pred: (n: Note) => boolean, timeoutMs = 5000, intervalMs = 300): Note {
  const start = Date.now();
  let note = readNote(title);
  while (!pred(note)) {
    if (Date.now() - start > timeoutMs) break;
    sleepSync(intervalMs);
    note = readNote(title);
  }
  return note;
}

/** Find a single item across all sections by exact text, else by unique substring match. */
function matchItem(note: Note, query: string): Item {
  const all = note.sections.flatMap((s) => s.items);
  const exact = all.filter((i) => i.text === query);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new StructureError(`Multiple items exactly match "${query}"; be more specific.`);
  const sub = all.filter((i) => i.text.includes(query));
  if (sub.length === 1) return sub[0];
  if (sub.length === 0) throw new StructureError(`No checklist item matches "${query}".`);
  throw new StructureError(`"${query}" matches ${sub.length} items; be more specific.`);
}

/**
 * Append UNCHECKED checklist items to the end of `section`. Never touches other sections
 * or the title. Verifies each new item is present and unchecked afterward.
 */
export function append(title: string, section: string, items: string[]): void {
  if (items.length === 0) return;
  const note = readNote(title);
  const sec = sectionByHeader(note, section);
  if (!sec) throw new StructureError(`Section "${section}" not found in note "${title}".`);

  const anchorIsChecklist = sec.items.length > 0;
  const afterLineText = anchorIsChecklist ? sec.items[sec.items.length - 1].text : section;
  openNote(title);
  runHelper({ op: "append", expectTitle: title, afterLineText, anchorIsChecklist, items });

  const after = readNoteUntil(title, (n) => {
    const s = sectionByHeader(n, section);
    return !!s && items.every((it) => s.items.some((i) => i.text === it));
  });
  const secAfter = sectionByHeader(after, section);
  for (const it of items) {
    const found = secAfter?.items.find((i) => i.text === it);
    if (!found) throw new VerifyError(`append not confirmed: "${it}" missing from "${section}".`);
    if (found.checked) throw new VerifyError(`append landed CHECKED (should be unchecked): "${it}".`);
  }
}

/**
 * Set a single item's checked state (matched by exact or fuzzy text). Reads current state
 * first and only toggles when it differs; verifies the result.
 */
export function setChecked(title: string, itemText: string, checked: boolean): void {
  const note = readNote(title);
  const item = matchItem(note, itemText);
  openNote(title);
  runHelper({
    op: "toggle",
    expectTitle: title,
    lineText: item.text,
    desiredChecked: checked,
    currentChecked: item.checked,
  });

  const after = readNoteUntil(title, (n) => {
    const i = n.sections.flatMap((s) => s.items).find((x) => x.text === item.text);
    return !!i && i.checked === checked;
  });
  const item2 = after.sections.flatMap((s) => s.items).find((i) => i.text === item.text);
  if (!item2) throw new VerifyError(`set_checked: item "${item.text}" not found after toggle.`);
  if (item2.checked !== checked) {
    throw new VerifyError(`set_checked not confirmed: "${item.text}" is checked=${item2.checked}, wanted ${checked}.`);
  }
}

/**
 * Move every currently-checked item under any of `fromSections` into `toSection`, preserving
 * checked state, without disturbing unchecked siblings. Items are moved one at a time; the
 * note is re-read (with polling) between moves so anchors stay correct.
 */
export function moveChecked(title: string, fromSections: string[], toSection: string): void {
  const note = readNote(title);
  if (!sectionByHeader(note, toSection)) {
    throw new StructureError(`Target section "${toSection}" not found in note "${title}".`);
  }

  const toMove: string[] = [];
  for (const from of fromSections) {
    const sec = sectionByHeader(note, from);
    if (!sec) throw new StructureError(`Source section "${from}" not found in note "${title}".`);
    for (const it of sec.items) if (it.checked) toMove.push(it.text);
  }
  if (toMove.length === 0) return;

  openNote(title);
  for (const lineText of toMove) {
    const cur = readNote(title);
    const target = sectionByHeader(cur, toSection)!;
    const toAnchorIsChecklist = target.items.length > 0;
    const toAfterLineText = toAnchorIsChecklist ? target.items[target.items.length - 1].text : toSection;
    runHelper({ op: "move", expectTitle: title, lineText, toAfterLineText, toAnchorIsChecklist });

    const landed = readNoteUntil(title, (n) =>
      sectionByHeader(n, toSection)!.items.some((i) => i.text === lineText && i.checked),
    );
    if (!sectionByHeader(landed, toSection)!.items.some((i) => i.text === lineText && i.checked)) {
      throw new VerifyError(`move_checked: "${lineText}" did not land checked in "${toSection}".`);
    }
  }

  const after = readNote(title);
  for (const from of fromSections) {
    const sec = sectionByHeader(after, from);
    if ((sec?.items.filter((i) => i.checked) ?? []).length > 0) {
      throw new VerifyError(`move_checked not confirmed: checked items remain in "${from}".`);
    }
  }
}
