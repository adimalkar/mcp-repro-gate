/** Characters per estimated token; real counts depend on the host tokenizer. */
export const CHARS_PER_TOKEN = 4;

export interface DistilledBlock {
  kind: "text" | "code";
  text: string;
}

export interface Distilled {
  title: string;
  blocks: DistilledBlock[];
}

// Pages are untrusted and up to 2 MiB, so every pass below is linear: tags
// are found with indexOf and an unterminated construct ends the scan instead
// of being retried. No backtracking regular expression sees page content.

// Whole elements that carry no reading content. A dependency-free heuristic:
// elements recognisable only by class names (ad containers) are kept.
const SKIPPED = new Set([
  "head",
  "title",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "form",
  "nav",
  "header",
  "footer",
  "aside",
  "button",
  "select",
]);
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "li",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "table",
  "tr",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "br",
  "hr",
  "blockquote",
  "figure",
  "figcaption",
  "summary",
  "details",
]);
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
};

/** Decode HTML entities; the bounded pattern cannot backtrack badly. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/giu,
    (whole, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1] === "x" || name[1] === "X"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
          ? String.fromCodePoint(code)
          : "";
      }
      return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    },
  );
}

/** Cut to at most `length` UTF-16 units without splitting a surrogate pair. */
export function cutText(text: string, length: number): string {
  if (text.length <= length) return text;
  let end = Math.max(0, length);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

// ASCII-only lowering keeps every index aligned with the original string.
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/gu, (run) => run.toLowerCase());
}

function isNameStart(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

interface Tag {
  name: string;
  closing: boolean;
  end: number;
}

// Read the tag at `start` ("<"). `end` is the index of its ">", or -1.
function readTag(html: string, start: number): Tag | undefined {
  let index = start + 1;
  const closing = html.charCodeAt(index) === 47;
  if (closing) index++;
  if (!isNameStart(html.charCodeAt(index))) return undefined;
  let finish = index;
  while (finish < html.length) {
    const code = html.charCodeAt(finish);
    if (!(isNameStart(code) || (code >= 48 && code <= 57))) break;
    finish++;
  }
  return {
    name: html.slice(index, finish).toLowerCase(),
    closing,
    end: html.indexOf(">", finish),
  };
}

// Text of an HTML fragment with its tags removed, in one pass.
function textOf(fragment: string): string {
  let out = "";
  let index = 0;
  while (index < fragment.length) {
    const open = fragment.indexOf("<", index);
    if (open === -1) {
      out += fragment.slice(index);
      break;
    }
    out += fragment.slice(index, open);
    const code = fragment.charCodeAt(open + 1);
    if (!isNameStart(code) && code !== 47 && code !== 33) {
      out += "<";
      index = open + 1;
      continue;
    }
    const close = fragment.indexOf(">", open + 1);
    if (close === -1) break;
    index = close + 1;
  }
  return decodeEntities(out);
}

function trimCode(code: string): string {
  const text = code.replace(/\r\n?/gu, "\n").trimEnd();
  let start = 0;
  while (text.charCodeAt(start) === 10) start++;
  return text.slice(start);
}

/** Reduce an HTML page to its title, readable paragraphs and code blocks. */
export function distillHtml(html: string): Distilled {
  const lower = asciiLower(html);
  let title = "";
  const titleAt = lower.indexOf("<title");
  if (titleAt !== -1) {
    const open = html.indexOf(">", titleAt);
    const close = open === -1 ? -1 : lower.indexOf("</title", open);
    if (close !== -1)
      title = cutText(collapse(textOf(html.slice(open + 1, close))), 300);
  }
  const blocks: DistilledBlock[] = [];
  let paragraph = "";
  const flush = () => {
    const text = collapse(decodeEntities(paragraph));
    if (text.length > 0) blocks.push({ kind: "text", text });
    paragraph = "";
  };
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      paragraph += html.slice(index);
      break;
    }
    paragraph += html.slice(index, open);
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      index = close === -1 ? html.length : close + 3;
      continue;
    }
    const tag = readTag(html, open);
    if (tag === undefined) {
      // Not a tag ("a < b"): keep the character as text.
      paragraph += "<";
      index = open + 1;
      continue;
    }
    // An unterminated tag ends the readable page.
    if (tag.end === -1) break;
    index = tag.end + 1;
    if (tag.closing) {
      if (BLOCK.has(tag.name) || tag.name === "pre") flush();
      continue;
    }
    if (tag.name === "pre" || SKIPPED.has(tag.name)) {
      flush();
      const close = lower.indexOf(`</${tag.name}`, index);
      const inner = close === -1 ? html.length : close;
      if (tag.name === "pre") {
        const code = trimCode(textOf(html.slice(index, inner)));
        if (code.length > 0) blocks.push({ kind: "code", text: code });
      }
      const after = close === -1 ? -1 : html.indexOf(">", close);
      index = after === -1 ? html.length : after + 1;
      continue;
    }
    if (BLOCK.has(tag.name)) flush();
  }
  flush();
  return { title, blocks };
}

