import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ProxyInfo, PuppeteerCrawlingContext } from '@crawlee/puppeteer';
import { Configuration, log, LoggerText, NonRetryableError, PuppeteerCrawler } from '@crawlee/puppeteer';
import { getInjectableScript } from 'idcac-playwright';
import type { HTTPResponse, Page } from 'puppeteer';

import { ACCEPT_LANGUAGE } from './internals/consts.js';
import type { HarvestResult } from './internals/pageFunction.js';
import { pageFunction } from './internals/pageFunction.js';
import { AUTO_PROXY_COUNTRIES, createApifyProxyConfiguration } from './internals/proxy.js';

/**
 * Scraper HTTP server: keeps one browser warm and scrapes URLs on demand.
 *
 *   POST /scrape  { "url": "https://..." }  -> scrape result + timing (requires header x-api-key)
 *   GET  /                                  -> health / status (no auth, for health checks)
 *
 * Env vars: API_KEY (required), PORT (8080), MAX_CONCURRENCY (4), MAX_QUEUE (100), MAX_REQUEST_RETRIES (3),
 * TIMEOUT_SECS (60), MAX_SCROLL_HEIGHT_PIXELS (5000, 0 = no scrolling), CLOSE_COOKIE_MODALS (true),
 * USE_APIFY_PROXY (false) + APIFY_PROXY_PASSWORD, APIFY_PROXY_GROUPS (comma-separated).
 */

// Prefix every log line with a timestamp.
log.setOptions({ logger: new LoggerText({ skipTime: false }) });

function intEnv(name: string, fallback: number, min = 1): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) throw new Error(`Env var ${name} must be an integer >= ${min}, got "${raw}".`);
    return value;
}

const API_KEY = process.env.API_KEY ?? '';
if (API_KEY.length < 16) throw new Error('Env var API_KEY is required and must be at least 16 characters.');

const PORT = intEnv('PORT', 8080);
const MAX_CONCURRENCY = intEnv('MAX_CONCURRENCY', 4);
const MAX_QUEUE = intEnv('MAX_QUEUE', 100);
const MAX_REQUEST_RETRIES = intEnv('MAX_REQUEST_RETRIES', 3, 0);
const TIMEOUT_SECS = intEnv('TIMEOUT_SECS', 60);
const MAX_SCROLL_HEIGHT_PIXELS = intEnv('MAX_SCROLL_HEIGHT_PIXELS', 5000, 0);
const CLOSE_COOKIE_MODALS = process.env.CLOSE_COOKIE_MODALS !== 'false';
const USE_APIFY_PROXY = process.env.USE_APIFY_PROXY === 'true';
const APIFY_PROXY_GROUPS = process.env.APIFY_PROXY_GROUPS?.split(',').filter(Boolean);
const MAX_BODY_BYTES = 64 * 1024;

const BLOCKED_URL_PATTERNS = ['.jpg', '.jpeg', '.png', '.svg', '.gif', '.webp', '.webm', '.ico', '.woff', '.eot', '.css'];
/** Crawlee treats these as "blocked": it retires the session (proxy) and retries on its own. */
const BLOCKED_STATUS_CODES = [401, 403, 429];
/**
 * How long after a job finishes its request is deleted from the queue. The job resolves inside the request
 * handler, before Crawlee marks the request handled, and marking a deleted request re-inserts it - so wait.
 */
const REQUEST_CLEANUP_DELAY_MS = 30_000;
const MEMORY_LOG_INTERVAL_MS = 10 * 60_000;

interface Job {
    resolve: (result: HarvestResult) => void;
    reject: (error: Error) => void;
    enqueuedAt: number;
    startedAt?: number;
    /** Proxy used for the last attempt, for logging. */
    proxy?: string;
    /** HTTP status of the target page in the last attempt; undefined when no response was received. */
    statusCode?: number;
    /** Number of navigation attempts (1 = no retry). */
    attempts: number;
    /** Network timing of the last attempt, for logging; undefined when no response was received. */
    network?: string;
}

/** Proxy username carries group / session / country (e.g. "groups-RESIDENTIAL,session-x,country-UA"), never the password. */
function describeProxy(proxyInfo?: ProxyInfo): string {
    if (!proxyInfo) return 'none';
    return proxyInfo.username || proxyInfo.hostname;
}

