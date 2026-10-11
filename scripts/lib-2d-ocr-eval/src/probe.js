// Tries every network path a compromised parser could use; reports which were blocked.
export async function probeNetwork(base) {
  const out = {};
  const t = (p, ms = 3000) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
  try {
    await t(fetch(base + '/leak?via=fetch', { mode: 'no-cors' }));
    out.fetch = 'SENT';
  } catch (e) {
    out.fetch = 'blocked: ' + e.message;
  }
  try {
    await t(
      new Promise((res, rej) => {
        const x = new XMLHttpRequest();
        x.onload = res;
        x.onerror = () => rej(new Error('xhr error'));
        x.open('GET', base + '/leak?via=xhr');
        x.send();
      }),
    );
    out.xhr = 'SENT';
  } catch (e) {
    out.xhr = 'blocked: ' + e.message;
  }
  try {
    importScripts(base + '/leak?via=importScripts');
    out.importScripts = 'SENT';
  } catch (e) {
    out.importScripts = 'blocked: ' + e.name;
  }
  try {
    await t(
      new Promise((res, rej) => {
        const w = new WebSocket(base.replace('http', 'ws') + '/leak?via=ws');
        w.onopen = res;
        w.onerror = () => rej(new Error('ws error'));
      }),
    );
    out.websocket = 'SENT';
  } catch (e) {
    out.websocket = 'blocked: ' + e.message;
  }
  try {
    const ok = navigator.sendBeacon ? navigator.sendBeacon(base + '/leak?via=beacon', 'x') : 'n/a';
    out.beacon = ok === true ? 'queued' : String(ok);
  } catch (e) {
    out.beacon = 'blocked: ' + e.name;
  }
  try {
    await t(import(base + '/leak?via=dynamic-import'));
    out.dynamicImport = 'SENT';
  } catch (e) {
    out.dynamicImport = 'blocked: ' + (e.message || e.name).slice(0, 80);
  }
  try {
    new Function('return 1')();
    out.newFunction = 'ALLOWED';
  } catch (e) {
    out.newFunction = 'blocked: ' + e.name;
  }
  return out;
}
