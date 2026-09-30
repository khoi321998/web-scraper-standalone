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
    "url": "https://www.hdwebsoft.com/",
    "title": "Software Development Company in Vietnam | HDWEBSOFT",
    "count": 2228,
    "content": [{ "type": "text", "tag": "meta:description", "text": "..." }],
    "timing": { "queueMs": 484, "processMs": 3358, "totalMs": 3842 }
}
```

- `content` holds meta tags, JSON-LD, contact-like script rows, hidden inputs, visible text, links, images, mailto/tel links and social iframes. See [src/internals/pageFunction.ts](src/internals/pageFunction.ts).
- `timing.queueMs` is the time spent waiting for a free slot. `processMs` is the time spent scraping.

| Status | Meaning |
| --- | --- |
| `200` | Scraped successfully |
| `400` | Body is not valid JSON, or `url` is missing or not http(s) |
| `401` | Missing or wrong `x-api-key` |
| `502` | Scraping failed after all retries (the response includes `error`) |
| `503` | Queue is full (`MAX_QUEUE`) |

### `GET /`

Health check. No auth. Returns `{"status":"ok","maxConcurrency":4,"active":1,"inProgress":3}`.

## Running with Docker

```bash
docker build -t web-scraper-standalone .

docker run -d --name wss-server -p 8080:8080 \
  --cpus=2 --memory=4g \
  --security-opt seccomp=unconfined \
  -e CRAWLEE_MEMORY_MBYTES=4096 \
  -e API_KEY=<API_KEY> \
  web-scraper-standalone
```

- `--security-opt seccomp=unconfined` is required. Without it, Chrome's sandbox cannot start inside the container.
- Set `CRAWLEE_MEMORY_MBYTES` to the container's memory limit. Otherwise Crawlee assumes it may use only 1/4 of it and throttles concurrency.
- Generate the API key with `openssl rand -hex 32`. Keep it out of git. `--env-file` is a convenient place for it.
- After a rebuild, remove the old container and run it again. A running container keeps using the old image.

The server logs its effective configuration at startup. Secrets are shown only as `set` or `not set`.

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `API_KEY` | required | Shared secret the caller sends in `x-api-key` (at least 16 characters) |
| `PORT` | `8080` | HTTP port |
| `MAX_CONCURRENCY` | `4` | Max pages scraped in parallel. Size it to the server's RAM (about 400 MB per page) |
| `MAX_QUEUE` | `100` | Max requests in progress or waiting. Beyond this, requests get `503` |
| `MAX_REQUEST_RETRIES` | `3` | Retries per URL after a failure (`0` = no retries) |
| `TIMEOUT_SECS` | `60` | Page load timeout, and separately the processing timeout |
| `MAX_SCROLL_HEIGHT_PIXELS` | `5000` | Scroll distance used to load lazy content (`0` = no scrolling) |
| `CLOSE_COOKIE_MODALS` | `true` | Dismiss cookie consent pop-ups before extracting |
| `USE_APIFY_PROXY` | `false` | Route traffic through Apify Proxy |
| `APIFY_PROXY_PASSWORD` | | Required when `USE_APIFY_PROXY=true` |
| `APIFY_PROXY_GROUPS` | | Comma-separated proxy groups, e.g. `RESIDENTIAL` |
| `CRAWLEE_MEMORY_MBYTES` | 1/4 of RAM | Memory Crawlee may use. Set it to the container's limit |

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
