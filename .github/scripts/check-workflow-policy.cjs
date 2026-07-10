const fs = require('node:fs');
const path = require('node:path');

const workflowDir = process.argv[2] || '.github/workflows';
const policyFailures = [];

function fail(file, message) {
  policyFailures.push(`${file}: ${message}`);
}

function workflowFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

function checkWorkflow(file, source) {
  if (/^\s*permissions:\s*write-all\s*$/m.test(source)) {
    fail(file, 'permissions: write-all is forbidden');
  }
  if (/persist-credentials:\s*true\b/.test(source)) {
    fail(file, 'persist-credentials: true is forbidden');
  }
  if (/danger-full-access|--yolo/.test(source)) {
    fail(file, 'unsafe runner flags are forbidden');
  }

  const isPullRequestWorkflow = /^\s*pull_request(?:\s*:|$)/m.test(source);
  const isPullRequestTargetWorkflow = /^\s*pull_request_target(?:\s*:|$)/m.test(source);
  if (isPullRequestWorkflow && /\$\{\{\s*secrets\./.test(source)) {
    fail(file, 'pull_request workflows must not reference secrets');
  }
  if (isPullRequestWorkflow && /\$\{\{\s*secrets\.[^}]*?(PROD|PRODUCTION|LIVE|SERVICE_ROLE)/i.test(source)) {
    fail(file, 'production or privileged secret name found in pull_request workflow');
  }
  if (isPullRequestTargetWorkflow && /github\.event\.pull_request\.head\.(sha|ref)/.test(source)) {
    fail(file, 'pull_request_target must not check out PR head');
  }

  const uses = source.matchAll(/^\s*-\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm);
  for (const match of uses) {
    const reference = match[1];
    if (reference.startsWith('./') || reference.startsWith('docker://')) continue;
    if (!/^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/i.test(reference)) {
      fail(file, `action is not pinned to a full immutable SHA: ${reference}`);
    }
  }
}

for (const file of workflowFiles(workflowDir)) {
  checkWorkflow(file, fs.readFileSync(file, 'utf8'));
}

if (policyFailures.length > 0) {
  console.error('Workflow policy check failed:');
  for (const failure of policyFailures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Workflow policy check passed for ${workflowFiles(workflowDir).length} workflow files.`);
