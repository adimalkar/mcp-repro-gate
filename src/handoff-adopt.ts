import type { HandoffContextV1 } from "./handoff-contract.js";
import { redactHandoffText } from "./handoff-redact.js";
import { printableText } from "./handoff-session-contract.js";

// A snapshot row holds 64 KiB of JSON, and escaping can double a text, so
// the extracted context stays well under half of that.
const MAX_GOAL_BYTES = 2048;
const MAX_ITEM_BYTES = 512;
const MAX_ITEMS = 16;

export const NO_GOAL_FOUND =
  "Adopted a document with no recognized goal; read .agent/handoff.md.";

type Section = "goal" | "completed" | "blockers" | "nextSteps";

// Trailing spaces and #s are removed without a regex: a pattern anchored at
// the end of the line would backtrack quadratically on a long one.
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/u;
const FENCE = /^ {0,3}(?:```|~~~)/u;
const ITEM = /^ {0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+(.+)$/u;
const LAST_AGENT = /^ {0,3}[-*][ \t]+\*\*Last Active Agent\*\*:[ \t]*(.+)$/u;
// Files kept by hand often say where things stand here, above the sections,
// while the goal below grows stale. A brief shows the goal, so it leads.
const STATUS = /^ {0,3}[-*][ \t]+\*\*Status\*\*:[ \t]*(.+)$/u;
// ReproGate's own placeholders and sublists are not content.
const PLACEHOLDER =
  /^(?:Nothing recorded\.|None recorded\.|None declared\.)$(?![\s\S])/u;
const SUBLIST = /^(?:Declared touched files|Persisted plan references):$/u;

function sectionOf(heading: string): Section | undefined {
  let end = heading.trimEnd().length;
  while (end > 0 && heading[end - 1] === "#") end--;
  const title = heading
    .slice(0, end)
    .replace(/[*_`]/gu, "")
    .replace(/^[\d.)\s]+/u, "")
    .toLowerCase();
  if (/^(?:(?:active|current) )?(?:goal|task|objective)\b/u.test(title))
    return "goal";
  if (/next steps?\b/u.test(title)) return "nextSteps";
  if (/\b(?:blockers?|problems?)\b/u.test(title)) return "blockers";
  if (/^(?:where we left off|completed|progress|done)\b/u.test(title))
    return "completed";
  return undefined;
}

// A ReproGate projection escapes Markdown; undo that so a hand-edited
// projection reads back as what was written.
function unescaped(text: string): string {
  return text.replace(/\\([\\`*_[\]<>#|~!+=.)-])/gu, "$1");
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
 * text is split, and a line only reaches the context in printable form.
 */
export function extractDocument(
  bytes: Buffer,
  agent?: string,
): ExtractedDocument {
  const { text, redactions } = redactHandoffText(
    bytes.toString("utf8").replace(/^\uFEFF/u, ""),
  );
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
  let fenced = false;
  let skipping = false;
  for (const line of text.split(/\r\n|\r|\n/u)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const depth = (heading[1] ?? "").length;
      const named = sectionOf(heading[2] ?? "");
      // An unknown, deeper heading stays inside the section it falls under.
      if (section !== undefined && depth > level && named === undefined)
        continue;
      if (section === "goal") goalDone = true;
      section = named;
      level = depth;
      skipping = false;
      continue;
    }
    lastAgent ??= LAST_AGENT.exec(line)?.[1];
    if (section === undefined) status ??= STATUS.exec(line)?.[1];
    if (section === undefined || skipping) continue;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (SUBLIST.test(trimmed)) {
      skipping = true;
      continue;
    }
    if (section === "goal") {
      if (!goalDone) goal.push(unescaped(trimmed));
      continue;
    }
    // A line indented past a list item continues it; it is left out.
    const listed = ITEM.exec(line);
    if (listed === null && /^[ \t]/u.test(line)) continue;
    const item = unescaped(listed?.[1]?.trim() ?? trimmed);
    if (PLACEHOLDER.test(item)) continue;
    const list = lists[section];
    if (list.length < MAX_ITEMS) list.push(printableText(item, MAX_ITEM_BYTES));
    else omittedItems++;
  }
  if (status !== undefined)
    goal.unshift(
      `Status: ${printableText(unescaped(status.trim()), MAX_ITEM_BYTES)}`,
    );
  const foundGoal = goal.length > 0;
  return {
    context: {
      activeAgent: agent ?? agentName(lastAgent),
      goal: foundGoal
        ? printableText(goal.join("\n"), MAX_GOAL_BYTES)
        : NO_GOAL_FOUND,
      completed: lists.completed,
      touchedFiles: [],
      blockers: lists.blockers,
      nextSteps: lists.nextSteps,
    },
    recognized:
      foundGoal ||
      lists.completed.length + lists.blockers.length + lists.nextSteps.length >
        0,
    omittedItems,
    redactions,
  };
}
