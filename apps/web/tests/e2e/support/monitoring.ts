/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { writeFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';

export type AuditedRole = 'public' | 'user' | 'admin';
export type IssueSeverity = 'P0' | 'P1' | 'P2';
export type IssueSource = 'console' | 'pageerror' | 'requestfailed' | 'response' | 'assertion';

export interface FlowIssue {
  severity: IssueSeverity;
  source: IssueSource;
  message: string;
  url?: string;
  method?: string;
  status?: number;
  resourceType?: string;
}

export interface FlowAuditMeta {
  title: string;
  role: AuditedRole;
  route: string;
  expected: string;
}

interface FlowAuditReport extends FlowAuditMeta {
  actual: string;
  steps: string[];
  issues: FlowIssue[];
  recommendations: string[];
}

const relevantResourceTypes = new Set(['document', 'xhr', 'fetch']);
const severityRank: Record<IssueSeverity, number> = { P0: 0, P1: 1, P2: 2 };

function shouldTrackUrl(url: string) {
  return !url.includes('/_next/') && !url.includes('/favicon.ico');
}

function classifyResponseSeverity(status: number): IssueSeverity {
  if (status >= 500) return 'P0';
  return 'P1';
}

function classifyConsoleSeverity(type: string): IssueSeverity {
  return type === 'error' ? 'P1' : 'P2';
}

function shouldIgnoreConsoleMessage(text: string) {
  // App Router navigation can abort Supabase's in-flight getUser() probe while the page
  // is being replaced, which surfaces as a noisy but non-user-visible fetch error.
  return (
    text.includes('TypeError: Failed to fetch') &&
    text.includes('SupabaseAuthClient._getUser') &&
    text.includes('supabase_auth-js_dist_module')
  )
    // Remote Vercel previews can emit a generic console error after an internal
    // OPTIONS handshake to the preview root is rejected with an empty 400.
    || text === 'Failed to load resource: the server responded with a status of 400 ()';
}

function shouldIgnoreRequestFailure(url: string, method: string, message: string) {
  if (url.includes('/.well-known/vercel/jwe') || url.includes('/.well-known/vercel-user-meta')) {
    return true;
  }

  if (url.includes('vercel.live/login/validate')) {
    return true;
  }

  if (url.includes('vercel.live/_next-live/feedback/feedback.html') && message === 'net::ERR_ABORTED') {
    return true;
  }

  // Remote Vercel previews can emit aborted HEAD/OPTIONS fetches during deployment protection handshakes.
  if (message === 'net::ERR_ABORTED' && ['HEAD', 'OPTIONS'].includes(method)) {
    return true;
  }

  // Navigations and reloads in the App Router can abort in-flight RSC or GET tRPC fetches.
  if (
    message === 'net::ERR_ABORTED' &&
    method === 'GET' &&
    (url.includes('_rsc=') || url.includes('/api/trpc/'))
  ) {
    return true;
  }

  // Supabase auth may cancel the background getUser() fetch when the browser navigates away.
  if (message === 'net::ERR_ABORTED' && method === 'GET' && url.includes('/auth/v1/user')) {
    return true;
  }

  return false;
}

function shouldIgnoreResponseIssue(url: string, method: string, status: number, statusText: string) {
  if (
    method === 'OPTIONS'
    && status === 400
    && statusText.trim() === ''
  ) {
    try {
      const parsed = new URL(url);
      if (parsed.pathname === '/') {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

function renderMarkdown(report: FlowAuditReport) {
  const lines = [
    `# ${report.title}`,
    '',
    `- route: \`${report.route}\``,
    `- role: \`${report.role}\``,
    `- expected: ${report.expected}`,
    `- actual: ${report.actual}`,
    '',
    '## Steps',
    ...report.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## Issues',
  ];

  if (report.issues.length === 0) {
    lines.push('- none');
  } else {
    for (const issue of report.issues) {
      const extra = [
        issue.url ? `url=${issue.url}` : '',
        issue.method ? `method=${issue.method}` : '',
        issue.status ? `status=${issue.status}` : '',
        issue.resourceType ? `resourceType=${issue.resourceType}` : '',
      ]
        .filter(Boolean)
        .join(', ');

      lines.push(`- [${issue.severity}] ${issue.source}: ${issue.message}${extra ? ` (${extra})` : ''}`);
    }
  }

  lines.push('', '## Recommendations');
  if (report.recommendations.length === 0) {
    lines.push('- none');
  } else {
    lines.push(...report.recommendations.map((item) => `- ${item}`));
  }

  return lines.join('\n');
}

function buildRecommendations(issues: FlowIssue[]) {
  const recommendations = new Set<string>();

  for (const issue of issues) {
    switch (issue.source) {
      case 'pageerror':
        recommendations.add('Inspect the failing page component and associated client hooks for uncaught runtime exceptions.');
        break;
      case 'requestfailed':
      case 'response':
        recommendations.add('Inspect the failing network request, auth state, and API handler for missing env, permissions, or server errors.');
        break;
      case 'console':
        recommendations.add('Review browser console output and remove runtime warnings or unexpected client errors before broadening coverage.');
        break;
      case 'assertion':
        recommendations.add('Reproduce the failing business flow manually in local dev tools and tighten the affected UI or data-loading logic.');
        break;
    }
  }

  return Array.from(recommendations);
}

export function createIssueMonitor(page: Page) {
  const issues: FlowIssue[] = [];

  page.on('console', (message) => {
    const type = message.type();
    if (!['error', 'warning'].includes(type)) return;

    const text = message.text().trim();
    if (!text || text.includes('favicon.ico') || shouldIgnoreConsoleMessage(text)) return;

    issues.push({
      severity: classifyConsoleSeverity(type),
      source: 'console',
      message: text,
    });
  });

  page.on('pageerror', (error) => {
    issues.push({
      severity: 'P0',
      source: 'pageerror',
      message: error.message,
    });
  });

  page.on('requestfailed', (request) => {
    const resourceType = request.resourceType();
    if (!relevantResourceTypes.has(resourceType) || !shouldTrackUrl(request.url())) return;
    const message = request.failure()?.errorText ?? 'Request failed';
    if (shouldIgnoreRequestFailure(request.url(), request.method(), message)) return;

    issues.push({
      severity: 'P1',
      source: 'requestfailed',
      message,
      method: request.method(),
      resourceType,
      url: request.url(),
    });
  });

  page.on('response', (response) => {
    const request = response.request();
    const resourceType = request.resourceType();
    if (!relevantResourceTypes.has(resourceType) || !shouldTrackUrl(response.url()) || response.status() < 400) {
      return;
    }

    if (shouldIgnoreResponseIssue(response.url(), request.method(), response.status(), response.statusText())) {
      return;
    }

    issues.push({
      severity: classifyResponseSeverity(response.status()),
      source: 'response',
      message: `${response.status()} ${response.statusText()}`,
      method: request.method(),
      resourceType,
      status: response.status(),
      url: response.url(),
    });
  });

  return {
    getIssues(minSeverity?: IssueSeverity) {
      if (!minSeverity) return [...issues];
      return issues.filter((issue) => severityRank[issue.severity] <= severityRank[minSeverity]);
    },
    removeIssues(predicate: (issue: FlowIssue) => boolean) {
      for (let index = issues.length - 1; index >= 0; index -= 1) {
        if (predicate(issues[index])) {
          issues.splice(index, 1);
        }
      }
    },
    addAssertionIssue(message: string, severity: IssueSeverity = 'P1') {
      issues.push({
        severity,
        source: 'assertion',
        message,
      });
    },
  };
}

export async function writeFlowAudit(
  testInfo: TestInfo,
  meta: FlowAuditMeta,
  actual: string,
  steps: string[],
  issues: FlowIssue[],
  extraRecommendations: string[] = [],
) {
  const recommendations = Array.from(new Set([...buildRecommendations(issues), ...extraRecommendations]));
  const report: FlowAuditReport = {
    ...meta,
    actual,
    steps,
    issues,
    recommendations,
  };

  const jsonPath = testInfo.outputPath('issue-report.json');
  const markdownPath = testInfo.outputPath('issue-report.md');

  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(markdownPath, renderMarkdown(report));

  await testInfo.attach('issue-report', {
    path: jsonPath,
    contentType: 'application/json',
  });
  await testInfo.attach('issue-report-md', {
    path: markdownPath,
    contentType: 'text/markdown',
  });
}
