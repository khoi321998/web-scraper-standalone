import { createHash, randomUUID } from 'node:crypto';

import type {
    EnqueueLinksByClickingElementsOptions,
    EnqueueLinksOptions,
    ProxyConfiguration,
    PuppeteerCrawlerOptions,
    PuppeteerCrawlingContext,
    PuppeteerGoToOptions,
    RequestOptions,
} from '@crawlee/puppeteer';
import {
    Configuration,
    Dataset,
    KeyValueStore,
    log,
    PuppeteerCrawler,
    Request,
    RequestList,
    RequestQueue,
} from '@crawlee/puppeteer';
import type { Dictionary } from '@crawlee/utils';
import { sleep } from '@crawlee/utils';
import type { ApifyEnv } from 'apify';
import { Actor } from 'apify';
import { getInjectableScript } from 'idcac-playwright';

import type { CrawlerSetupOptions, RequestMetadata } from '@apify/scraper-tools';
import { browserTools, constants as scraperToolsConstants, createContext, tools } from '@apify/scraper-tools';

import type { Input } from './consts.js';
import { ProxyRotation, SESSION_STORE_NAME } from './consts.js';
import type { EvaledUserFunctions } from './input_utils.js';
import {
    applyAutoProxyCountry,
    applyFixedSettings,
    evalUserFunctions,
    getBlockedUrlPatterns,
    SCHEMA,
    validateInput,
} from './input_utils.js';

const { META_KEY, DEFAULT_VIEWPORT, SESSION_MAX_USAGE_COUNTS } = scraperToolsConstants;

/** userData key that ties a request in the shared queue to the job (HTTP request) that created it. */
const JOB_KEY = '__standbyJobId';

/** Platform cuts Standby HTTP responses at 5 minutes, so jobs must finish (with partial results) before that. */
const DEFAULT_JOB_TIMEOUT_SECS = 240;
const MAX_JOB_TIMEOUT_SECS = 290;

/**
 * Inputs that are baked into a crawler instance (browser launch, proxy, session pool, autoscaling).
 * Jobs that agree on these share one warm crawler; everything else is applied per job.
 */
const CRAWLER_LEVEL_KEYS = [
    'proxyConfiguration',
    'sessionPoolName',
    'headless',
    'ignoreSslErrors',
    'ignoreCorsAndCsp',
    'maxConcurrency',
    'maxRequestRetries',
    'respectRobotsTxtFile',
    'pageFunctionTimeoutSecs',
] as const satisfies readonly (keyof Input)[];

/** Warn when requests keep spawning new crawlers - each one has its own browser pool. */
const CRAWLER_COUNT_WARNING_THRESHOLD = 3;

export interface StandbyInput extends Input {
    /** Max time the HTTP request waits for the job; partial results are returned on timeout. */
    timeoutSecs?: number;
    /** Also push results to the (default or named) dataset, like batch runs do. */
    saveToDataset?: boolean;
}

export type JobStatus = 'running' | 'completed' | 'maxResultsReached' | 'timedOut' | 'aborted';

export interface JobResult {
    jobId: string;
    status: JobStatus;
    durationMillis: number;
    itemCount: number;
    items: Dictionary[];
}

/** Input problems that should be reported to the HTTP client as 400 rather than 500. */
export class InputError extends Error {}

/**
 * Request queue shared by all jobs of one crawler. It drops requests of already finished jobs
 * (timed out / limit reached) instead of handing them out - the crawler would otherwise still open
 * a browser page for each of them, and a large leftover backlog delays every job behind it.
 */
class StandbyRequestQueue extends RequestQueue {
    /**
     * Not created via `RequestQueue.open()`: Crawlee derives the storage client method from the
     * class name there, which breaks for subclasses.
     */
    static async create(name: string, config: Configuration, isStale: (request: Request) => boolean) {
        const client = config.getStorageClient();
        const { id } = await client.requestQueues().getOrCreate(name);
        return new StandbyRequestQueue({ id, name, client }, config, isStale);
    }