/**
 * Chrome's own timing of the main document (same numbers as DevTools > Timing). Behind a proxy:
 * - proxy tunnel: connect to the proxy + CONNECT (proxy picks an exit IP and reaches the site), without TLS
 * - TLS: TLS handshake with the site through the tunnel
 * - wait for response: request sent -> response headers received (proxy relay + site server time)
 * Connect / TLS are -1 when Chrome reuses an open connection.
 */
function describeNetworkTiming(response: HTTPResponse): string {
    const t = response.timing();
    if (!t) return 'not available';
    const waitMs = t.receiveHeadersEnd - t.sendEnd;
    if (t.connectStart < 0) return `connection reused, wait for response ${secs(waitMs)}`;
    const tlsMs = t.sslStart < 0 ? 0 : t.sslEnd - t.sslStart;
    const tunnelMs = t.connectEnd - t.connectStart - tlsMs;
    return `proxy tunnel ${secs(tunnelMs)}, TLS ${secs(tlsMs)}, wait for response ${secs(waitMs)}`;
}

function describeNetwork(job: Job): string {
    return `network: ${job.network ?? 'no response'}, attempts ${job.attempts}`;
}

const SCROLL_STEP_PIXELS = 2000;

/**
 * Scrolls down in small steps with short random pauses so lazy content loads. Uses window.scrollBy instead of
 * Crawlee's infiniteScroll: that sends mouse wheel input, which waits for the tab to handle it, and with several
 * tabs open the wait often took 10-60s and hit the request timeout.
 */
async function scrollPage(page: Page, maxScrollHeight: number) {
    let scrolled = 0;
    let bottomHits = 0;
    while (scrolled < maxScrollHeight && bottomHits < 2) {
        const atBottom = await page.evaluate((step) => {
            window.scrollBy(0, step);
            return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;
        }, SCROLL_STEP_PIXELS);
        scrolled += SCROLL_STEP_PIXELS;
        // Stop once the page stays at the bottom for two steps, i.e. nothing new loaded during the pause.
        bottomHits = atBottom ? bottomHits + 1 : 0;
        await sleep(100 + Math.random() * 200);
    }
    // Give requests triggered by the last scroll a moment to finish.
    await sleep(500);
}

const jobs = new Map<string, Job>();
let activeCount = 0;

// Requests live only for the lifetime of the process - don't write them to ./storage.
Configuration.getGlobalConfig().set('persistStorage', false);

const proxyConfiguration = USE_APIFY_PROXY ? await createApifyProxyConfiguration(APIFY_PROXY_GROUPS) : undefined;

const crawler = new PuppeteerCrawler({
    keepAlive: true,
    maxConcurrency: MAX_CONCURRENCY,
    // Run at exactly MAX_CONCURRENCY. Crawlee's autoscaling cut it to 1-2 on Chrome's normal CPU spikes and
    // over-counts memory (it sums RSS of Chrome processes that share memory), so MAX_CONCURRENCY is the only limit.
    autoscaledPoolOptions: { desiredConcurrency: MAX_CONCURRENCY, minConcurrency: MAX_CONCURRENCY },
    maxRequestRetries: MAX_REQUEST_RETRIES,
    navigationTimeoutSecs: TIMEOUT_SECS,
    requestHandlerTimeoutSecs: TIMEOUT_SECS,
    // Session pool is on by default with Crawlee's usage limits = "recommended" proxy rotation.
    proxyConfiguration,
    respectRobotsTxtFile: false,
    // Keep an idle browser warm. The default retires it after 10s without new pages, so the next request
    // pays a Chrome cold start (~2s). Browsers are still recycled after 100 pages (retireBrowserAfterPageCount).
    browserPoolOptions: { retireInactiveBrowserAfterSecs: 3600 },
    launchContext: {
        useChrome: true,
        launchOptions: { headless: true, defaultViewport: { width: 1920, height: 1080 } },
    },
    preNavigationHooks: [
        async ({ request, page, blockRequests }, gotoOptions) => {
            const job = jobs.get(request.userData.jobId as string);
            if (job && job.startedAt === undefined) job.startedAt = Date.now();
            if (job) {
                job.statusCode = undefined;
                job.network = undefined;
                job.attempts++;
            }
            await blockRequests({ urlPatterns: BLOCKED_URL_PATTERNS });
            await page.setExtraHTTPHeaders({ 'accept-language': ACCEPT_LANGUAGE });
            // Crawlee's API for navigation options is to mutate gotoOptions in a pre-navigation hook.
            // eslint-disable-next-line no-param-reassign
            if (gotoOptions) gotoOptions.waitUntil = 'domcontentloaded';
        },
    ],
    postNavigationHooks: [
        async ({ request, response }) => {
            const statusCode = response?.status();
            const job = jobs.get(request.userData.jobId as string);
            if (job) {
                job.statusCode = statusCode;
                if (response) job.network = describeNetworkTiming(response);
            }
            if (statusCode === undefined || statusCode < 400 || BLOCKED_STATUS_CODES.includes(statusCode)) return;
            // 5xx is often temporary (overloaded site, flaky proxy exit), so retry. Other 4xx (404, 410...) won't change.
            const message = `Target page returned HTTP ${statusCode}.`;
            throw statusCode >= 500 ? new Error(message) : new NonRetryableError(message);
        },
    ],
    async requestHandler(ctx: PuppeteerCrawlingContext) {
        activeCount++;
        const job = jobs.get(ctx.request.userData.jobId as string);
        if (job) job.proxy = describeProxy(ctx.proxyInfo);
        try {
            if (CLOSE_COOKIE_MODALS) {
                await sleep(500);
                await ctx.page.evaluate(getInjectableScript());
                await sleep(2000);
            }
            // Scroll to load lazy content before extracting.
            if (MAX_SCROLL_HEIGHT_PIXELS > 0) await scrollPage(ctx.page, MAX_SCROLL_HEIGHT_PIXELS);
            const result = await pageFunction({ page: ctx.page, request: ctx.request, log: ctx.log });
            job?.resolve(result);
        } finally {
            activeCount--;
        }
    },
    failedRequestHandler({ request, proxyInfo }, error) {
        const job = jobs.get(request.userData.jobId as string);
        if (job) job.proxy = describeProxy(proxyInfo);
        job?.reject(error);
    },
});

