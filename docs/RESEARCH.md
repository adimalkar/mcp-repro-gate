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

## Search and error resolution

With `--search-endpoint`, the server also offers two search tools. Each is catalogued and approved like `fetch_distilled`:

- **`web_search { query, maxResults? }`** (1–10, default 5) returns titles (at most 200 characters), URLs and snippets (at most 300 characters). Control and bidirectional characters are removed. Results without a plain `http(s)` URL are dropped.
- **`resolve_stuck_error { error, context?, maxTokens? }`** builds a search query from the error and returns the most relevant passages and code within one budget, with each source named. It:
  1. keeps the first meaningful lines, minus stack frames, paths, URLs, IP and hex addresses, line and column numbers, UUIDs, long numbers and opaque strings, and redacts common secret forms (`key=value` secrets, bearer tokens, JWTs, well-known API key prefixes, email addresses);
  2. searches;
  3. fetches the top 3 results in parallel under the same limits as `fetch_distilled`;
  4. distills each page against the error and `context`.

  Pages that cannot be read are skipped and counted. When no source can be read, the result is `no_results`.

```sh
reprogate research-server --search-endpoint 'https://search.example/search?q={query}&format=json'
```

- **Endpoint:** any SearXNG-compatible JSON API that returns `{ "results": [{ "url", "title", "content" }] }`. `{query}` is replaced by the percent-encoded query and must come after the host, in the path, query or fragment, so a query can never choose the host, port or credentials. A template that breaks this rule is refused at startup. ReproGate has no built-in provider and sends nothing anywhere without one.
- **Endpoint requests:** answers must be `application/json`, at most 1 MiB, and are never redirected.
- **Self-hosted engines:** for a search engine on a private network or localhost, add `--search-endpoint-private`. It exempts only that endpoint's origin from the address policy. Every result URL is still checked in full, so a search result pointing at a private address is refused.
- **What leaves your machine:** the search query goes to the provider. For `resolve_stuck_error`, that is the cleaned first lines of the error message. Redaction is best-effort and pattern-based: internal host names, identifiers from your code and secrets in unusual formats can still remain. Choose a provider you trust with that, and do not pass errors that contain credentials.
- **Search results are untrusted.** Anyone can publish a page that ranks for an error message and carries misleading fixes or prompt-injection text. Review suggested fixes before applying them.

## Fetch limits

- **URLs:** only `http:` and `https:`, with no credentials in the URL.
- **Addresses:** every resolved address is checked when the connection is made. Loopback, private, link-local, carrier-grade NAT, benchmark, documentation, multicast, broadcast and reserved ranges are refused, in both IPv4 and IPv6. IPv4 addresses embedded in IPv6 are judged by the embedded address when they use the IPv4-mapped (`::ffff:0:0/96`) or well-known NAT64 (`64:ff9b::/96`) prefix. The rest of the reserved `::/8` range (including IPv4-compatible `::a.b.c.d`), local-use NAT64 (`64:ff9b:1::/48`), 6to4 and Teredo prefixes are refused outright. If any address a name resolves to is blocked, the fetch is refused.
- **Redirects:** at most 3, each checked again. A redirect from `https` to plain `http` is refused.
- **Time and size:** 10 seconds for the network fetch and 2 MiB of body. Refused responses (redirects, error statuses, unsupported types) are closed at once, not read to the end. Distillation runs after the fetch in a single linear pass, so a hostile page cannot stall it.
- **Types:** only `text/html`, `application/xhtml+xml`, `text/plain` and `text/markdown`, read as UTF-8.
- **Host allowlist:** `--allow-host docs.example.com` allows that host; `--allow-host .example.com` also allows its subdomains.
- **Errors:** stable codes (`bad_url`, `blocked_host`, `blocked_address`, `too_large`, `unsupported_type`, `timeout`, `http_status`, `fetch_failed`, `search_failed`, `no_results`) that never include the response body.
- **Proxies:** the backend makes direct connections and ignores proxy environment variables.

## What distillation does and does not do

- **Removed:** comments, scripts, styles, `noscript`, `template`, `svg`, `iframe`, forms, buttons, `nav`, `header`, `footer` and `aside`.
- **Kept:** `pre` blocks become fenced code. Block elements become paragraphs. Entities are decoded.
- **One unclosed tag ends the page.** Text after a `<` that starts a tag but never reaches `>` is dropped. This fails safe, but a malformed page can come back shorter than it looks in a browser.
- **A heuristic, not a browser:** it does not run JavaScript, so pages rendered by scripts may come back nearly empty. It does not remove ads or banners marked only by class names.
- **Relevance** is lexical. Paragraphs and code blocks are ranked by how many query terms they contain, and only matching blocks are kept, in document order. When nothing matches, the opening blocks are returned.
- **Long blocks are cut, not dropped.** A relevant paragraph or code block bigger than the remaining room is cut, and marked with `…`, when at least 200 characters remain. Cuts never split a character. The source URL in the text is capped at 300 characters, while `finalUrl` keeps the full value.
- **The budget is an estimate.** `maxTokens` (100–1000, default 900) is enforced as 4 characters per token. Real token counts depend on the host's tokenizer, and code or non-English text can use more tokens per character.

No token reduction compared with raw HTML is claimed here. Measuring it belongs to the [benchmarks](BENCHMARKS.md).

## Threat notes

Fetched pages are untrusted input. A page can contain text written to steer the model (prompt injection), and distillation does not remove it. Treat results as data. Mediation still redacts and bounds what reaches the model, and receipts record each fetch. The address checks stop the backend from reaching the host's internal network through user-supplied URLs or redirects. They do not stop a public page from carrying harmful content.
