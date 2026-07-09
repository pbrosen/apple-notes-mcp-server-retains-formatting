export type StyleType =
  | "title" | "heading" | "subheading" | "checklist" | "body" | "other";

export interface Paragraph {
  text: string;
  style: StyleType;
  isChecklist: boolean;
  checked: boolean; // meaningful only when isChecklist === true
}

export interface Item {
  text: string;
  checked: boolean;
}

export interface Section {
  header: string | null; // null = leading section before any header line
  items: Item[];
}

export interface Note {
  title: string;
  sections: Section[];
}

export interface NoteRow {
  pk: number;
  title: string;
  folder: string | null;
  account: string | null;
  modified: number | null; // Core Data timestamp (seconds since 2001-01-01)
  dataPk: number;
}
