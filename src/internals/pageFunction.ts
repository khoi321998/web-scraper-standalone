import type { Page } from 'puppeteer';

/**
 * Built-in default pageFunction (real TypeScript, type-checked and testable) used when the input
 * does not provide a `pageFunction` string. Runs in Node with the Puppeteer `page`; the DOM
 * traversal itself runs in the browser via `page.evaluate`.
 *
 * Generic content harvest: meta, JSON-LD (org/contact/product), contact-keyword script rows,
 * hidden inputs, visible text, links, images, mailto/tel, social iframes, title.
 */

/** Minimal shape of the context object the crawler passes to the pageFunction. */
interface PageFunctionContext {
    page: Page;
    request: { url: string };
    log: { info: (message: string) => void };
    [key: string]: unknown;
}

export interface HarvestItem {
    type: 'text' | 'jsonld' | 'link' | 'image' | 'iframe';
    tag: string;
    text?: string | null;
    href?: string | null;
    src?: string | null;
    alt?: string;
}

export interface HarvestResult {
    url: string;
    title: string;
    count: number;
    content: HarvestItem[];
}

export async function pageFunction(context: PageFunctionContext): Promise<HarvestResult> {
    const { page, request, log } = context;

    const data = await page.evaluate(() => {
        const content: HarvestItem[] = [];
        const MAX_ELEMENTS = 1000;
        const textTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'p', 'div', 'span', 'li', 'strong', 'em', 'section', 'article'];
        const seen = new Set<string>();
        const socialRegex = /(facebook|instagram|twitter|x\.com|linkedin|tiktok|youtube|pinterest|t\.me|vk\.com)/i;
        const ignoreMeta = /^(viewport|robots|charset|theme-color|apple|referrer)$/i;
        const keywordRegex = /(email|mail|address|company|organi[sz]ation|phone|mobile|vat|brand|contact)/i;

        // 1. META
        document.querySelectorAll('meta').forEach((el) => {
            const name = el.getAttribute('name') || el.getAttribute('property');
            const c = el.getAttribute('content');
            if (name && c && !ignoreMeta.test(name)) {
                content.push({ type: 'text', tag: `meta:${name}`, text: c });
            }
        });

        // 2. JSON-LD (Organization / ContactPoint / Product)
        document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
            const t = el.textContent || '';
            if (/(Organization|ContactPoint|Product)/i.test(t)) {
                content.push({ type: 'jsonld', tag: 'ld+json', text: t.slice(0, 2000) });
            }
        });

        // 3. SCRIPT rows containing contact keywords
        Array.from(document.querySelectorAll('script')).slice(0, 1000).forEach((el) => {
            const lines = (el.textContent || '').split('\n');
            if (lines.length > 100) return;
            for (const line of lines) {
                const s = line.trim();
                if (s.length > 0 && s.length <= 500 && !s.startsWith('{') && keywordRegex.test(s)) {
                    content.push({ type: 'text', tag: 'script:row', text: s });
                }
            }
        });

        // 4. HIDDEN INPUTS
        document.querySelectorAll('input[type="hidden"]').forEach((el) => {
            const input = el as HTMLInputElement;
            const name = input.name || input.getAttribute('id') || '';
            const v = (input.value || '').trim();
            if (v && v !== '✓' && /id|token|user|shop|contact|email|form/i.test(name)) {
                content.push({ type: 'text', tag: `input:hidden:${name}`, text: v });
            }
        });

        // 5. TEXT (direct text nodes only, deduped)
        let n = 0;
        for (const el of document.querySelectorAll(textTags.join(','))) {
            if (n >= MAX_ELEMENTS) break;
            const tag = el.tagName.toLowerCase();
            const direct = Array.from(el.childNodes)
                .filter((x) => x.nodeType === 3)
                .map((x) => (x.textContent || '').trim())
                .join(' ')
                .trim();
            const key = tag + direct;
            if (direct.length > 0 && !seen.has(key)) {
                seen.add(key);
                content.push({ type: 'text', tag, text: direct });
                n++;
            }
        }

        // 6. LINKS
        document.querySelectorAll('a[href]').forEach((el) => {
            const href = el.getAttribute('href') || '';
            const text = (el.textContent || '').trim() || null;
            if (!href.startsWith('#')) content.push({ type: 'link', tag: 'a', href, text });
        });

        // 7. IMAGES
        document.querySelectorAll('img[src]').forEach((el) => {
            content.push({ type: 'image', tag: 'img', src: el.getAttribute('src'), alt: el.getAttribute('alt') || '' });
        });

        // 8. MAILTO / TEL
        document.querySelectorAll('a[href^="mailto:"], a[href^="tel:"]').forEach((el) => {
            content.push({ type: 'link', tag: 'a', href: el.getAttribute('href'), text: (el.textContent || '').trim() || null });
        });

        // 9. SOCIAL IFRAMES
        document.querySelectorAll('iframe[src]').forEach((el) => {
            const src = el.getAttribute('src') || '';
            if (socialRegex.test(src)) content.push({ type: 'iframe', tag: 'iframe', src });
        });

        const title = (document.querySelector('title')?.textContent || '').trim();
        return { title, count: content.length, content };
    });

    log.info(`Extracted ${data.count} items from ${request.url}`);
    return { url: request.url, title: data.title, count: data.count, content: data.content };
}
