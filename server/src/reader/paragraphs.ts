import type { Paragraph, Note, Section } from "../types.js";

/**
 * Group an ordered paragraph list into { title, sections }.
 *
 * On this macOS/Notes version, section labels are frequently plain text rather than
 * Heading-styled (see docs/phase0-findings.md), so section detection uses structure:
 *  - the FIRST paragraph is the note title;
 *  - any non-empty, non-checklist paragraph starts a new section (its text is the header);
 *  - checklist paragraphs are the items of the current section;
 *  - blank lines and empty checklist rows are ignored;
 *  - checklist items before any header land in a leading section with header === null;
 *  - NAMED sections are kept even when empty (so they're visible and can be appended to);
 *  - an empty leading (null-header) section is dropped.
 */
export function paragraphsToNote(paras: Paragraph[]): Note {
  const title = paras.length > 0 ? paras[0].text : "";
  const sections: Section[] = [];
  let current: Section = { header: null, items: [] };
  const flush = () => {
    // keep any named section (even with no items) and any non-empty leading section
    if (current.header !== null || current.items.length > 0) sections.push(current);
  };

  for (let i = 1; i < paras.length; i++) {
    const para = paras[i];
    const text = para.text.trim();
    if (text === "") continue; // blank line or empty checklist row

    if (para.isChecklist) {
      current.items.push({ text: para.text, checked: para.checked });
    } else {
      // a non-empty, non-checklist line is a section header
      flush();
      current = { header: para.text, items: [] };
    }
  }
  flush();
  return { title, sections };
}
