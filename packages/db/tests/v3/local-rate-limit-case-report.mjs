/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function peakMinute(events) {
  let first = 0, peak = 0;
  for (let last = 0; last < events.length; last++) {
    while (events[last].time - events[first].time >= 60000) first++;
    peak = Math.max(peak, last - first + 1);
  }
  return peak;
}

export function summarizeRateLimitCases(boundaries, events) {
  const requests = events.filter((event) => event.event === "request").sort((a, b) => a.time - b.time);
  const responses = new Map(events.filter((event) => event.event === "response").map((event) => [event.id, event]));
  return boundaries.filter((event) => event.event === "begin").map((begin) => {
    const end = boundaries.find((event) => event.event === "end" && event.id === begin.id && event.time >= begin.time);
    const own = requests.filter((event) => event.time >= begin.time && event.time <= (end?.time ?? Infinity));
    const paths = {};
    for (const request of own) {
      const entry = paths[request.path] ??= { requests: 0, limited: 0, http503: 0 };
      entry.requests++;
      const response = responses.get(request.id);
      if (response?.status === 429) entry.limited++;
      if (response?.status === 503) entry.http503++;
    }
    return { name: begin.name, completed: Boolean(end), requests: own.length, peakMinute: peakMinute(own),
      priorMinute: requests.filter((event) => event.time < begin.time && event.time >= begin.time - 60000).length,
      limited: own.filter((event) => responses.get(event.id)?.status === 429).length,
      http503: own.filter((event) => responses.get(event.id)?.status === 503).length, paths };
  });
}

export function writeRateLimitCaseReport(directory) {
  const read = (name) => {
    const path = resolve(directory, name);
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  };
  const report = summarizeRateLimitCases(read("rate-limit-cases.jsonl"), read("rate-limit-requests.jsonl"));
  writeFileSync(resolve(directory, "rate-limit-case-summary.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  for (const { paths, ...summary } of report) console.log("LOCAL_RATE_LIMIT_CASE " + JSON.stringify(summary));
  return report;
}
