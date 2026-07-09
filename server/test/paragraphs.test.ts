import { describe, it, expect } from "vitest";
import { paragraphsToNote } from "../src/reader/paragraphs.js";
import type { Paragraph } from "../src/types.js";

const p = (text: string, isChecklist: boolean, checked = false): Paragraph => ({
  text, isChecklist, checked, style: isChecklist ? "checklist" : "body",
});

describe("paragraphsToNote", () => {
  const note = paragraphsToNote([
    p("MCP Scratch List", false),
    p("", false),
    p("loose item", true, false), // pre-header checklist item
    p("Personal", false),
    p("buy milk", true, false),
    p("pick up dry cleaning", true, true),
    p("", false),
    p("Work", false),
    p("email Dana", true, false),
  ]);

  it("takes the title from the first line", () => {
    expect(note.title).toBe("MCP Scratch List");
  });

  it("puts pre-header checklist items in a null-header section", () => {
    expect(note.sections[0].header).toBeNull();
    expect(note.sections[0].items).toEqual([{ text: "loose item", checked: false }]);
  });

  it("groups checklist items under their header line", () => {
    const personal = note.sections.find((s) => s.header === "Personal")!;
    expect(personal.items).toEqual([
      { text: "buy milk", checked: false },
      { text: "pick up dry cleaning", checked: true },
    ]);
    expect(note.sections.find((s) => s.header === "Work")!.items).toEqual([
      { text: "email Dana", checked: false },
    ]);
  });

  it("omits headers that have no checklist items under them", () => {
    const only = paragraphsToNote([
      p("T", false), p("Empty", false), p("prose", false),
    ]);
    expect(only.sections).toEqual([]);
  });

  it("ignores blank lines and empty checklist rows", () => {
    const n = paragraphsToNote([
      p("T", false), p("H", false), p("", true, false), p("real", true, false),
    ]);
    expect(n.sections).toEqual([{ header: "H", items: [{ text: "real", checked: false }] }]);
  });
});
