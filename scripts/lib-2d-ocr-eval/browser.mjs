import { chromium } from 'playwright';
// CHROME_PATH lets you pin the exact browser build used in the report (Chrome for Testing 153.0.8010.12).
export const launch = (o = {}) =>
  chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), ...o });
