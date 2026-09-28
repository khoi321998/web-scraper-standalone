import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';

import { log } from '@crawlee/puppeteer';
import type { Dictionary } from '@crawlee/utils';
import { Actor } from 'apify';

import { InputError, StandbyScraper } from './standby_scraper.js';

const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
    constructor(
        readonly statusCode: number,
        message: string,
    ) {
        super(message);
    }
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

/**
 * Query string -> input overrides. `url` (repeatable) becomes `startUrls`, other values are parsed
 * as JSON when possible (numbers, booleans, objects), e.g. `?url=https://a.com&maxPagesPerCrawl=5`.
 */
function parseQuery(searchParams: URLSearchParams): Dictionary {
    const overrides: Dictionary = {};
    for (const key of new Set(searchParams.keys())) {
        if (key === 'url' || key === 'token') continue;
        const value = searchParams.get(key)!;
        try {
            overrides[key] = JSON.parse(value);
        } catch {
            overrides[key] = value;
        }
    }
    const urls = searchParams.getAll('url');
    if (urls.length) overrides.startUrls = urls.map((url) => ({ url }));
    return overrides;
}

async function readJsonBody(req: IncomingMessage): Promise<Dictionary> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.');
        chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};

    let body: unknown;
    try {
        body = JSON.parse(raw);
    } catch {
        throw new HttpError(400, 'Request body must be valid JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'Request body must be a JSON object with Actor input fields.');
    }
    return body as Dictionary;
}

async function handleRequest(scraper: StandbyScraper, req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Apify Standby readiness probe (and a plain health check) at the root path.
    if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        if (req.headers['x-apify-container-server-readiness-probe']) {
            res.end('Readiness probe OK\n');
        } else {
            res.end('Actor is ready. Send GET /scrape?url=<url> or POST /scrape with a JSON input.\n');
        }
        return;
    }

    const isScrapeRoute = url.pathname === '/scrape' || (url.pathname === '/' && req.method === 'POST');
    if (!isScrapeRoute) throw new HttpError(404, `Route ${req.method} ${url.pathname} not found.`);
    if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'Use GET or POST.');

    const overrides = { ...parseQuery(url.searchParams), ...(req.method === 'POST' ? await readJsonBody(req) : {}) };
    const result = await scraper.scrape(overrides);
    sendJson(res, 200, result);
}

/**
 * Entry point for Actor Standby mode: the run stays alive as an HTTP server and every request
 * is a scrape job executed on long-lived, already warmed-up crawlers.
 */
export async function runStandby() {
    await Actor.init();

    const baseInput = (await Actor.getInput<Dictionary>()) ?? {};
    if (baseInput.debugLog) log.setLevel(log.LEVELS.DEBUG);

    const scraper = new StandbyScraper(baseInput);

    const server = createServer((req, res) => {
        handleRequest(scraper, req, res).catch((err: Error) => {
            let statusCode = 500;
            if (err instanceof HttpError) statusCode = err.statusCode;
            else if (err instanceof InputError) statusCode = 400;
            if (statusCode >= 500) log.exception(err, 'Standby request failed.');
            else log.warning(`Standby request rejected (${statusCode}): ${err.message}`);
            if (!res.headersSent) sendJson(res, statusCode, { error: err.message });
            else res.end();
        });
    });

    Actor.on('aborting', async () => {
        server.close();
        await scraper.teardown();
        // Give Crawlee/SDK state persistence a moment to finish before exiting.
        await setTimeout(1000);
        await Actor.exit();
    });

    const port = Actor.config.get('containerPort');
    server.listen(port, () => log.info(`Standby server listening on port ${port}.`));

    // Readiness probe is already answered; prepare the default crawler in the background.
    scraper.warmUp().catch((err: Error) => log.warning(`Standby warm-up failed: ${err.message}`));
}
