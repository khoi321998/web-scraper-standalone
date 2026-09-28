import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

import { log } from '@crawlee/puppeteer';
import type { Awaitable } from '@crawlee/utils';

import { tools } from '@apify/scraper-tools';

import type { Input } from './consts.js';
import { FIXED_SETTINGS } from './consts.js';
import {
    postNavigationHooks as builtinPostNavigationHooks,
    preNavigationHooks as builtinPreNavigationHooks,
} from './navigationHooks.js';
import { pageFunction as builtinPageFunction } from './pageFunction.js';
import { countryFromUrls } from './tld_country.js';

export const SCHEMA = JSON.parse(await readFile(new URL('../../INPUT_SCHEMA.json', import.meta.url), 'utf8'));

/** Only auto-target countries we know the proxy pool covers well; anything else uses random rotation. */
const AUTO_PROXY_COUNTRIES = new Set(['UA']);

const MEDIA_URL_PATTERNS = ['.jpg', '.jpeg', '.png', '.svg', '.gif', '.webp', '.webm', '.ico', '.woff', '.eot'];

export type UserHook = (...args: unknown[]) => Awaitable<void>;

export interface EvaledUserFunctions {
    pageFunction: (...args: unknown[]) => unknown;
    preNavigationHooks: UserHook[];
    postNavigationHooks: UserHook[];
}

/**
 * Structural validations that the JSON schema cannot express. Throws on invalid input.
 */
export function validateInput(input: Input) {
    input.pseudoUrls.forEach((purl) => {
        if (!tools.isPlainObject(purl)) {
            throw new Error('The pseudoUrls Array must only contain Objects.');
        }
        if (purl.userData && !tools.isPlainObject(purl.userData)) {
            throw new Error('The userData property of a pseudoUrl must be an Object.');
        }
    });

    input.initialCookies?.forEach((cookie) => {
        if (!tools.isPlainObject(cookie)) {
            throw new Error('The initialCookies Array must only contain Objects.');
        }
    });

    input.waitUntil.forEach((event) => {
        if (!/^(domcontentloaded|load|networkidle2|networkidle0)$/.test(event)) {
            throw new Error('Navigation wait until events must be valid. See tooltip.');
        }
    });
}

/**
 * Overwrites the settings that are fixed in code (see `FIXED_SETTINGS`). MODIFIES `input`.
 */
export function applyFixedSettings(input: Input) {
    for (const [key, value] of Object.entries(FIXED_SETTINGS) as [keyof typeof FIXED_SETTINGS, unknown][]) {
        if (key in input && JSON.stringify(input[key]) !== JSON.stringify(value)) {
            log.warningOnce(`Input field "${key}" is fixed by the Actor and will be ignored.`);
        }
    }
    // Cloned: applyAutoProxyCountry() may modify the proxy configuration.
    Object.assign(input, structuredClone(FIXED_SETTINGS));
}

/**
 * Tier-1 proxy geo-targeting: if using Apify proxy without an explicit country, derive
 * one from the start URLs' ccTLD (e.g. *.ua -> UA). MODIFIES `input.proxyConfiguration`.
 */
export function applyAutoProxyCountry(input: Input) {
    const proxy = input.proxyConfiguration as { useApifyProxy?: boolean; apifyProxyCountry?: string };
    if (!proxy?.useApifyProxy || proxy.apifyProxyCountry) return;

    const country = countryFromUrls(input.startUrls.map((req) => req.url).filter(Boolean) as string[]);
    if (country && AUTO_PROXY_COUNTRIES.has(country)) {
        proxy.apifyProxyCountry = country;
        log.info(`Auto-selected proxy country "${country}" from start URL ccTLD.`);
    } else if (country) {
        log.info(`ccTLD country "${country}" not in auto-target allowlist; using random proxy rotation.`);
    }
}

/**
 * Hybrid: if the input provides a pageFunction string, eval it (lets you override without
 * rebuilding); otherwise use the built-in real TS pageFunction compiled into this actor.
 * Navigation hooks always come from navigationHooks.ts.
 */
export function evalUserFunctions(input: Input): EvaledUserFunctions {
    const pageFunctionSource = input.pageFunction?.trim();
    return {
        pageFunction: pageFunctionSource
            ? tools.evalFunctionOrThrow(pageFunctionSource)
            : (builtinPageFunction as (...args: unknown[]) => unknown),
        preNavigationHooks: builtinPreNavigationHooks as UserHook[],
        postNavigationHooks: builtinPostNavigationHooks as UserHook[],
    };
}

/** URL patterns of resources that should not be downloaded (media / CSS), based on input. */
export function getBlockedUrlPatterns(input: Input) {
    const patterns = input.downloadMedia ? [] : [...MEDIA_URL_PATTERNS];
    if (!input.downloadCss) patterns.push('.css');
    return patterns;
}
