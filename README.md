# Web Scraper Server

A self-hosted HTTP server that scrapes a web page on demand with headless Chrome (Puppeteer + Crawlee) and returns the extracted content in the response.

It keeps one browser warm, so there is no per-request cold start. The number of pages processed in parallel is capped by `MAX_CONCURRENCY`. Extra requests wait in a queue instead of overloading the server.

## API

### `POST /scrape`

Scrapes one URL. Requires the `x-api-key` header.

```bash
curl -X POST http://localhost:8080/scrape \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{"url":"https://www.hdwebsoft.com/"}'
```

Response `200`:

```json
{
    "status": "success",
    "url": "https://www.hdwebsoft.com/",
    "title": "Software Development Company in Vietnam | HDWEBSOFT",
    "count": 2228,
    "content": [{ "type": "text", "tag": "meta:description", "text": "..." }],
    "statusCode": 200,
    "timing": { "queueMs": 484, "processMs": 3358, "totalMs": 3842 }
}
```

- `status` is `"success"` on `200` and `"failed"` on every error response, so callers can check one field.
- Every error response (`400`, `401`, `500`, `502`, `503`) has the same body: `{ "status": "failed", "url", "error", "statusCode", "timing" }`. `url` is `null` when the request had no valid url (`400`, `401`, `500`). `statusCode` is `null` and `timing` is all zeros when no scrape ran.
- `statusCode` is the HTTP status of the target page (after redirects). A `200` from this server means the page loaded with a status below 400.
- `content` holds meta tags, JSON-LD, contact-like script rows, hidden inputs, visible text, links, images, mailto/tel links and social iframes. See [src/internals/pageFunction.ts](src/internals/pageFunction.ts).
- `timing.queueMs` is the time spent waiting for a free slot. `processMs` is the time spent scraping.

| Status | Meaning |
| --- | --- |
| `200` | Scraped successfully |
| `400` | Body is not valid JSON, or `url` is missing or not http(s) |
| `401` | Missing or wrong `x-api-key` |
| `502` | Scraping failed after all retries. Body: `{ "status": "failed", "url", "error", "statusCode", "timing" }` |
| `503` | Queue is full (`MAX_QUEUE`) |

On `502`, `statusCode` is the target page's HTTP status in the last attempt, or `null` when no response came back (proxy error, DNS failure, timeout). How target statuses are handled:

| Target status | Handling |
| --- | --- |
| `< 400` | Success |
| `401`, `403`, `429`, Cloudflare challenge | Treated as blocked: retried with a new proxy session |
| `5xx` | Retried |
| Other `4xx` (e.g. `404`, `410`) | Not retried, fails at once |
| No response | Retried with a new proxy session |

### `GET /`

Health check. No auth. Returns `{"status":"ok","maxConcurrency":4,"active":1,"inProgress":3}`.

## Running with Docker

### Local

```bash
docker build -t web-scraper-standalone .

docker run -d --name wss-server -p 8080:8080 --cpus=4 --memory=4g --security-opt seccomp=unconfined --env-file .env web-scraper-standalone
```

The commands are on one line so they work in bash and PowerShell alike. To run new code, rebuild and recreate the container (a running container keeps using the old image):

```bash
docker rm -f wss-server
docker build -t web-scraper-standalone .
docker run -d --name wss-server -p 8080:8080 --cpus=4 --memory=4g --security-opt seccomp=unconfined --env-file .env web-scraper-standalone
```

### Production

```bash
docker run -d --name wss-server \
  --restart unless-stopped --init \
  -p <private-ip>:8080:8080 \
  --cpus=4 --memory=4g --shm-size=1g \
  --security-opt seccomp=unconfined \
  --log-opt max-size=20m --log-opt max-file=5 \
  --env-file .env \
  web-scraper-standalone
```

- `--restart unless-stopped` restarts the container after a crash or a server reboot.
- `--init` reaps exited Chrome processes so they don't pile up as zombies.
- Bind the port to a private IP (or `127.0.0.1` behind Nginx / Caddy on the same host). Docker's port publishing bypasses `ufw`, so `-p 8080:8080` is reachable from the internet even when the firewall blocks it.
- `--log-opt` caps log files. Every request writes a few log lines.
- `--shm-size=1g` gives Chrome more shared memory than Docker's 64 MB default for many open tabs.

### Notes

