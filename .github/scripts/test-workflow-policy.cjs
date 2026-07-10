const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const checker = path.join(__dirname, 'check-workflow-policy.cjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'graylum-workflow-policy-'));
const safeSha = '0123456789abcdef0123456789abcdef01234567';

function runCase(name, workflow, expectedStatus) {
  const directory = path.join(tempRoot, name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'workflow.yml'), workflow);
  const result = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, `${name}: ${result.stderr || result.stdout}`);
}

runCase('safe', `name: Safe\non:\n  push:\n    branches: [staging]\npermissions:\n  contents: read\njobs:\n  test:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${safeSha}\n        with:\n          persist-credentials: false\n`, 0);
runCase('write-all', 'permissions: write-all\n', 1);
runCase('floating-action', 'jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v5\n', 1);
runCase('pr-secret', 'on:\n  pull_request:\njobs:\n  test:\n    env:\n      KEY: ${{ secrets.PRODUCTION_KEY }}\n', 1);
runCase('pr-target-head', 'on:\n  pull_request_target:\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@${{ github.event.pull_request.head.sha }}\n', 1);

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log('Workflow policy unit tests passed.');
