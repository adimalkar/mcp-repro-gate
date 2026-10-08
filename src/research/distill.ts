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

// Whole elements that carry no reading content. A dependency-free heuristic:
// elements recognisable only by class names (ad containers) are kept.
const NOISE_ELEMENTS = [
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
];
const BLOCK_TAGS =
  /<\/?(?:p|div|section|article|main|li|ul|ol|dl|dt|dd|table|tr|td|th|h[1-6]|br|hr|blockquote|figure|figcaption|summary|details)\b[^>]*>/giu;
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

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/gu, ""));
}

function normalize(text: string): string {
  return text
    .replace(/[\t\f\v\r ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .trim();
}

/** Reduce an HTML page to its title, readable paragraphs and code blocks. */
export function distillHtml(html: string): Distilled {
  const title = normalize(
    stripTags(/<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1] ?? ""),
  ).slice(0, 300);
  // The private-use character marks code blocks below; input cannot forge it.
  let body = html.replace(/\uE000/gu, "").replace(/<!--[\s\S]*?-->/gu, "");
  // The title is reported separately; keep it out of the body text.
  body = body
    .replace(/<head\b[\s\S]*?<\/head>/giu, "")
    .replace(/<title\b[\s\S]*?<\/title\s*>/giu, "");
  for (const tag of NOISE_ELEMENTS)
    body = body.replace(
      new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "giu"),
      "\n",
    );
  // Self-closing or unterminated noise tags would otherwise leak text.
  for (const tag of NOISE_ELEMENTS)
    body = body.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "giu"), "\n");
  const codes: string[] = [];
  body = body.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/giu,
    (_whole, inner: string) => {
      codes.push(
        stripTags(inner)
          .replace(/\r\n?/gu, "\n")
          .replace(/^\n+|\s+$/gu, ""),
      );
      return `\n\uE000CODE${String(codes.length - 1)}\uE000\n`;
    },
  );
  body = body.replace(BLOCK_TAGS, "\n\n");
  const blocks: DistilledBlock[] = [];
  for (const piece of stripTags(body).split(/\n\s*\n/u)) {
    const marker = /^\s*\uE000CODE(\d+)\uE000\s*$/u.exec(piece);
    if (marker?.[1] !== undefined) {
      const code = codes[Number(marker[1])] ?? "";
      if (code.length > 0) blocks.push({ kind: "code", text: code });
      continue;
    }
    // A marker can share a paragraph with text; split it out.
    for (const part of piece
      .split(/\uE000CODE(\d+)\uE000/u)
      .map((value, index) =>
        index % 2 === 1
          ? ({ kind: "code", text: codes[Number(value)] ?? "" } as const)
          : ({ kind: "text", text: normalize(value) } as const),
      ))
      if (part.text.length > 0) blocks.push(part);
  }
  return { title, blocks };
}

/** Plain text and Markdown keep their paragraphs and fenced code. */
export function distillPlain(text: string): Distilled {
  const blocks: DistilledBlock[] = [];
  const parts = text
    .replace(/\r\n?/gu, "\n")
    .split(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/mu);
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      if (part.trim().length > 0)
        blocks.push({ kind: "code", text: part.replace(/\s+$/u, "") });
      return;
    }
    for (const paragraph of part.split(/\n\s*\n/u)) {
      const normalized = normalize(paragraph);
      if (normalized.length > 0)
        blocks.push({ kind: "text", text: normalized });
    }
  });
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
      index !== -1;
      index = text.indexOf(term, index + term.length)
    )
      count++;
    if (count > 0) distinct++;
    total += Math.min(count, 5);
  }
  // Distinct terms matter most; code that matches gets a small bonus.
  return (
    distinct * 10 + total + (block.kind === "code" && distinct > 0 ? 3 : 0)
  );
}

function render(block: DistilledBlock): string {
  return block.kind === "code" ? `\`\`\`\n${block.text}\n\`\`\`` : block.text;
}

/**
 * Keep the blocks most relevant to the query, in document order, within a
 * character budget. Blocks that match no query term are dropped whenever
 * any block matches; with no match at all, the opening blocks are kept.
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
      // A long text block can still contribute a cut prefix if room remains.
      const room = maxChars - used - 2;
      if (block.kind === "text" && room >= 200) {
        chosen.push({ index, text: `${text.slice(0, room - 1)}…` });
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