    private constructor(
        options: ConstructorParameters<typeof RequestQueue>[0],
        config: Configuration,
        private readonly isStale: (request: Request) => boolean,
    ) {
        super(options, config);
    }

    override async fetchNextRequest<T extends Dictionary = Dictionary>(): Promise<Request<T> | null> {
        for (;;) {
            const request = await super.fetchNextRequest<T>();
            if (!request || !this.isStale(request)) return request;
            await this.markRequestHandled(request);
        }
    }
}

interface CrawlerEntry {
    crawler: PuppeteerCrawler;
    requestQueue: StandbyRequestQueue;
}

/**
 * One HTTP scrape request. Tracks how many of its requests are still in the shared queue,
 * and resolves `done` once all of them settled (or a limit / the timeout was hit).
 */
class ScrapeJob {
    readonly id = randomUUID();
    readonly startedAt = Date.now();
    readonly rawInput: string;
    readonly globalStore = new Map<string, unknown>();
    readonly fns: EvaledUserFunctions;
    readonly blockedUrlPatterns: string[];
    readonly timeoutMillis: number;
    readonly items: Dictionary[] = [];
    readonly done: Promise<void>;

    status: JobStatus = 'running';
    requestQueue!: StandbyRequestQueue;
    keyValueStore!: KeyValueStore;
    dataset?: Dataset;

    /** Requests of this job that are in the queue and not yet handled or failed. */
    private pending = 0;
    /** Requests of this job ever accepted into the queue - the `maxPagesPerCrawl` budget. */
    private accepted = 0;
    private resolveDone!: () => void;

    constructor(readonly input: StandbyInput) {
        this.rawInput = JSON.stringify(input);
        this.fns = evalUserFunctions(input);
        this.blockedUrlPatterns = getBlockedUrlPatterns(input);
        const timeoutSecs = Math.min(input.timeoutSecs || DEFAULT_JOB_TIMEOUT_SECS, MAX_JOB_TIMEOUT_SECS);
        this.timeoutMillis = timeoutSecs * 1000;
        this.done = new Promise((resolve) => {
            this.resolveDone = resolve;
        });
    }

    get isFinished() {
        return this.status !== 'running';
    }

    finish(status: Exclude<JobStatus, 'running'>) {
        if (this.isFinished) return;
        this.status = status;
        this.resolveDone();
    }

    /** Holds the job open while requests are being added, so a fast crawler can't complete it early. */
    hold() {
        this.pending++;
    }

    /** Marks one request (or a `hold()`) as settled; completes the job when nothing is left. */
    settle() {
        this.pending--;
        if (this.pending <= 0) this.finish('completed');
    }

    /** Counts requests that were really added to the queue (not deduplicated). */
    track(processedRequests: { wasAlreadyPresent: boolean }[]) {
        const added = processedRequests.filter((req) => !req.wasAlreadyPresent).length;
        this.pending += added;
        this.accepted += added;
    }

    /** How many more requests may be enqueued, `undefined` when unlimited. */
    remainingBudget() {
        const { maxPagesPerCrawl } = this.input;
        return maxPagesPerCrawl > 0 ? Math.max(maxPagesPerCrawl - this.accepted, 0) : undefined;
    }

    /**
     * Tags a request with this job and scopes its uniqueKey to the job, so that the same URL
     * requested by two different jobs is crawled for both instead of being deduplicated.
     */
    prepareRequest<T extends RequestOptions>(requestOptions: T): T {
        requestOptions.useExtendedUniqueKey = true;
        requestOptions.keepUrlFragment = this.input.keepUrlFragments;
        const uniqueKey =
            requestOptions.uniqueKey ??
            Request.computeUniqueKey({
                url: requestOptions.url,
                method: (requestOptions.method?.toUpperCase() ?? 'GET') as Request['method'],
                payload: requestOptions.payload,
                keepUrlFragment: requestOptions.keepUrlFragment,
                useExtendedUniqueKey: requestOptions.useExtendedUniqueKey,
            });
        requestOptions.uniqueKey = `${this.id}:${uniqueKey}`;
        requestOptions.userData = { ...requestOptions.userData, [JOB_KEY]: this.id };
        return requestOptions;
    }

