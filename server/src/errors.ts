/** The app running the server lacks Full Disk Access or Accessibility permission. */
export class PermissionError extends Error {
  constructor(message: string) { super(message); this.name = "PermissionError"; }
}
/** No note matched the requested title. */
export class NoteNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "NoteNotFoundError"; }
}
/** More than one note matched the requested title. */
export class AmbiguousNoteError extends Error {
  constructor(message: string) { super(message); this.name = "AmbiguousNoteError"; }
}
/** The note's structure was not what an operation expected (e.g. missing section). */
export class StructureError extends Error {
  constructor(message: string) { super(message); this.name = "StructureError"; }
}
/** A mutation did not verify against a fresh read. */
export class VerifyError extends Error {
  constructor(message: string) { super(message); this.name = "VerifyError"; }
}
