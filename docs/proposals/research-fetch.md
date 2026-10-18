# Research backend with distilled page fetch: eighth Phase 4 slice

Status: proposed implementation. This is the first part of the Phase 4 item "token-budgeted web research & error resolver". This slice delivers the fetch-and-distill core. Search providers and `resolve_stuck_error` build on it in the next slice. It claims no token reduction until the benchmark measures one.

## Placement

The roadmap calls the tools "native". Fetching arbitrary URLs inside the gateway would, however, bypass ReproGate's own contract, and a URL-fetching server is a classic server-side request forgery (SSRF) surface. So the research tools ship as a **separate stdio backend in this package**, `reprogate research-server`. An operator configures it like any other backend:

- pinned by artifact digest;
- catalogued with a `network_read` effect (`catalog import` works);
- planned, approved or host-mediated, and receipted, like every other tool.

ReproGate itself still makes no network requests.

## Deliverable

- **`reprogate research-server [--allow-host <host>]...`** serves one tool, `fetch_distilled { url, query, maxTokens? }`.
- **Fetching:**
  - only `http:` and `https:` URLs, with no credentials in the URL and the default ports or explicit ones;
  - every hostname resolved, and every resolved address checked when the connection is made, through the request's own `lookup`. That covers loopback, private, link-local, carrier-grade NAT, multicast, unspecified and IPv4-mapped forms, plus documentation and benchmark ranges, and refuses DNS-rebinding swaps;
  - at most 3 redirects, each re-validated;
  - a 10-second total timeout and a 2 MiB body cap;
  - only `text/html`, `application/xhtml+xml`, `text/plain` and `text/markdown`, decoded as UTF-8.
  - The optional `--allow-host` list restricts fetches to the named hosts; an entry starting with `.` matches subdomains.
- **Distillation:** HTML is reduced to text.
  - It removes comments and `script`, `style`, `noscript`, `template`, `svg`, `iframe`, `form`, `nav`, `header`, `footer` and `aside` blocks.
  - It keeps `pre`/`code` blocks as fenced code, turns block tags into paragraph breaks, decodes entities, and collapses whitespace.
  - This is a dependency-free heuristic, not a browser: elements identified only by class names (such as ad containers) are not removed.
- **Relevance windowing:**
  - The query is split into lowercase terms, minus a small stop-word list.
  - Paragraphs and code blocks are scored by term matches, and the highest-scoring ones are kept, in document order, until the budget is reached.
  - The page title and final URL are always included.
- **Budget:** `maxTokens` is 100 to 1000, default 900. It is enforced as a character budget of 4 characters per token, which is an **estimate**: real token counts depend on the host's tokenizer.
- **Result:** `structuredContent` holds `{ url, finalUrl, title, estimatedTokens, truncated, text }`. Errors are stable codes (`blocked_address`, `blocked_host`, `bad_url`, `too_large`, `unsupported_type`, `timeout`, `http_status`, `fetch_failed`) and never echo the response body.
- **Docs:** `docs/RESEARCH.md` (setup through the catalog and mediation, limits, threat notes), plus updates to `THREAT_MODEL`, `CHANGELOG` and the README.

## Review changes

The independent review found:

- **Hostname fetches failed:** Node's automatic family selection calls the custom `lookup` with `all: true`, which it did not handle. Fetches by hostname failed, closed rather than open.
- **Quadratic-time distillation:** a crafted page could stall the server for minutes. Distillation is now a single linear `indexOf`-based pass.
- **Bodies drained:** refused responses kept downloading.
- **Missed IPv6 forms:** IPv4-compatible and local-use NAT64 addresses got through.

Lower-severity fixes:

- forgeable code markers (removed);
- relevant code silently dropped (now cut);
- surrogate-splitting cuts;
- an unbounded URL in the header;
- `--allow-host .` allowing every host;
- https-to-http redirects.

Tests cover each of these.

## Verification

- **Address policy:** unit tests cover every blocked range and IPv6/IPv4-mapped forms. A real local HTTP server is refused as `blocked_address`. A redirect to a blocked address is refused, and so is a hostname that resolves to a blocked address.
- **Fetching:** a real local server is used through an injected address policy, a test-only module seam that the CLI cannot reach. It checks redirects, size cap, content type, timeout and status handling.
- **Distillation:** fixtures check that scripts and navigation are removed, code blocks are kept, entities are decoded, relevance ordering holds, and the budget is never exceeded.
- **MCP:** a real client lists and calls the tool on an in-process server with an injected fetcher. The spawned CLI refuses a loopback URL.