    /**
     * Stand-in for the request queue exposed to the pageFunction via `context.enqueueRequest()`,
     * so user-enqueued requests belong to this job too.
     */
    readonly contextRequestQueue = {
        addRequest: async (requestOptions: RequestOptions, options?: Dictionary) => {
            if (this.remainingBudget() === 0) {
                log.warningOnce(`Job ${this.id}: maxPagesPerCrawl reached, ignoring enqueueRequest().`);
                return undefined;
            }
            const processed = await this.requestQueue.addRequest(this.prepareRequest(requestOptions), options);
            this.track([processed]);
            return processed;
        },
    };

    /** @param payload Output of `tools.createDatasetPayload()` - one pageFunction call may yield several items. */
    async pushResult(payload: Dictionary[]) {
        if (this.isFinished) return;
        const { maxResultsPerCrawl } = this.input;
        const items = maxResultsPerCrawl > 0 ? payload.slice(0, maxResultsPerCrawl - this.items.length) : payload;
        this.items.push(...items);
        if (this.dataset) await this.dataset.pushData(items);

        if (maxResultsPerCrawl > 0 && this.items.length >= maxResultsPerCrawl) {
            log.info(`Job ${this.id}: limit of ${maxResultsPerCrawl} results was reached.`);
            this.finish('maxResultsReached');
        }
    }

    toResult(): JobResult {
        return {
            jobId: this.id,
            status: this.status,
            durationMillis: Date.now() - this.startedAt,
            itemCount: this.items.length,
            items: this.items,
        };
    }
}

/**
 * Standby-mode engine. Instead of creating a crawler (and launching a browser) per run, it keeps
 * `keepAlive` crawlers running for the lifetime of the Actor run and feeds them requests from
 * incoming HTTP calls. Browsers, proxy sessions and cookies stay warm between calls.
 */
export class StandbyScraper {
    private readonly crawlers = new Map<string, Promise<CrawlerEntry>>();
    private readonly jobs = new Map<string, ScrapeJob>();
    /** In-memory queues: fast, and a request queue has no value beyond the lifetime of a run here. */
    private readonly queueConfig = new Configuration({ persistStorage: false });
    private readonly env: ApifyEnv = Actor.getEnv();

    /**
     * @param baseInput Input of the Standby run (Actor defaults), every HTTP request is applied on top of it.
     */
    constructor(private readonly baseInput: Dictionary) {}

    /** Creates the crawler for the base input up front, so the first HTTP call doesn't pay for it. */
    async warmUp() {
        await this.getCrawler(this.prepareInput({ startUrls: [] }));
    }

    async scrape(overrides: Dictionary): Promise<JobResult> {
        const input = this.prepareInput(overrides);
        if (!input.startUrls.length) throw new InputError('At least one start URL is required.');

        let job: ScrapeJob;
        try {
            job = new ScrapeJob(input);
        } catch (err) {
            throw new InputError((err as Error).message);
        }

        const { requestQueue } = await this.getCrawler(input);
        job.requestQueue = requestQueue;
        job.keyValueStore = await KeyValueStore.open(input.keyValueStoreName);
        if (input.saveToDataset) job.dataset = await Dataset.open(input.datasetName);

        this.jobs.set(job.id, job);
        const timeout = setTimeout(() => {
            log.warning(`Job ${job.id} timed out after ${job.timeoutMillis / 1000}s, returning partial results.`);
            job.finish('timedOut');
        }, job.timeoutMillis);

        try {
            await this.enqueueStartUrls(job);
            await job.done;
        } finally {
            clearTimeout(timeout);
            job.finish('aborted');
            // Requests of this job still in the queue are skipped without navigation from now on.
            this.jobs.delete(job.id);
        }

        log.info(`Job ${job.id} ${job.status}: ${job.items.length} items in ${Date.now() - job.startedAt}ms.`);
        return job.toResult();
    }

