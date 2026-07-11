#!/usr/bin/env ruby

require 'fileutils'
require 'open3'
require 'tmpdir'

checker = File.expand_path('check-workflow-policy.rb', __dir__)
safe_sha = '0123456789abcdef0123456789abcdef01234567'

def workflow(body, safe_sha)
  <<~YAML
    name: Policy fixture
    on:
      push:
        branches: [staging]
    permissions:
      contents: read
    jobs:
      test:
        runs-on: ubuntu-latest
        timeout-minutes: 5
        permissions:
          contents: read
        steps:
          - uses: actions/checkout@#{safe_sha}
            with:
              persist-credentials: false
          - run: echo safe
    #{body}
  YAML
end

cases = {
  'safe' => [workflow('', safe_sha), true, nil],
  'write-all' => [workflow("permissions: write-all\n", safe_sha), false, 'write-all'],
  'pr-top-write' => [workflow("on: [pull_request]\npermissions:\n  contents: write\n", safe_sha), false, 'must not have write permissions'],
  'pr-job-write' => [workflow("on: [pull_request]\njobs:\n  unsafe:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    permissions:\n      issues: write\n    steps:\n      - run: echo unsafe\n", safe_sha), false, 'job unsafe must not have write permissions'],
  'missing-top-permissions' => ["name: x\non: [push]\njobs:\n  x:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: echo x\n", false, 'top-level permissions must be declared'],
  'missing-timeout' => [workflow("jobs:\n  x:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:\n      - run: echo x\n", safe_sha), false, 'must declare timeout-minutes'],
  'missing-persist-credentials' => [workflow("jobs:\n  x:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout@#{safe_sha}\n", safe_sha), false, 'must set persist-credentials: false'],
  'persist-credentials-true' => [workflow("jobs:\n  x:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout@#{safe_sha}\n        with:\n          persist-credentials: true\n", safe_sha), false, 'must set persist-credentials: false'],
  'pull-request-target' => [workflow("on: [pull_request_target]\n", safe_sha), false, 'pull_request_target is forbidden'],
  'floating-step-action' => [workflow("jobs:\n  x:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout@v5\n", safe_sha), false, 'action is not pinned'],
  'floating-job-action' => [workflow("jobs:\n  x:\n    uses: owner/repo/.github/workflows/reuse.yml@main\n    timeout-minutes: 5\n", safe_sha), false, 'reusable workflow is not pinned'],
  'docker-tag' => [workflow("jobs:\n  x:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - uses: docker://alpine:3.20\n", safe_sha), false, 'action is not pinned'],
  'pr-secret' => [workflow("on: [pull_request]\njobs:\n  x:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    env:\n      KEY: ${{ secrets.TEST_KEY }}\n    steps:\n      - run: echo x\n", safe_sha), false, 'must not reference secrets'],
  'pr-production-secret' => [workflow("on: [pull_request]\njobs:\n  x:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    env:\n      KEY: ${{ secrets.STRIPE_LIVE_KEY }}\n    steps:\n      - run: echo x\n", safe_sha), false, 'privileged secret name'],
  'danger-full-access' => [workflow("jobs:\n  x:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: codex --danger-full-access\n", safe_sha), false, 'unsafe runner flag'],
  'yolo' => [workflow("jobs:\n  x:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: agent --yolo\n", safe_sha), false, 'unsafe runner flag'],
  'auto-merge' => [workflow("jobs:\n  x:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: gh pr merge 1\n", safe_sha), false, 'auto-merge commands are forbidden'],
  'malformed-yaml' => ["name: [broken\n", false, 'invalid YAML'],
}

Dir.mktmpdir('graylum-workflow-policy-') do |root|
  cases.each do |name, (content, should_pass, expected_error)|
    directory = File.join(root, name)
    FileUtils.mkdir_p(directory)
    File.write(File.join(directory, 'workflow.yml'), content)
    _stdout, stderr, status = Open3.capture3('ruby', checker, directory)
    actual = status.success?
    next if actual == should_pass && (expected_error.nil? || stderr.include?(expected_error))

    warn "#{name}: expected pass=#{should_pass} and error=#{expected_error.inspect}, got pass=#{actual}: #{stderr}"
    exit 1
  end
end

puts "Workflow policy regression tests passed (#{cases.length} cases, #{cases.length - 1} bypass attempts)."
