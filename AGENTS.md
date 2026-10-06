# Web Scraper Server — Agent Guide

Self-hosted HTTP server that scrapes one URL per request with headless Chrome (Crawlee `PuppeteerCrawler`). It is **not** an Apify Actor anymore: there is no `Actor.init()`, no input schema and no dataset. The `apify` package is used only to build Apify Proxy URLs.

## Structure

- `src/server.ts`: HTTP server (`POST /scrape`, `GET /`), env config, API key check, a keep-alive crawler with a job map that resolves each HTTP request when its page is scraped.
- `src/internals/pageFunction.ts`: what gets extracted from a page. This is the only extraction logic.
- `src/internals/proxy.ts`: Apify Proxy with a per-request country (`AUTO_PROXY_COUNTRIES`, based on the ccTLD).
- `src/internals/tld_country.ts`: gets the ccTLD from a URL.
- `src/internals/consts.ts`: shared constants (`ACCEPT_LANGUAGE`).

## Rules

- Configuration comes from env vars read in `src/server.ts`, with defaults in code. Add a new setting there, log it in the startup `Server config` line, and document it in README.md.
- Never log secrets (`API_KEY`, `APIFY_PROXY_PASSWORD`). Log only whether they are set.
- Don't accept code from requests (no `eval` of page functions or hooks). Request bodies carry data only.
- Keep `pageFunction.ts` type-checked TypeScript. Browser-side code goes inside `page.evaluate`.
- Log with `log` from `@crawlee/puppeteer` (Apify's log, which censors tokens).

## Commands

```bash
npm run build                     # tsc
npm run lint
docker build -t web-scraper-standalone .
docker run -d --name wss-server -p 8080:8080 --cpus=4 --memory=4g --security-opt seccomp=unconfined --env-file .env web-scraper-standalone
```

Chrome needs `--security-opt seccomp=unconfined` in Docker. After changing code, rebuild the image and recreate the container.

Ask before: Dockerfile changes, adding npm packages, and changing the API contract (request/response shape) that the backend depends on.
