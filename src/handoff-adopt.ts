import {
  HANDOFF_PROJECTION_NOTICE,
  handoffDeclaredPathSchema,
  type HandoffContextV1,
} from "./handoff-contract.js";
import { HANDOFF_REDACTED, redactHandoffText } from "./handoff-redact.js";
import { printableText } from "./handoff-session-contract.js";

// A snapshot row holds 64 KiB of JSON, and escaping can double a text, so
// the extracted context stays well under half of that.
const MAX_GOAL_BYTES = 2048;
const MAX_ITEM_BYTES = 512;
const MAX_ITEMS = 16;
const MAX_TOUCHED_FILES = 32;
const MAX_PATH_BYTES = 512;

export const NO_GOAL_FOUND =
  "Adopted a document with no recognized goal; read the handoff document.";

type Section = "goal" | "completed" | "blockers" | "nextSteps";

// Trailing spaces and #s are removed without a regex: a pattern anchored at
// the end of the line would backtrack quadratically on a long one.
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/u;
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const ITEM = /^ {0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+(.+)$/u;
const BARE_MARKER = /^(?:[-*+]|\d{1,3}[.)])$/u;
const LIST_MARKER = /^(?:[-*+]|\d{1,3}[.)])[ \t]/u;
const THEMATIC_BREAK =
  /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
const LAST_AGENT = /^ {0,3}[-*][ \t]+\*\*Last Active Agent\*\*:[ \t]*(.+)$/u;
// Files kept by hand often say where things stand here, above the sections,
// while the goal below grows stale. A brief shows the goal, so it leads.
const STATUS = /^ {0,3}[-*][ \t]+\*\*Status\*\*:[ \t]*(.+)$/u;
// ReproGate's own placeholders and sublists are not content.
const PLACEHOLDER =
  /^(?:Nothing recorded\.|None recorded\.|None declared\.)$(?![\s\S])/u;
const SUBLISTS: ReadonlyMap<string, "touched" | "plans"> = new Map([
  ["Declared touched files:", "touched"],
  ["Persisted plan references:", "plans"],
]);

