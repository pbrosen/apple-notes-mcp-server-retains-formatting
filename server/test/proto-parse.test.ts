import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseNoteProto, loadNoteStoreType } from "../src/reader/proto.js";
import type { Paragraph } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const blob = readFileSync(join(__dirname, "fixtures", "scratch-list.bin"));
const paras: Paragraph[] = parseNoteProto(blob);
const byText = (t: string) => paras.find((p) => p.text === t)!;

describe("loadNoteStoreType", () => {
  it("loads a decodable message type", () => {
    const t = loadNoteStoreType();
    expect(typeof t.decode).toBe("function");
  });
});

describe("parseNoteProto", () => {
  it("recovers the title line and section-label lines as paragraphs", () => {
    const texts = paras.map((p) => p.text);
    expect(texts[0]).toBe("MCP Scratch List");
    for (const h of ["Personal", "High Priority", "Today", "Normal Priority", "Low Priority", "Done"]) {
      expect(texts).toContain(h);
    }
  });

  it("marks section-label lines as NOT checklists (they are plain text on this OS)", () => {
    expect(byText("Personal").isChecklist).toBe(false);
    expect(byText("Done").isChecklist).toBe(false);
  });

  it("marks checklist rows with correct checked state", () => {
    expect(byText("Go to the dry-cleaners")).toMatchObject({ isChecklist: true, checked: false });
    expect(byText("Confirm Jake’s dentist appointment")).toMatchObject({ isChecklist: true, checked: true });
    expect(byText("Write a new investors deck and share with John")).toMatchObject({ isChecklist: true, checked: true });
    expect(byText("Get new tires on the car")).toMatchObject({ isChecklist: true, checked: true });
    expect(byText("Buy a new TV")).toMatchObject({ isChecklist: true, checked: false });
  });
});
