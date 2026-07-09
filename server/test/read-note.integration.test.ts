import { describe, it, expect } from "vitest";
import { readNote } from "../src/reader/reader.js";

// Integration test: requires the live disposable note "MCP Scratch List" and Full Disk Access.
// Matches the fixture content captured in Phase 0.
describe("readNote (integration, live DB)", () => {
  const note = readNote("MCP Scratch List");

  it("reads the title", () => {
    expect(note.title).toBe("MCP Scratch List");
  });

  it("reads sections with correct checked state", () => {
    const personal = note.sections.find((s) => s.header === "Personal")!;
    expect(personal.items).toContainEqual({ text: "Go to the dry-cleaners", checked: false });
    expect(personal.items).toContainEqual({ text: "Confirm Jake’s dentist appointment", checked: true });

    const done = note.sections.find((s) => s.header === "Done")!;
    expect(done.items.every((i) => i.checked)).toBe(true);
    expect(done.items).toContainEqual({ text: "Update your linkedin", checked: true });

    const high = note.sections.find((s) => s.header === "High Priority")!;
    expect(high.items).toContainEqual({ text: "Write a new investors deck and share with John", checked: true });
  });

  it("exposes every expected section", () => {
    const headers = note.sections.map((s) => s.header);
    for (const h of ["Personal", "High Priority", "Today", "Normal Priority", "Low Priority", "Done"]) {
      expect(headers).toContain(h);
    }
  });
});