/** Plain text and Markdown keep their paragraphs and fenced code. */
export function distillPlain(text: string): Distilled {
  const blocks: DistilledBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] | undefined;
  const flush = () => {
    const joined = collapse(paragraph.join(" "));
    if (joined.length > 0) blocks.push({ kind: "text", text: joined });
    paragraph = [];
  };
  for (const line of text.replace(/\r\n?/gu, "\n").split("\n")) {
    if (line.trimStart().startsWith("```")) {
      if (code === undefined) {
        flush();
        code = [];
      } else {
        const body = trimCode(code.join("\n"));
        if (body.length > 0) blocks.push({ kind: "code", text: body });
        code = undefined;
      }
      continue;
    }
    if (code !== undefined) code.push(line);
    else if (line.trim() === "") flush();
    else paragraph.push(line);
  }
  // An unterminated fence still counts as code.
  if (code !== undefined) {
    const body = trimCode(code.join("\n"));
    if (body.length > 0) blocks.push({ kind: "code", text: body });
  }
  flush();
  return { title: "", blocks };
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "how",
  "what",
  "why",
  "are",
  "was",
  "not",
  "but",
  "you",
  "your",
  "can",
  "use",
  "into",
  "when",
  "does",
  "doesnt",
  "error",
]);

export function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((term) => term.length >= 2 && !STOP_WORDS.has(term)),
    ),
  ];
}

function score(block: DistilledBlock, terms: readonly string[]): number {
  const text = block.text.toLowerCase();
  let total = 0;
  let distinct = 0;
  for (const term of terms) {
    let count = 0;
    for (
      let index = text.indexOf(term);
      index !== -1 && count < 5;
      index = text.indexOf(term, index + term.length)
    )
      count++;
    if (count > 0) distinct++;
    total += count;
  }
  // Distinct terms matter most; code that matches gets a small bonus.
  return (
    distinct * 10 + total + (block.kind === "code" && distinct > 0 ? 3 : 0)
  );
}

function render(block: DistilledBlock): string {
  return block.kind === "code" ? `\`\`\`\n${block.text}\n\`\`\`` : block.text;
}

// Fit a block into `room` characters, marking the cut; code stays fenced.
function cutBlock(block: DistilledBlock, room: number): string {
  if (block.kind === "text") return `${cutText(block.text, room - 1)}…`;
  const fenceCost = "```\n".length + "\n…\n```".length;
  return `\`\`\`\n${cutText(block.text, room - fenceCost)}\n…\n\`\`\``;
}

/**
 * Keep the blocks most relevant to the query, in document order, within a
 * character budget. Blocks that match no query term are dropped whenever
 * any block matches; with no match at all, the opening blocks are kept. A
 * block too large for the remaining room is cut when at least 200
 * characters remain.
 */
export function selectRelevant(
  distilled: Distilled,
  query: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const terms = queryTerms(query);
  const scored = distilled.blocks.map((block, index) => ({
    block,
    index,
    score: score(block, terms),
  }));
  const matching = scored.filter((item) => item.score > 0);
  const candidates = (matching.length > 0 ? matching : scored).sort(
    (a, b) => b.score - a.score || a.index - b.index,
  );
  let truncated = candidates.length < scored.length;
  const chosen: { index: number; text: string }[] = [];
  let used = 0;
  for (const { block, index } of candidates) {
    const text = render(block);
    const cost = text.length + 2;
    if (used + cost > maxChars) {
      truncated = true;
      const room = maxChars - used - 2;
      if (room >= 200) {
        chosen.push({ index, text: cutBlock(block, room) });
        used = maxChars;
      }
      continue;
    }
    chosen.push({ index, text });
    used += cost;
  }
  chosen.sort((a, b) => a.index - b.index);
  return { text: chosen.map((item) => item.text).join("\n\n"), truncated };
}
