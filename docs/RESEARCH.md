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
  1. keeps the first meaningful lines, minus stack frames, paths, URLs, IP and hex addresses, line and column numbers, UUIDs, long numbers and opaque strings, and redacts common secret forms: values after names such as `GITHUB_TOKEN=`, `client_secret:` or JSON `"password":`, `Authorization` and bearer credentials, JWTs, well-known API key prefixes and email addresses;
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
- **Relevance** is lexical. Paragraphs and code blocks are ranked by the query terms they contain. Each term is weighted by how rare it is on the page, so a term found in most blocks counts for little. Only matching blocks are kept, in document order. Blocks that match only terms common on the page are dropped, and so are repeated blocks, such as a heading that repeats its contents entry. When nothing matches, the opening blocks are returned.
- **Long blocks are cut, not dropped.** A relevant paragraph or code block bigger than the remaining room is cut, and marked with `…`, when at least 200 characters remain. Cuts never split a character. The source URL in the text is capped at 300 characters, while `finalUrl` keeps the full value.
- **The budget is an estimate.** `maxTokens` (100–1000, default 900) is enforced as 4 characters per token. Real token counts depend on the host's tokenizer, and code or non-English text can use more tokens per character.

The reduction against raw HTML and against page text is measured in [Measurement](#measurement) below.

## Measurement

The Phase 4 exit criteria ask for a reduction of more than 95% against raw HTML on external research. This section measures it.

```sh
npm run build
node dist/src/cli.js bench research          # fixture table
node dist/src/cli.js bench research --json   # machine-readable report
node dist/src/cli.js bench research --html saved-page.html --query "your terms"
```

The harness calls `fetch_distilled` and `resolve_stuck_error` through a real in-memory MCP client, using the default budget of 900 estimated tokens. Pages are injected, so nothing is fetched (`src/research/benchmark.ts`, fixture v1). Every call must succeed; a failed call stops the run instead of being measured.

### What is counted

- **Measured:** the UTF-8 bytes a host receives: the text content, `structuredContent` and `isError`, counted as in the façade measurement.
- **Raw HTML:** the page as a plain fetch tool would return it. This is the roadmap's baseline.
- **Page text:** every text node outside `head`, `script`, `style` and `template`, with whitespace collapsed, like a naive HTML-to-text tool. Navigation, footers, forms and comments stay in. This stricter baseline shows how much is saved beyond dropping markup.
- **Text:** the distilled text alone.
- **Answer:** each fixture page names one sentence a useful result must contain. `lost` would mean a row saved bytes by dropping the answer.

### Fixture results (synthetic pages)

| Page                    | Raw HTML B | Page text B | Measured B | Text B | vs HTML | vs text | Answer | Truncated |
| ----------------------- | ---------: | ----------: | ---------: | -----: | ------: | ------: | ------ | --------- |
| API reference page      |     270943 |       24909 |       1141 |    439 |   99.6% |   95.4% | kept   | yes       |
| Q&A thread              |     276518 |       14665 |        997 |    359 |   99.6% |   93.2% | kept   | yes       |
| tutorial blog post      |     183939 |       15591 |       1030 |    368 |   99.4% |   93.4% | kept   | yes       |
| issue tracker thread    |     280894 |       12150 |       1150 |    417 |   99.6% |   90.5% | kept   | yes       |
| small plain page        |        749 |         599 |        528 |    150 |   29.5% |   11.8% | kept   | yes       |
| error resolver, 3 pages |     741351 |       42406 |       6299 |   2790 |   99.2% |   85.2% | kept   | yes       |

Median reduction on this fixture: 99.5% against raw HTML and 91.9% against page text. All 6 answers were kept.

The fixture pages are generated in code and modeled on common page types: chrome-heavy markup, inline styles, scripts and JSON state, navigation, sidebars, comments. They are not copies of real pages, and their sizes are code parameters. Difficulty is uneven: the filler text never contains a query's distinctive terms, which makes the API reference and tutorial rows easy to rank. On the Q&A and issue rows, substring matches on filler words ("up" in "update", "read" in "thread") used to fill the budget. Rarity weighting now drops those blocks, because the filler terms are common on the page. The resolver row reads the issue thread, the Q&A thread and the tutorial, and is compared with the sum of their sizes.

### Manual run on real pages (2026-10-10)

These four public pages were saved once and measured with `--html`. Real pages change, so the numbers will not reproduce exactly, and no answer check is automated. Each result was read by hand and contained the passage the query was looking for. After the rarity-weighted ranking change, all four were measured again: the Node.js and MDN results got smaller and the other two did not change.

| Page and query                                                                           | Raw HTML B | Page text B | Measured B | vs HTML | vs text |
| ---------------------------------------------------------------------------------------- | ---------: | ----------: | ---------: | ------: | ------: |
| `nodejs.org/api/net.html`, "socket setKeepAlive initialDelay"                            |     275035 |       75554 |       4730 |   98.3% |   93.7% |
| `developer.mozilla.org/…/AbortController`, "abort fetch request signal"                  |     154370 |        4824 |       1786 |   98.8% |   63.0% |
| `docs.python.org/3/library/asyncio-task.html`, "gather return_exceptions"                |     177177 |       46182 |       7654 |   95.7% |   83.4% |
| `docs.docker.com/compose/how-tos/startup-order/`, "depends_on condition service_healthy" |     525375 |       24286 |       2773 |   99.5% |   88.6% |

### What these numbers do and do not show

- **Against raw HTML, every page measured here (all above 150 KB) saves more than 95%.** Most of that is markup, scripts and styles, which any HTML-to-text step would also drop. The reduction is also capped by the budget: a result that uses the full default budget measures about 7.4–7.7 KB here, so it passes 95% only when the raw page is above roughly 150 KB, however good the distillation is. The page-text column is the one that reflects distillation. It shows smaller savings when the page has little besides its content, as on the MDN page, or when many passages are relevant and the budget is used, as on the Python page.
- **Small pages save little.** On the plain-page row, the result keeps only the title, the source line and the answer section, but the fixed per-call overhead and the second copy of the text outweigh what was dropped.
- **The text is sent twice.** `fetch_distilled` and `resolve_stuck_error` put the same text in `content` and `structuredContent`, so measured bytes are at least twice the text, plus JSON field overhead that weighs most on short results (compare the Measured B and Text B columns). A host that shows the model only one of them sees about half. This duplication is now the largest remaining cost.
- **Truncation means the selection kept some blocks and dropped others.** It is not a free saving: dropped passages are gone for the agent.
- **Ranking is lexical.** Rarity weighting fixed the Node.js case, where a long paragraph about Unix domain sockets that repeats "socket" used to take part of the budget. Ranking still matches substrings ("socket" in `SocketAddress`) and knows no synonyms, so a passage that answers the query in other words can be missed.
- **Bytes, not tokens.** Tokens are estimated at 4 bytes each; host tokenizers differ.

## Threat notes

Fetched pages are untrusted input. A page can contain text written to steer the model (prompt injection), and distillation does not remove it. Treat results as data. Mediation still redacts and bounds what reaches the model, and receipts record each fetch. The address checks stop the backend from reaching the host's internal network through user-supplied URLs or redirects. They do not stop a public page from carrying harmful content.
