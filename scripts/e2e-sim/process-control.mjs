/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// All owned children are started as detached process groups. Wait for exit before releasing their database.
export async function stopProcessGroup(child, graceMs = 10_000) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group has already gone */ }
    return;
  }
  const exited = new Promise(resolve => child.once('exit', () => resolve(true)));
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  let timer;
  const stopped = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(false), graceMs); })]);
  clearTimeout(timer);
  if (!stopped) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    await exited;
  } else {
    // The group leader may exit before a child that ignored SIGTERM.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group has already gone */ }
  }
}
