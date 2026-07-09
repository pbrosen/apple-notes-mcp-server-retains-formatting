import protobuf from "protobufjs";
import type { Paragraph, StyleType } from "../types.js";

// Embedded copy of notes.proto (see that file). Embedded as a string so the compiled
// dist/ build needs no file-copy step. Keep in sync with src/notes.proto.
const PROTO_SCHEMA = `
syntax = "proto2";
message NoteStoreProto { optional Document document = 2; }
message Document { optional int32 version = 2; optional Note note = 3; }
message Note {
  optional string note_text = 2;
  repeated AttributeRun attribute_run = 5;
}
message AttributeRun {
  optional int32 length = 1;
  optional ParagraphStyle paragraph_style = 2;
}
message ParagraphStyle {
  optional int32 style_type = 1;
  optional Checklist checklist = 5;
}
message Checklist {
  optional bytes uuid = 1;
  optional int32 done = 2;
}
`;

// Confirmed on-device: checklist paragraphs use style_type 103 and carry a `checklist`
// submessage. Headings on this OS are often NOT style-typed, so grouping does not rely on
// heading style (see paragraphs.ts); this map is only for the informational `style` field.
export const CHECKLIST_STYLE = 103;
const STYLE_MAP: Record<number, StyleType> = {
  0: "title", 1: "heading", 2: "subheading", 103: "checklist",
};

export function styleFromType(n: number | undefined): StyleType {
  if (n === undefined) return "body";
  return STYLE_MAP[n] ?? "other";
}

let cached: protobuf.Type | null = null;
export function loadNoteStoreType(): protobuf.Type {
  if (cached) return cached;
  const root = protobuf.parse(PROTO_SCHEMA, { keepCase: true }).root;
  cached = root.lookupType("NoteStoreProto");
  return cached;
}

/**
 * Decode a gunzipped Apple Notes blob into an ordered list of paragraphs.
 * A paragraph is a `\n`-delimited slice of note_text, tagged with the paragraph style /
 * checklist state of the attribute run covering its first character.
 */
export function parseNoteProto(gunzipped: Uint8Array): Paragraph[] {
  const NoteStore = loadNoteStoreType();
  const msg = NoteStore.decode(gunzipped) as unknown as {
    document?: { note?: { note_text?: string; attribute_run?: AttrRun[] } };
  };
  const note = msg?.document?.note;
  if (!note) return [];
  const text = note.note_text ?? "";
  const runs = note.attribute_run ?? [];

  // Map each character offset to the style of the run covering it.
  const styleAt: (number | undefined)[] = new Array(text.length);
  const isCheckAt: boolean[] = new Array(text.length).fill(false);
  const doneAt: boolean[] = new Array(text.length).fill(false);
  let offset = 0;
  for (const run of runs) {
    const len = run.length ?? 0;
    const ps = run.paragraph_style;
    const st = ps?.style_type;
    const hasChecklist = ps?.checklist !== undefined && ps?.checklist !== null;
    const done = ps?.checklist?.done === 1;
    for (let k = 0; k < len && offset < text.length; k++, offset++) {
      styleAt[offset] = st;
      isCheckAt[offset] = hasChecklist || st === CHECKLIST_STYLE;
      doneAt[offset] = done;
    }
  }

  const paras: Paragraph[] = [];
  let start = 0;
  const push = (from: number, to: number) => {
    const isChecklist = from < text.length ? isCheckAt[from] : false;
    paras.push({
      text: text.slice(from, to),
      style: styleFromType(from < text.length ? styleAt[from] : undefined),
      isChecklist,
      checked: isChecklist && (from < text.length ? doneAt[from] : false),
    });
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") { push(start, i); start = i + 1; }
  }
  if (start <= text.length) push(start, text.length);
  return paras;
}

interface AttrRun {
  length?: number;
  paragraph_style?: { style_type?: number; checklist?: { done?: number } | null };
}
