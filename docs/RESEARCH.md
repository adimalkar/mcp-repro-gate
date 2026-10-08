# Research backend

`reprogate research-server` is a stdio MCP backend that ships in this package. Its one tool, `fetch_distilled { url, query, maxTokens? }`, fetches a public web page and returns:

- the page title;
- the final URL;
- the passages most relevant to the query, with code blocks kept, within an estimated token budget.

ReproGate itself never fetches anything. You configure the research server as a backend, so every fetch is a planned, receipted action like any other.

## Setup

1. Pin the artifact, as for any backend. The command is your Node binary and the artifact is `dist/src/cli.js`, with `args` set to `["/absolute/path/dist/src/cli.js", "research-server"]` and optional `--allow-host` entries:

   ```sh
   node dist/src/cli.js artifact digest /absolute/path/dist/src/cli.js
   ```

2. Import the tool with a network effect and review the entry:

   ```sh
   node dist/src/cli.js catalog import --config /absolute/path/draft.json \
     --backend research --effects network_read --tools fetch_distilled
   ```

3. Decide how fetches are approved:
   - With the default policy, `network_read` is `approval_required`, so each fetch needs an approval.
   - To let an agent fetch without one, set `network_read: allow` for this tool in policy, add `network_read` to `mediation.effects`, and keep `maxRunsPerPlan` small. See [host mediation](CONFIGURATION.md#host-mediated-execution).
   - Consider `--allow-host` to limit fetches to documentation sites you trust.

## Fetch limits

- **URLs:** only `http:` and `https:`, with no credentials in the URL.
- **Addresses:** every resolved address is checked when the connection is made. Loopback, private, link-local, carrier-grade NAT, benchmark, documentation, multicast, broadcast and reserved ranges are refused, in both IPv4 and IPv6. That includes IPv4-mapped and NAT64 forms of those addresses. If any address a name resolves to is blocked, the fetch is refused.
- **Redirects:** at most 3, each checked again.
- **Time and size:** 10 seconds total and 2 MiB of body.
- **Types:** only `text/html`, `application/xhtml+xml`, `text/plain` and `text/markdown`, read as UTF-8.
- **Host allowlist:** `--allow-host docs.example.com` allows that host; `--allow-host .example.com` also allows its subdomains.
- **Errors:** stable codes (`bad_url`, `blocked_host`, `blocked_address`, `too_large`, `unsupported_type`, `timeout`, `http_status`, `fetch_failed`) that never include the response body.
- **Proxies:** the backend makes direct connections and ignores proxy environment variables.

## What distillation does and does not do

- **Removed:** comments, scripts, styles, `noscript`, `template`, `svg`, `iframe`, forms, buttons, `nav`, `header`, `footer` and `aside`.
- **Kept:** `pre` blocks become fenced code. Block elements become paragraphs. Entities are decoded.
- **A heuristic, not a browser:** it does not run JavaScript, so pages rendered by scripts may come back nearly empty. It does not remove ads or banners marked only by class names.
- **Relevance** is lexical. Paragraphs and code blocks are ranked by how many query terms they contain, and only matching blocks are kept, in document order. When nothing matches, the opening blocks are returned.
- **The budget is an estimate.** `maxTokens` (100–1000, default 900) is enforced as 4 characters per token. Real token counts depend on the host's tokenizer, and code or non-English text can use more tokens per character.

No token reduction compared with raw HTML is claimed here. Measuring it belongs to the [benchmarks](BENCHMARKS.md).

## Threat notes

Fetched pages are untrusted input. A page can contain text written to steer the model (prompt injection), and distillation does not remove it. Treat results as data. Mediation still redacts and bounds what reaches the model, and receipts record each fetch. The address checks stop the backend from reaching the host's internal network through user-supplied URLs or redirects. They do not stop a public page from carrying harmful content.
