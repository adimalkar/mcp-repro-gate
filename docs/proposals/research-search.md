# Research search and error resolver: ninth Phase 4 slice

Status: proposed implementation. This completes the Phase 4 item "token-budgeted web research & error resolver" on top of `fetch_distilled` (#34). It claims no token reduction until the benchmark measures one.

## Deliverable

- **`reprogate research-server --search-endpoint <url>`** configures a SearXNG-compatible JSON search endpoint.
  - The URL must contain `{query}`, which is replaced by the percent-encoded query, and must ask for JSON (for example `https://search.example/search?q={query}&format=json`).
  - No provider is built in. Without `--search-endpoint`, only `fetch_distilled` is served.
  - The endpoint is operator-chosen and may sit outside `--allow-host`. Its responses are read as JSON, `{ results: [{ url, title, content }] }`, at most 1 MiB, with no redirects followed.
  - **`--search-endpoint-private`** lets that one configured endpoint resolve to a private or loopback address, for a self-hosted engine. The exemption applies to the endpoint's exact origin only. Every result URL, and everything `fetch_distilled` fetches, still goes through the full address policy and host allowlist. The model can choose neither the endpoint nor the exemption.
- **`web_search { query, maxResults? }`** (1–10, default 5) returns `{ results: [{ title, url, snippet }] }`.
  - Titles are cut to 200 characters and snippets to 300.
  - Results with non-`http(s)` URLs or credentials in the URL are dropped.
  - Control and bidirectional characters are removed from titles and snippets.
- **`resolve_stuck_error { error, context?, maxTokens? }`** (100–1000, default 900):
  1. It derives a search query from the error. It keeps the first meaningful lines and removes file paths, URLs, hexadecimal addresses, line and column numbers, UUIDs and long numbers, keeping at most 200 characters.
  2. It searches, then fetches the top 3 result pages in parallel through the same protections as `fetch_distilled`.
  3. It distills each page against the error and context terms, and joins the relevant passages and code within one shared budget, with each page's source shown.
  4. Pages that fail are skipped and counted.
  - `structuredContent` holds `{ query, sources: [{ url, title }], skipped, estimatedTokens, truncated, text }`.
- **Errors:** `search_failed` and `no_results` join the existing stable codes. Neither echoes provider content.
- **Docs:** `docs/RESEARCH.md` covers search setup, the private-endpoint exemption, what is sent to the provider (the query, including any error text), and the risk that search results are poisoned. `THREAT_MODEL` and `CHANGELOG` are updated too.

## Verification

- **Query derivation:** fixtures for stack traces, Windows and POSIX paths, URLs, addresses, line and column numbers, and UUIDs.
- **Search client:** tested against a real local endpoint through the private exemption. It covers JSON parsing, bounds, filtering of unsafe URLs and control characters, size limits, refusal to follow redirects, the content-type check, and that the exemption does not apply to other origins or to result URLs.
- **Resolver:** combines several sources within budget, skips failed pages, and returns `no_results` and `search_failed` with stable codes. Result URLs pointing at private addresses are skipped as `blocked_address`, even when the endpoint is private.
- **MCP:** the tools appear only when search is configured. The spawned CLI is checked with a local endpoint and the private flag.

## Review changes

An independent review of the first implementation found these issues, now fixed:

- **High: host chosen by the query.** A template such as `http://{query}:9/s` let the query pick the host, so with `--search-endpoint-private` it could reach any private address. `{query}` must now come after the authority. Two different substitutions must give the same `http(s)` origin without credentials, and each request is checked against that origin before it is sent.
- **Medium: secrets sent to the provider.** Error text can hold tokens, keys and addresses. The query builder now redacts values after secret-like names (including prefixed names such as `GITHUB_TOKEN` and JSON keys), `Authorization` and bearer credentials, JWTs, well-known API key prefixes, email addresses, IPv4 and IPv6 addresses and long opaque strings. The docs describe this as best-effort.
- **Low: invisible characters in resolver output.** Distillation now removes control, zero-width and bidirectional characters from page text, titles and code.
- **Smaller fixes:** at most 50 search items are examined, fragment-only variants of a URL count as duplicates, endpoint requests send `Accept: application/json`, and the CLI reports an invalid endpoint template with its usage message.
- **Re-review (medium): common secret forms missed.** Prefixed names (`DB_PASSWORD=`), quoted JSON keys and `Authorization: Bearer x` slipped past the first redaction. They are now covered. A key name followed only by a space is redacted only when the next word looks like a secret (letters and digits, 8+ characters), so `Unexpected token '<'` stays searchable.