    async teardown() {
        for (const job of this.jobs.values()) job.finish('aborted');
        const entries = await Promise.allSettled(this.crawlers.values());
        await Promise.allSettled(
            entries.map(async (entry) => entry.status === 'fulfilled' && entry.value.crawler.teardown()),
        );
    }

    private prepareInput(overrides: Dictionary): StandbyInput {
        const input = structuredClone({ ...this.baseInput, ...overrides }) as StandbyInput;
        try {
            // Also fills in schema defaults.
            tools.checkInputOrThrow(input, SCHEMA);
            validateInput(input);
        } catch (err) {
            throw new InputError((err as Error).message);
        }
        applyFixedSettings(input);
        applyAutoProxyCountry(input);
        return input;
    }

    private async enqueueStartUrls(job: ScrapeJob) {
        const { maxResultsPerCrawl, keepUrlFragments } = job.input;
        const limits = [job.remainingBudget(), maxResultsPerCrawl > 0 ? 1.5 * maxResultsPerCrawl : undefined];
        const maxStartUrls = Math.min(...limits.filter((limit) => limit !== undefined));

        const startUrls = job.input.startUrls.map((req) => ({
            ...req,
            useExtendedUniqueKey: true,
            keepUrlFragment: keepUrlFragments,
        }));
        const requests: Request[] = [];
        // RequestList also resolves `requestsFromUrl` sources.
        for await (const request of await RequestList.open(null, startUrls)) {
            if (requests.length >= maxStartUrls) break;
            requests.push(job.prepareRequest(request as unknown as RequestOptions) as unknown as Request);
        }

        job.hold();
        try {
            // Forefront: a new job's entry pages go ahead of deep crawls of other jobs already in the queue.
            const { addedRequests } = await job.requestQueue.addRequestsBatched(requests, {
                waitForAllRequestsToBeAdded: true,
                forefront: true,
            });
            job.track(addedRequests);
        } finally {
            job.settle();
        }
    }

    private getActiveJob(request: Request) {
        const job = this.jobs.get(request.userData[JOB_KEY] as string);
        return job && !job.isFinished ? job : undefined;
    }

    private async getCrawler(input: StandbyInput) {
        const key = JSON.stringify(CRAWLER_LEVEL_KEYS.map((name) => input[name]));
        let entry = this.crawlers.get(key);
        if (!entry) {
            entry = this.createCrawler(input, key);
            this.crawlers.set(key, entry);
            entry.catch(() => this.crawlers.delete(key));
            if (this.crawlers.size > CRAWLER_COUNT_WARNING_THRESHOLD) {
                log.warning(
                    `${this.crawlers.size} crawlers are alive. Requests with different browser/proxy settings ` +
                        `(${CRAWLER_LEVEL_KEYS.join(', ')}) each get their own crawler and browsers.`,
                );
            }
        }
        return entry;
    }

