/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const permissions = read('./staging-test-permissions.json').objects;
const expected = read('./expected-differences.json');
const group = key => /^(col|colacl|con|idx|trg|pol):/.test(key) ? key.split('.')[0] : key;
const digest = value => createHash('md5').update(value ?? '<null>').digest('hex').slice(0, 12);
const record = value => value && typeof value === 'object' && !Array.isArray(value);

/** Full definitions, not hashes/group names: partial legacy snapshots must be recaptured. */
export function snapshotObjects(snapshot) {
  if (snapshot?.format !== 'graylum-structure-v2' || snapshot.searchPath !== 'public'
    || !record(snapshot.objects) || !Object.keys(snapshot.objects).length
    || snapshot.objectCount !== Object.keys(snapshot.objects).length
    || Object.values(snapshot.objects).some(value => value !== null && typeof value !== 'string')) {
    throw new Error('Incomplete structure snapshot: capture v2 full definitions with search_path=public');
  }
  return snapshot.objects;
}

/** Ordinary comparisons do not accept test permissions. Only the explicit staging entry points opt in. */
export function compareStructure(local, snapshot, { stagingTestPermissions = false, hashed = false } = {}) {
  const remote = snapshotObjects(snapshot);
  if (!record(local) || !Object.keys(local).length
    || Object.values(local).some(value => hashed ? !/^[a-f0-9]{12}$/.test(value) : value !== null && typeof value !== 'string')) {
    throw new Error('Invalid local structure fingerprint');
  }
  const unexpected = [];
  const verifiedTestPermissions = [];
  const seen = Object.fromEntries(Object.keys(expected).filter(key => key !== '_about').map(key => [key, new Set()]));
  const accepted = (category, key) => {
    const match = expected[category].keys.find(item => item === key || item === group(key));
    if (match === undefined) return false;
    seen[category].add(match);
    return true;
  };
  // A missing grant/policy is an error too, even when its entire group has disappeared.
  if (stagingTestPermissions) {
    for (const [key, definition] of Object.entries(permissions)) {
      if (Object.hasOwn(local, key)) unexpected.push(`test permission must not be in repository build: ${key}`);
      if (remote[key] !== definition) unexpected.push(`missing or changed staging test permission: ${key}`);
      else verifiedTestPermissions.push(key);
    }
  }
  const differingGroups = new Set();
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const inLocal = Object.hasOwn(local, key);
    const inRemote = Object.hasOwn(remote, key);
    if (inLocal && inRemote && local[key] === (hashed ? digest(remote[key]) : remote[key])) continue;
    differingGroups.add(group(key));
    if (!inLocal) {
      if (stagingTestPermissions && Object.hasOwn(permissions, key) && remote[key] === permissions[key]) continue;
      if (!accepted('platformOnlyOnStaging', key)) unexpected.push(`only on staging: ${key}`);
    } else if (!inRemote) {
      if (!accepted('pendingOnStaging', key) && !accepted('stricterInFiles', key)) unexpected.push(`only in files: ${key}`);
    } else {
      unexpected.push(`differs: ${key}`);
    }
  }
  for (const [category, keys] of Object.entries(seen)) {
    for (const key of expected[category].keys) {
      if (!keys.has(key)) unexpected.push(`expected difference no longer occurs (${category}): ${key}`);
    }
  }
  return { differingGroups: differingGroups.size, verifiedTestPermissions, unexpected };
}
