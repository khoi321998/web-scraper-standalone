import { setTimeout } from 'node:timers/promises';

import { Actor } from 'apify';

import { runActor } from '@apify/scraper-tools';

import { CrawlerSetup } from './internals/crawler_setup.js';
import { runStandby } from './internals/standby_server.js';

if (Actor.config.get('metaOrigin') === 'STANDBY') {
    await runStandby();
} else {
    Actor.on('aborting', async () => {
        // Give Crawlee/SDK state persistence a moment to finish before exiting.
        await setTimeout(1000);
        await Actor.exit();
    });
    runActor(CrawlerSetup);
}
