import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PermissionError, StructureError } from "../errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the compiled Swift AX helper. Override with NOTES_AX_HELPER. */
export function helperPath(): string {
  return (
    process.env.NOTES_AX_HELPER ??
    join(__dirname, "..", "..", "..", "helper", ".build", "release", "notes-ax-helper")
  );
}

export interface HelperResult {
  ok: boolean;
  error?: string;
  text?: string;
  toggled?: boolean;
}

/** Run one JSON command through the Swift helper (stdin JSON in, stdout JSON out). */
export function runHelper(command: Record<string, unknown>): HelperResult {
  const bin = helperPath();
  if (!existsSync(bin)) {
    throw new StructureError(
      `AX helper not built at ${bin}. Build it with: (cd helper && swift build -c release)`,
    );
  }
  let out: string;
  try {
    out = execFileSync(bin, [], { input: JSON.stringify(command), encoding: "utf8" });
  } catch (e) {
    // Non-zero exit still prints JSON to stdout; capture it.
    const err = e as { stdout?: string; stderr?: string; message?: string };
    out = err.stdout ?? "";
    if (!out) {
      throw new StructureError(`AX helper failed: ${err.stderr ?? err.message ?? e}`);
    }
  }
  let result: HelperResult;
  try {
    result = JSON.parse(out) as HelperResult;
  } catch {
    throw new StructureError(`AX helper returned non-JSON output: ${out}`);
  }
  if (!result.ok) {
    const msg = result.error ?? "unknown helper error";
    if (/accessibility permission/i.test(msg)) {
      throw new PermissionError(
        "Accessibility permission not granted.\n" +
          "Grant it in System Settings → Privacy & Security → Accessibility " +
          "(enable the app running this server, e.g. Conductor), then retry.",
      );
    }
    throw new StructureError(msg);
  }
  return result;
}