    private async createCrawler(input: StandbyInput, key: string): Promise<CrawlerEntry> {
        const queueName = `standby-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
        const requestQueue = await StandbyRequestQueue.create(
            queueName,
            this.queueConfig,
            (request) => !this.getActiveJob(request),
        );

        const options: PuppeteerCrawlerOptions = {
            // Do not finish when the queue is empty, wait for the next HTTP request instead.
            keepAlive: true,
            requestQueue,
            requestHandler: this.requestHandler,
            failedRequestHandler: this.failedRequestHandler,
            requestHandlerTimeoutSecs: input.pageFunctionTimeoutSecs,
            preNavigationHooks: [this.preNavigationHook],
            postNavigationHooks: [this.postNavigationHook],
            respectRobotsTxtFile: input.respectRobotsTxtFile,
            maxConcurrency: input.maxConcurrency,
            maxRequestRetries: input.maxRequestRetries,
            proxyConfiguration: (await Actor.createProxyConfiguration(
                input.proxyConfiguration,
            )) as any as ProxyConfiguration,
            launchContext: {
                useChrome: input.useChrome,
                launchOptions: {
                    acceptInsecureCerts: input.ignoreSslErrors,
                    defaultViewport: DEFAULT_VIEWPORT,
                    args: input.ignoreCorsAndCsp ? ['--disable-web-security'] : [],
                    headless: input.headless,
                },
            },
            useSessionPool: true,
            persistCookiesPerSession: true,
            sessionPoolOptions: {
                persistStateKeyValueStoreId: input.sessionPoolName ? SESSION_STORE_NAME : undefined,
                persistStateKey: input.sessionPoolName,
                maxPoolSize: input.proxyRotation === ProxyRotation.UntilFailure ? 1 : undefined,
                sessionOptions: {
                    maxUsageCount: SESSION_MAX_USAGE_COUNTS[input.proxyRotation],
                },
            },
        };

        const crawler = new PuppeteerCrawler(options);
        // With keepAlive, run() only resolves after teardown.
        crawler
            .run()
            .catch((err) => log.exception(err as Error, 'Standby crawler crashed.'))
            .finally(() => this.crawlers.delete(key));

        log.info(`Started a new standby crawler (${queueName}).`);
        return { crawler, requestQueue };
    }

    private readonly preNavigationHook = async (
        crawlingContext: PuppeteerCrawlingContext,
        gotoOptions?: PuppeteerGoToOptions,
    ) => {
        const { request, page, session, blockRequests } = crawlingContext;
        const job = this.getActiveJob(request);
        if (!job) {
            // The job already finished (timeout / limit reached) - don't waste a navigation on it.
            request.skipNavigation = true;
            return;
        }
        const { input } = job;

        // Attach a console listener to get all logs from Browser context.
        if (input.browserLog) browserTools.dumpConsole(page);

        // Prevent download of stylesheets and media, unless selected otherwise
        if (job.blockedUrlPatterns.length) {
            await blockRequests({ urlPatterns: job.blockedUrlPatterns });
        }

        // Add initial cookies, if any.
        if (input.initialCookies?.length) {
            const cookiesToSet = session
                ? tools.getMissingCookiesFromSession(session, input.initialCookies, request.url)
                : input.initialCookies;

            if (cookiesToSet?.length) {
                // setting initial cookies that are not already in the session and page
                session?.setCookies(cookiesToSet, request.url);
                await page.setCookie(...cookiesToSet);
            }
        }

        // Disable content security policy.
        if (input.ignoreCorsAndCsp) await page.setBypassCSP(true);

        if (gotoOptions) {
            gotoOptions.timeout = input.pageLoadTimeoutSecs * 1000;
            gotoOptions.waitUntil = input.waitUntil;
        }

        for (const hook of job.fns.preNavigationHooks) {
            await hook(this.enhanceContext(crawlingContext, job), gotoOptions);
        }
    };

    private readonly postNavigationHook = async (crawlingContext: PuppeteerCrawlingContext) => {
        const job = this.getActiveJob(crawlingContext.request);
        if (!job) return;
        for (const hook of job.fns.postNavigationHooks) {
            await hook(this.enhanceContext(crawlingContext, job));
        }
    };

    private enhanceContext(crawlingContext: PuppeteerCrawlingContext, job: ScrapeJob) {
        return { ...crawlingContext, Apify: Actor, Actor, customData: job.input.customData };
    }

    private readonly failedRequestHandler = async ({ request }: PuppeteerCrawlingContext) => {
        const job = this.getActiveJob(request);
        if (!job) return;

        const lastError = request.errorMessages[request.errorMessages.length - 1];
        const errorMessage = lastError ? lastError.split('\n')[0] : 'no error';
        log.error(
            `Request ${request.url} failed and will not be retried anymore. Marking as failed.\nLast Error Message: ${errorMessage}`,
        );
        await job.pushResult(tools.createDatasetPayload(request, undefined, undefined, true) as Dictionary[]);
        job.settle();
    };

    private readonly requestHandler = async (crawlingContext: PuppeteerCrawlingContext) => {
        const { request, response } = crawlingContext;
        const job = this.getActiveJob(request);
        if (!job) return;
        const { input } = job;

        // Make sure that an object containing internal metadata is present on every request.
        tools.ensureMetaData(request);

        const pageFunctionArguments: Dictionary = {};
        // We must use properties and descriptors not to trigger getters / setters.
        Object.defineProperties(pageFunctionArguments, Object.getOwnPropertyDescriptors(crawlingContext));
        pageFunctionArguments.response = {
            status: response && response.status(),
            headers: response && response.headers(),
        };

        const crawlerSetup: CrawlerSetupOptions = {
            rawInput: job.rawInput,
            env: this.env,
            globalStore: job.globalStore,
            requestQueue: job.contextRequestQueue as unknown as CrawlerSetupOptions['requestQueue'],
            keyValueStore: job.keyValueStore,
            customData: input.customData,
        };
        const { context, state } = createContext({ crawlerSetup, pageFunctionArguments });

        if (input.closeCookieModals) {
            await sleep(500);
            await crawlingContext.page.evaluate(getInjectableScript());
            await sleep(2000);
        }

        if (input.maxScrollHeightPixels > 0) {
            await crawlingContext.infiniteScroll({ maxScrollHeight: input.maxScrollHeightPixels });
        }

        const pageFunctionResult = await job.fns.pageFunction(context);
        // The job may have timed out while the pageFunction was running.
        if (job.isFinished) return;

        // Enqueue links before settling this request, so the job can't be seen as complete in between.
        if (!state.skipLinks) await this.handleLinks(crawlingContext, job);

        await job.pushResult(
            tools.createDatasetPayload(request, response, pageFunctionResult as Dictionary) as Dictionary[],
        );
        job.settle();
    };

    private async handleLinks(
        { request, enqueueLinks, enqueueLinksByClickingElements }: PuppeteerCrawlingContext,
        job: ScrapeJob,
    ) {
        const { input } = job;
        const currentDepth = (request.userData[META_KEY] as RequestMetadata).depth;
        if (input.maxCrawlingDepth && currentDepth >= input.maxCrawlingDepth) {
            log.debug(`Request ${request.url} reached the maximum crawling depth of ${currentDepth}.`);
            return;
        }

        const enqueueOptions: EnqueueLinksOptions = {
            globs: input.globs,
            pseudoUrls: input.pseudoUrls,
            exclude: input.excludes,
            waitForAllRequestsToBeAdded: true,
            transformRequestFunction: (requestOptions) => {
                requestOptions.userData ??= {};
                requestOptions.userData[META_KEY] = {
                    parentRequestId: request.id || request.uniqueKey,
                    depth: currentDepth + 1,
                };
                return job.prepareRequest(requestOptions);
            },
        };

        if (input.linkSelector && job.remainingBudget() !== 0) {
            const { processedRequests } = await enqueueLinks({
                ...enqueueOptions,
                selector: input.linkSelector,
                limit: job.remainingBudget(),
            });
            job.track(processedRequests);
        }

        // Clicking has no `limit` option, so maxPagesPerCrawl may be slightly exceeded here.
        if (input.clickableElementsSelector && job.remainingBudget() !== 0) {
            const { processedRequests } = await enqueueLinksByClickingElements({
                ...enqueueOptions,
                selector: input.clickableElementsSelector,
            } as EnqueueLinksByClickingElementsOptions);
            job.track(processedRequests);
        }
    }
}
