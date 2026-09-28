import type { PuppeteerCrawlingContext, PuppeteerGoToOptions } from '@crawlee/puppeteer';
import type { Dictionary } from '@crawlee/utils';

/**
 * Navigation hooks (real TypeScript, type-checked) compiled into this actor. They are not configurable
 * through the input and run in both batch and Standby mode.
 */

/** Crawling context passed to the hooks, enhanced with the job's `customData`. */
export type HookContext = PuppeteerCrawlingContext & { customData: Dictionary };

export type PreNavigationHook = (context: HookContext, gotoOptions?: PuppeteerGoToOptions) => Promise<void>;
export type PostNavigationHook = (context: HookContext) => Promise<void>;

/**
 * Run before navigation. Good for setting cookies, headers or browser properties, and for
 * adjusting `gotoOptions` (passed to `page.goto()`).
 */
export const preNavigationHooks: PreNavigationHook[] = [
    // Prefer Ukrainian content (moved from the former `preNavigationHooks` input).
    async ({ page }) => {
        await page.setExtraHTTPHeaders({ 'accept-language': 'uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7' });
    },
];

/**
 * Run after navigation. Good for checking whether the navigation succeeded.
 *
 * @example
 * async ({ response, request }) => {
 *     if (response?.status() === 403) throw new Error(`Blocked on ${request.url}`);
 * },
 */
export const postNavigationHooks: PostNavigationHook[] = [];