function sectionOf(heading: string): Section | undefined {
  let end = heading.trimEnd().length;
  while (end > 0 && heading[end - 1] === "#") end--;
  const title = heading
    .slice(0, end)
    .replace(/[*_`]/gu, "")
    .replace(/^[\d.)\s]+/u, "")
    .toLowerCase();
  // The whole title: "Task handoff for Foo" and "Task Board" are not goals.
  if (
    /^(?:(?:active|current)\s+)?(?:goal|task|objective)s?(?:\s*[/&:-]\s*(?:goal|task|objective)s?)?[\s:.]*$/u.test(
      title,
    )
  )
    return "goal";
  if (/next steps?\b/u.test(title)) return "nextSteps";
  if (/\b(?:blockers?|problems?)\b/u.test(title)) return "blockers";
  if (/^(?:where we left off|completed|progress|done)\b/u.test(title))
    return "completed";
  return undefined;
}

// A ReproGate projection escapes Markdown; undo that so a hand-edited
// projection reads back as what was written. Only a projection: in text kept
// by hand a backslash is part of a path or a pattern.
function unescaped(text: string): string {
  return text.replace(/\\([\\`*_[\]<>#|~!+=.)-])/gu, "$1");
}

// The longest closing fence of each kind after each line. A fence that never
// closes hides nothing here: losing the rest of a document to one stray
// marker is worse than keeping a little code. Worked out once, from the end,
// so a document of unclosed fences stays linear.
function closingFences(lines: readonly string[]): {
  "`": Uint32Array;
  "~": Uint32Array;
} {
  const after = {
    "`": new Uint32Array(lines.length + 1),
    "~": new Uint32Array(lines.length + 1),
  };
  for (let index = lines.length - 1; index > 0; index--) {
    after["`"][index - 1] = after["`"][index] ?? 0;
    after["~"][index - 1] = after["~"][index] ?? 0;
    const run = CLOSING_FENCE.exec(lines[index] ?? "")?.[1];
    if (run === undefined) continue;
    const list = after[run.startsWith("`") ? "`" : "~"];
    list[index - 1] = Math.max(list[index - 1] ?? 0, run.length);
  }
  return after;
}

function agentName(value: string | undefined): string {
  const name = (value ?? "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "")
    .replace(/[^A-Za-z0-9._]+$/u, "")
    .slice(0, 64);
  return name === "" ? "unknown" : name;
}

export interface ExtractedDocument {
  context: HandoffContextV1;
  /** Whether a goal, list or next step was found, not just the fallback. */
  recognized: boolean;
  /** Items beyond the per-list cap, which stay only in the document. */
  omittedItems: number;
  redactions: number;
}

/**
 * Best-effort context from a document kept by hand: the shared-protocol
 * sections, wherever they appear. The document stays the record of what was
 * written; this only gives the brief something to show. Redaction runs on
 * the whole document, so a credential spanning lines is caught before the
 * text is split, and again on each value once its Markdown escapes are
 * undone, so a projection's `ghp\_` cannot come back as a live token. A line
 * only reaches the context in printable form.
 */
export function extractDocument(
  bytes: Buffer,
  agent?: string,
): ExtractedDocument {
  const whole = redactHandoffText(
    bytes.toString("utf8").replace(/^\uFEFF/u, ""),
  );
  let redactions = whole.redactions;
  const projection = whole.text.includes(HANDOFF_PROJECTION_NOTICE);
  const clean = (value: string, maxBytes: number) => {
    // Escapes can hide a credential in any document, so it is always checked
    // in its unescaped form.
    const plain = redactHandoffText(unescaped(value));
    redactions += plain.redactions;
    return printableText(
      projection || plain.redactions > 0 ? plain.text : value,
      maxBytes,
    );
  };
  const lines = whole.text.split(/\r\n|\r|\n/u);
  const closers = closingFences(lines);
  const goal: string[] = [];
  const lists = {
    completed: [] as string[],
    blockers: [] as string[],
    nextSteps: [] as string[],
  };
  let lastAgent: string | undefined;
  let status: string | undefined;
  let omittedItems = 0;
  let section: Section | undefined;
  let level = 0;
  let goalDone = false;
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let sublist: "touched" | "plans" | undefined;
  const touched = new Set<string>();
  // The list item being read. Lines that directly follow it, indented or
  // not, are the same item wrapped.
  let open: { list: string[]; text: string; offset: number } | undefined;
  const finishItem = () => {
    if (open === undefined) return;
    const item = clean(open.text, MAX_ITEM_BYTES);
    if (item !== "" && !PLACEHOLDER.test(item)) {
      if (open.list.length < MAX_ITEMS) open.list.push(item);
      else omittedItems++;
    }
    open = undefined;
  };
  for (const [index, line] of lines.entries()) {
    if (fence !== undefined) {
      const run = CLOSING_FENCE.exec(line)?.[1];
      if (run?.startsWith(fence.marker) === true && run.length >= fence.length)
        fence = undefined;
      continue;
    }
    const opening = OPENING_FENCE.exec(line);
    const run = opening?.[1];
    if (run !== undefined) {
      const marker = run.startsWith("`") ? "`" : "~";
      // Backticks after the run make it inline code, not a fence.
      const inline = marker === "`" && (opening?.[2] ?? "").includes("`");
      if (!inline && (closers[marker][index] ?? 0) >= run.length) {
        finishItem();
        fence = { marker, length: run.length };
        continue;
      }
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      finishItem();
      const depth = (heading[1] ?? "").length;
      const named = sectionOf(heading[2] ?? "");
      // An unknown, deeper heading stays inside the section it falls under.
      if (section !== undefined && depth > level && named === undefined)
        continue;
      if (section === "goal" && named !== "goal") goalDone = true;
      section = named;
      level = depth;
      sublist = undefined;
      continue;
    }
    lastAgent ??= LAST_AGENT.exec(line)?.[1];
    if (section === undefined) status ??= STATUS.exec(line)?.[1];
    if (section === undefined) continue;
    const trimmed = line.trim();
    const entering = SUBLISTS.get(trimmed);
    if (entering !== undefined) {
      finishItem();
      sublist = entering;
      continue;
    }
    if (sublist !== undefined) {
      const entry = ITEM.exec(line)?.[1]?.trim();
      if (sublist === "touched" && entry !== undefined) {
        const path = clean(entry, MAX_PATH_BYTES);
        if (
          !PLACEHOLDER.test(path) &&
          touched.size < MAX_TOUCHED_FILES &&
          handoffDeclaredPathSchema.safeParse(path).success
        )
          touched.add(path);
      }
      continue;
    }
    if (
      trimmed === "" ||
      BARE_MARKER.test(trimmed) ||
      THEMATIC_BREAK.test(trimmed)
    ) {
      finishItem();
      continue;
    }
    if (section === "goal") {
      if (!goalDone) goal.push(trimmed);
      continue;
    }
    // A list inside the open item is detail; it is not a step of its own.
    const indent = line.length - line.trimStart().length;
    if (
      open !== undefined &&
      indent >= open.offset &&
      LIST_MARKER.test(trimmed)
    )
      continue;
    const listed = ITEM.exec(line);
    if (listed === null && open !== undefined) {
      open.text += ` ${trimmed}`;
      continue;
    }
    // An indented block on its own is detail, not an item.
    if (listed === null && /^[ \t]/u.test(line)) continue;
    finishItem();
    open = {
      list: lists[section],
      text: listed?.[1]?.trim() ?? trimmed,
      offset:
        listed?.[1] === undefined
          ? Number.POSITIVE_INFINITY
          : line.length - listed[1].length,
    };
  }
  finishItem();
  const parts = [
    ...(status === undefined
      ? []
      : [`Status: ${clean(status.trim(), MAX_ITEM_BYTES)}`]),
    ...(goal.length === 0 ? [] : [clean(goal.join("\n"), MAX_GOAL_BYTES)]),
  ];
  const label =
    lastAgent === undefined ? undefined : clean(lastAgent, MAX_ITEM_BYTES);
  return {
    context: {
      activeAgent:
        agent ??
        agentName(
          label?.includes(HANDOFF_REDACTED) === true ? undefined : label,
        ),
      goal:
        parts.length === 0
          ? NO_GOAL_FOUND
          : printableText(parts.join("\n"), MAX_GOAL_BYTES),
      completed: lists.completed,
      touchedFiles: [...touched],
      blockers: lists.blockers,
      nextSteps: lists.nextSteps,
    },
    recognized:
      parts.length > 0 ||
      lists.completed.length + lists.blockers.length + lists.nextSteps.length >
        0,
    omittedItems,
    redactions,
  };
}
