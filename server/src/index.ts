#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readNote } from "./reader/reader.js";
import { append, setChecked, moveChecked } from "./writer/writer.js";

const server = new Server(
  { name: "apple-notes-checklist-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "read_note",
    description: "Read a Notes.app note's full structure (headers + checklist items + checked state).",
    inputSchema: {
      type: "object",
      properties: { noteTitle: { type: "string" } },
      required: ["noteTitle"],
    },
  },
  {
    name: "append_checklist_items",
    description:
      "Append one or more new UNCHECKED checklist items to the end of a named section. Never touches Today/Done unless explicitly targeted.",
    inputSchema: {
      type: "object",
      properties: {
        noteTitle: { type: "string" },
        section: { type: "string" },
        items: { type: "array", items: { type: "string" } },
      },
      required: ["noteTitle", "section", "items"],
    },
  },
  {
    name: "set_item_checked",
    description: "Set the checked state of a specific checklist item, matched by exact or fuzzy text.",
    inputSchema: {
      type: "object",
      properties: {
        noteTitle: { type: "string" },
        itemText: { type: "string" },
        checked: { type: "boolean" },
      },
      required: ["noteTitle", "itemText", "checked"],
    },
  },
  {
    name: "move_checked_items",
    description:
      "Move every currently-checked item out of the given source sections into the target section, preserving checked state.",
    inputSchema: {
      type: "object",
      properties: {
        noteTitle: { type: "string" },
        fromSections: { type: "array", items: { type: "string" } },
        toSection: { type: "string" },
      },
      required: ["noteTitle", "fromSections", "toSection"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a } = req.params as { name: string; arguments: Record<string, unknown> };
  try {
    const result = dispatch(name, a);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const err = e as Error;
    return {
      isError: true,
      content: [{ type: "text", text: `${err.name ?? "Error"}: ${err.message ?? String(e)}` }],
    };
  }
});

function dispatch(name: string, a: Record<string, unknown>): unknown {
  switch (name) {
    case "read_note":
      return readNote(a.noteTitle as string);
    case "append_checklist_items":
      // Writer verifies the append landed & is unchecked; then return the fresh note.
      append(a.noteTitle as string, a.section as string, a.items as string[]);
      return { ok: true, note: readNote(a.noteTitle as string) };
    case "set_item_checked":
      setChecked(a.noteTitle as string, a.itemText as string, a.checked as boolean);
      return { ok: true, note: readNote(a.noteTitle as string) };
    case "move_checked_items":
      moveChecked(a.noteTitle as string, a.fromSections as string[], a.toSection as string);
      return { ok: true, note: readNote(a.noteTitle as string) };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
