import type {
    GlobInput,
    ProxyConfigurationOptions,
    PseudoUrlInput,
    RegExpInput,
    RequestOptions,
    Session,
} from '@crawlee/puppeteer';
import type { Dictionary } from '@crawlee/utils';

/** `accept-language` header sent with every page navigation (actor and HTTP server). */
export const ACCEPT_LANGUAGE = 'uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7';

/**
 * Replicates the INPUT_SCHEMA with TypeScript types for quick reference
 * and IDE type check integration.
 */
export interface Input {
    startUrls: RequestOptions[];
    globs: GlobInput[];
    regexps: RegExpInput[];
    pseudoUrls: PseudoUrlInput[];
    excludes: GlobInput[];
    linkSelector?: string;
    clickableElementsSelector?: string;
    postNavigationHooks?: string;
    proxyConfiguration: ProxyConfigurationOptions;
    sessionPoolName?: string;
    initialCookies: Parameters<Session['setCookies']>[0];
    maxScrollHeightPixels: number;
    maxRequestRetries: number;
    maxPagesPerCrawl: number;
    maxResultsPerCrawl: number;
    maxCrawlingDepth: number;
    maxConcurrency: number;
    pageLoadTimeoutSecs: number;
    pageFunctionTimeoutSecs: number;
    customData: Dictionary;
    datasetName?: string;
    keyValueStoreName?: string;
    requestQueueName?: string;
}
