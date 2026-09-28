// RESEARCH-0 vendor definitions. Prices and endpoints come from each vendor's
// public documentation (sources in the PR). A vendor whose worst case cannot be
// bounded under the 1 USD cap carries `blockedReason` and is never called.

import { aisa } from './vendors/aisa.mjs';
import { firecrawl } from './vendors/firecrawl.mjs';
import { monid } from './vendors/monid.mjs';
import { socialcrawl } from './vendors/socialcrawl.mjs';
import { tavily } from './vendors/tavily.mjs';
import { tikhub } from './vendors/tikhub.mjs';
import { tinyfish } from './vendors/tinyfish.mjs';

export const VENDORS = [aisa, tinyfish, tikhub, socialcrawl, monid, tavily, firecrawl];
