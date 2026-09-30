import { ProxyConfiguration } from '@crawlee/puppeteer';
import { Actor } from 'apify';

import { countryFromUrl } from './tld_country.js';

/**
 * Countries whose Apify residential pool we trust enough to auto-target from the URL's ccTLD
 * (e.g. *.ua -> UA). URLs from any other country, or with a generic TLD, use random rotation.
 */
export const AUTO_PROXY_COUNTRIES = ['UA'];

/**
 * Apify Proxy (needs APIFY_PROXY_PASSWORD) that picks the proxy country per request:
 * allowlisted ccTLDs get a proxy from that country, everything else gets a random one.
 */
export async function createApifyProxyConfiguration(groups?: string[]): Promise<ProxyConfiguration> {
    const create = async (countryCode?: string) => {
        const config = await Actor.createProxyConfiguration({ useApifyProxy: true, groups, countryCode });
        if (!config) throw new Error('Failed to create Apify proxy configuration. Is APIFY_PROXY_PASSWORD set?');
        return config;
    };

    const fallback = await create();
    const byCountry = new Map<string, typeof fallback>();
    for (const country of AUTO_PROXY_COUNTRIES) byCountry.set(country, await create(country));

    return new ProxyConfiguration({
        async newUrlFunction(sessionId, options) {
            const country = options?.request ? countryFromUrl(options.request.url) : null;
            const config = (country && byCountry.get(country)) || fallback;
            return (await config.newUrl(sessionId)) ?? null;
        },
    });
}