const API_KEY_BUFFER = Buffer.from(API_KEY);

function isAuthorized(req: IncomingMessage): boolean {
    const provided = req.headers['x-api-key'];
    if (typeof provided !== 'string') return false;
    const providedBuffer = Buffer.from(provided);
    // Constant-time comparison so the key can't be guessed from response timing.
    return providedBuffer.length === API_KEY_BUFFER.length && timingSafeEqual(providedBuffer, API_KEY_BUFFER);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

const NO_TIMING = { queueMs: 0, processMs: 0, totalMs: 0 };

/** Every failed /scrape response has the same shape, so the backend can read url / error / statusCode / timing. */
function sendFailed(
    res: ServerResponse,
    httpStatus: number,
    body: { url?: string | null; error: string; statusCode?: number | null; timing?: typeof NO_TIMING },
) {
    const { url = null, error, statusCode = null, timing: t = NO_TIMING } = body;
    sendJson(res, httpStatus, { status: 'failed', url, error, statusCode, timing: t });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new Error('Request body too large.');
        chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function parseTargetUrl(body: unknown): string | null {
    const url = (body as { url?: unknown })?.url;
    if (typeof url !== 'string') return null;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
        return null;
    }
}

async function handleScrape(req: IncomingMessage, res: ServerResponse) {
    let body: unknown;
    try {
        body = await readJsonBody(req);
    } catch (error) {
        sendFailed(res, 400, { error: `Invalid JSON body: ${(error as Error).message}` });
        return;
    }

    const url = parseTargetUrl(body);
    if (!url) {
        sendFailed(res, 400, { error: 'Body must be JSON like {"url": "https://example.com"}.' });
        return;
    }

    if (jobs.size >= MAX_QUEUE) {
        sendFailed(res, 503, { url, error: `Server busy: ${jobs.size} requests in progress (MAX_QUEUE=${MAX_QUEUE}).` });
        return;
    }

    const jobId = randomUUID();
    const job = { enqueuedAt: Date.now(), attempts: 0 } as Job;
    const done = new Promise<HarvestResult>((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
    });
    jobs.set(jobId, job);
    let requestId: string | undefined;
    log.info(`Received ${url} (in progress: ${jobs.size}, active: ${activeCount}/${MAX_CONCURRENCY})`);

    try {
        const { addedRequests } = await crawler.addRequests([{ url, uniqueKey: jobId, userData: { jobId } }]);
        requestId = addedRequests[0]?.requestId;
        // Wake the pool now. Its periodic check can be blocked while a task runs (betterSetInterval in
        // @apify/utilities waits for the task), so without this a new request waits for a running one to finish.
        await crawler.autoscaledPool?.notify();
        const result = await done;
        const t = timing(job);
        const statusCode = job.statusCode ?? null;
        log.info(
            `Scraped ${url} (HTTP ${statusCode ?? '?'}) in ${secs(t.totalMs)} (queue ${secs(t.queueMs)}, scrape ${secs(t.processMs)}), proxy: ${job.proxy ?? 'none'}, ${describeNetwork(job)}`,
        );
        sendJson(res, 200, { status: 'success', ...result, statusCode, timing: t });
    } catch (error) {
        const t = timing(job);
        const statusCode = job.statusCode ?? null;
        log.warning(
            `Scrape failed for ${url} (HTTP ${statusCode ?? 'no response'}) after ${secs(t.totalMs)}, proxy: ${job.proxy ?? 'none'}, ${describeNetwork(job)}: ${(error as Error).message}`,
        );
        sendFailed(res, 502, { url, error: (error as Error).message, statusCode, timing: t });
    } finally {
        jobs.delete(jobId);
        if (requestId) scheduleRequestCleanup(requestId);
    }
}

/**
 * The in-memory request queue keeps every handled request until the process exits (Crawlee is built for
 * finite crawls), so a long-running server would grow without bound. Delete each request once it is done.
 */
function scheduleRequestCleanup(requestId: string) {
    setTimeout(() => {
        crawler.requestQueue?.client.deleteRequest(requestId).catch((error: Error) => {
            log.warning(`Failed to delete request ${requestId} from the queue: ${error.message}`);
        });
    }, REQUEST_CLEANUP_DELAY_MS).unref();
}

async function logMemory() {
    const queueInfo = await crawler.requestQueue?.client.get();
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    log.info(`Memory: Node RSS ${rssMb} MB, requests kept in queue: ${queueInfo?.totalRequestCount ?? 0}`);
}

setInterval(() => {
    logMemory().catch((error: Error) => log.warning(`Failed to log memory usage: ${error.message}`));
}, MEMORY_LOG_INTERVAL_MS).unref();

function secs(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

function timing(job: Job) {
    const now = Date.now();
    const startedAt = job.startedAt ?? now;
    return { queueMs: startedAt - job.enqueuedAt, processMs: now - startedAt, totalMs: now - job.enqueuedAt };
}

const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'GET' && path === '/') {
        sendJson(res, 200, {
            status: 'ok',
            maxConcurrency: MAX_CONCURRENCY,
            active: activeCount,
            inProgress: jobs.size,
        });
        return;
    }

    if (req.method === 'POST' && path === '/scrape') {
        if (!isAuthorized(req)) {
            sendFailed(res, 401, { error: 'Missing or invalid x-api-key header.' });
            return;
        }
        handleScrape(req, res).catch((error) => {
            log.exception(error as Error, 'Unhandled error while handling /scrape');
            if (!res.headersSent) sendFailed(res, 500, { error: 'Internal server error.' });
        });
        return;
    }

    sendJson(res, 404, { error: 'Not found. Use POST /scrape or GET /.' });
});