- Put the configuration in a `.env` file next to the Dockerfile (see [Configuration](#configuration)). At minimum it needs `API_KEY` and `CRAWLEE_MEMORY_MBYTES`. `.env` is ignored by both git and Docker, so the secrets are never committed or baked into the image.
- `--security-opt seccomp=unconfined` is required. Without it, Chrome's sandbox cannot start inside the container.
- Set `CRAWLEE_MEMORY_MBYTES` to the container's memory limit. The server always runs at `MAX_CONCURRENCY` (Crawlee's autoscaling is pinned), so this only affects Crawlee's memory warnings, which over-count Chrome's shared memory.
- Generate the API key with `openssl rand -hex 32`.

The server logs its effective configuration at startup. Secrets are shown only as `set` or `not set`.

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `API_KEY` | required | Shared secret the caller sends in `x-api-key` (at least 16 characters) |
| `PORT` | `8080` | HTTP port |
| `MAX_CONCURRENCY` | `4` | Pages scraped in parallel. Without a proxy, use about 1.5 per CPU. With a residential proxy, pages mostly wait on the network, so more fits (10 on 4 CPUs). See [Sizing](#sizing) |
| `MAX_QUEUE` | `100` | Max requests in progress or waiting. Beyond this, requests get `503` |
| `MAX_REQUEST_RETRIES` | `3` | Retries per URL after a failure (`0` = no retries) |
| `TIMEOUT_SECS` | `45` | Page load timeout, and separately the processing timeout |
| `MAX_SCROLL_HEIGHT_PIXELS` | `5000` | Scroll distance used to load lazy content (`0` = no scrolling) |
| `CLOSE_COOKIE_MODALS` | `true` | Dismiss cookie consent pop-ups before extracting |
| `USE_APIFY_PROXY` | `false` | Route traffic through Apify Proxy |
| `APIFY_PROXY_PASSWORD` | | Required when `USE_APIFY_PROXY=true` |
| `APIFY_PROXY_GROUPS` | | Comma-separated proxy groups, e.g. `RESIDENTIAL` |
| `CRAWLEE_MEMORY_MBYTES` | 1/4 of RAM | Memory Crawlee may use. Set it to the container's limit |

## Sizing

Measured in Docker without a proxy, on 10 small business sites (2026-10-02):

| Container | `MAX_CONCURRENCY` | Time per page | Pages per minute | Peak RAM |
| --- | --- | --- | --- | --- |
| 2 CPU, 4 GB | 3 | ~6 s | ~28 | 0.8 GB |
| 2 CPU, 4 GB | 6 | ~11 s | ~30 | 0.9 GB |
| 4 CPU, 4 GB | 6 | ~6 s | ~52 | 0.9 GB |
| 4 CPU, 4 GB | 12 | ~13 s | ~47 | 1.3 GB |

- CPU is the bottleneck. Past about 1.5 pages per CPU, more concurrency only makes each page slower.
- RAM is about 600 MB plus 45 MB per page in progress, so 1 GB per CPU is enough.
- To scale, run more instances behind a load balancer. The server is stateless.
- These numbers are without a proxy. A residential proxy adds seconds of network wait per page, and Chrome uses almost no CPU while waiting, so more pages fit per CPU: 10 on 4 CPUs / 4 GB ran fine in local tests (2026-10-06).
- To check a setting under real load: `docker stats` near 100% per CPU means CPU is the limit, and so do `scroll` / `extract` steps in the `Scraped ...` log growing to several seconds. `nav` mostly reflects proxy speed.

With Apify Proxy enabled, `.ua` URLs automatically use a Ukrainian proxy. All other URLs use a random proxy from the configured groups. Edit the allowlist in [src/internals/proxy.ts](src/internals/proxy.ts).

Behaviour fixed in code: Chrome in headless mode, `domcontentloaded` navigation, images, fonts and CSS blocked, robots.txt ignored, the `accept-language` header from [src/internals/consts.ts](src/internals/consts.ts).

## Timeouts for callers

A failing URL is retried `MAX_REQUEST_RETRIES` times. Each attempt can take up to about 2 × `TIMEOUT_SECS`. With the defaults, a worst-case failure takes several minutes to return `502`. Set the caller's HTTP timeout above that, or lower `MAX_REQUEST_RETRIES` / `TIMEOUT_SECS`.

## Security

- Only `POST /scrape` requires the API key. `GET /` is open for health checks and exposes only counters.
- Don't expose the port to the internet. Restrict it with a firewall to the backend's IP, or keep it on a private network, and use the API key as a second layer.
- Put HTTPS (e.g. Nginx or Caddy) in front if traffic crosses the internet.

## Development

```bash
npm install
npm run build        # tsc -> dist/
npm run lint
API_KEY=<key> npm run start:dev    # runs src/server.ts with tsx (needs Chrome installed locally)
```
