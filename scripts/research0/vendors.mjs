// RESEARCH-0 vendor definitions. Prices and endpoints come from each vendor's
// public documentation (sources in the PR). Endpoints whose worst-case price
// cannot be bounded under the 1 USD cap are not defined at all.

import { socialcrawl } from './vendors/socialcrawl.mjs';
import { tinyfish } from './vendors/tinyfish.mjs';

export const VENDORS = [tinyfish, socialcrawl];
