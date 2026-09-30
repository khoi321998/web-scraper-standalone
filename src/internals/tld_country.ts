/**
 * Proxy-country hint: read the country-code TLD (ccTLD) from a URL, e.g.
 * `md-fashion.ua` -> "UA", `x.com.ua` -> "UA". Free and deterministic — no network calls.
 *
 * This only extracts the raw 2-letter ccTLD; it does NOT decide whether to act on it. The caller
 * gates the result through an allowlist (see `AUTO_PROXY_COUNTRIES` in proxy.ts) so only
 * countries whose residential pool we trust get targeted — everything else falls back to random
 * rotation. That keeps this helper tiny: no vanity-TLD or ISO-mismatch (.uk->GB) special-casing
 * is needed while the allowlist is small; add such handling only when those countries are enabled.
 *
 * Returns null for generic TLDs (.com, .io, .app, ...) — i.e. no country hint.
 */
export function countryFromUrl(url: string): string | null {
    let host: string;
    try {
        host = new URL(url).hostname;
    } catch {
        return null;
    }
    if (!host || /^[\d.]+$/.test(host)) return null; // empty or raw IPv4

    const tld = host.toLowerCase().split('.').pop() ?? '';
    return tld.length === 2 ? tld.toUpperCase() : null; // 2-letter = ccTLD; gTLD -> no hint
}