crawler.run().catch((error) => {
    log.exception(error as Error, 'Crawler stopped unexpectedly');
    process.exit(1);
});

server.listen(PORT, () => {
    log.info(`Scraper server listening on port ${PORT}`);
    // Never log secrets: API_KEY and APIFY_PROXY_PASSWORD are reported only as set / not set.
    log.info('Server config', {
        PORT,
        MAX_CONCURRENCY,
        MAX_QUEUE,
        MAX_REQUEST_RETRIES,
        TIMEOUT_SECS,
        MAX_SCROLL_HEIGHT_PIXELS,
        CLOSE_COOKIE_MODALS,
        USE_APIFY_PROXY,
        APIFY_PROXY_GROUPS: APIFY_PROXY_GROUPS ?? [],
        AUTO_PROXY_COUNTRIES,
        APIFY_PROXY_PASSWORD: process.env.APIFY_PROXY_PASSWORD ? 'set' : 'not set',
        API_KEY: 'set',
        CRAWLEE_MEMORY_MBYTES: process.env.CRAWLEE_MEMORY_MBYTES ?? 'not set (Crawlee uses 1/4 of system RAM)',
    });
});

async function shutdown(signal: string) {
    log.info(`Received ${signal}, shutting down.`);
    server.close();
    await crawler.teardown();
    process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        shutdown(signal).catch((error) => {
            log.exception(error as Error, 'Error during shutdown');
            process.exit(1);
        });
    });
}
