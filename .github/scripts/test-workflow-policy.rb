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

def workflow_yaml(safe_sha, events: ['pull_request', 'push'], permissions: { 'contents' => 'read' }, jobs: nil)
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
case_category_order = %i[
  structural_yaml_cases
  malformed_job_structure_cases
  malformed_step_structure_cases
  reusable_workflow_forbidden_cases
  permissions_cases
  secret_reference_cases
  action_pinning_cases
  runner_cases
  local_action_cases
  container_service_cases
  timeout_continue_on_error_cases
  wrapped_github_expression_cases
  implicit_if_expression_cases
  manifest_integrity_cases
  required_trigger_coverage_cases
  privileged_environment_cases
].freeze
case_categories = case_category_order.to_h { |category| [category, []] }
current_category = :manifest_integrity_cases
add_case = lambda do |name, content, should_pass, expected_error = nil, forbidden_error = nil|
  cases[name] = [content, should_pass, expected_error, forbidden_error]
  case_categories.fetch(current_category) << name
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

required_files = lambda do |file_name, workflow|
  {
    'ci.yml' => manifest_workflow,
    'security.yml' => manifest_workflow,
    file_name => workflow
  }
end

current_category = :required_trigger_coverage_cases
add_case.call(
  'required-ci-workflow-dispatch-only',
  required_files.call('ci.yml', workflow_yaml(safe_sha, events: ['workflow_dispatch'])),
  false,
  'ci.yml: required workflow must include pull_request trigger'
)
add_case.call(
  'required-security-workflow-dispatch-only',
  required_files.call('security.yml', workflow_yaml(safe_sha, events: ['workflow_dispatch'])),
  false,
  'security.yml: required workflow must include pull_request trigger'
)
add_case.call(
  'required-ci-push-only',
  required_files.call('ci.yml', workflow_yaml(safe_sha, events: ['push'])),
  false,
  'ci.yml: required workflow must include pull_request trigger'
)
add_case.call(
  'required-ci-pull-request-only',
  required_files.call('ci.yml', workflow_yaml(safe_sha, events: ['pull_request'])),
  false,
  'ci.yml: required workflow must include push trigger'
)
add_case.call(
  'required-ci-pr-main-only',
  required_files.call(
    'ci.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => { 'branches' => ['main'] }, 'push' => nil })
  ),
  false,
  'ci.yml: required pull_request trigger must cover literal staging branch'
)
add_case.call(
  'required-security-pr-main-only',
  required_files.call(
    'security.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => { 'branches' => ['main'] }, 'push' => nil })
  ),
  false,
  'security.yml: required pull_request trigger must cover literal staging branch'
)
add_case.call(
  'required-ci-push-main-only',
  required_files.call(
    'ci.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => nil, 'push' => { 'branches' => ['main'] } })
  ),
  false,
  'ci.yml: required push trigger must cover literal staging branch'
)
add_case.call(
  'required-security-push-main-only',
  required_files.call(
    'security.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => nil, 'push' => { 'branches' => ['main'] } })
  ),
  false,
  'security.yml: required push trigger must cover literal staging branch'
)
add_case.call(
  'required-pr-branches-ignore',
  required_files.call(
    'ci.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => { 'branches-ignore' => ['main'] }, 'push' => nil })
  ),
  false,
  'ci.yml: required pull_request trigger must not use branches-ignore'
)
add_case.call(
  'required-push-branches-ignore',
  required_files.call(
    'ci.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => nil, 'push' => { 'branches-ignore' => ['main'] } })
  ),
  false,
  'ci.yml: required push trigger must not use branches-ignore'
)
add_case.call(
  'required-pr-paths-filter',
  required_files.call(
    'ci.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => { 'paths' => ['src/**'] }, 'push' => nil })
  ),
  false,
  'ci.yml: required pull_request trigger must not use paths'
)
add_case.call(
  'required-pr-paths-ignore',
  required_files.call(
    'ci.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => { 'paths-ignore' => ['docs/**'] }, 'push' => nil })
  ),
  false,
  'ci.yml: required pull_request trigger must not use paths-ignore'
)
add_case.call(
  'required-push-paths-filter',
  required_files.call(
    'ci.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => nil, 'push' => { 'paths' => ['src/**'] } })
  ),
  false,
  'ci.yml: required push trigger must not use paths'
)
add_case.call(
  'required-push-paths-ignore',
  required_files.call(
    'ci.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => nil, 'push' => { 'paths-ignore' => ['docs/**'] } })
  ),
  false,
  'ci.yml: required push trigger must not use paths-ignore'
)
add_case.call(
  'required-pr-types-closed',
  required_files.call(
    'ci.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => { 'types' => ['closed'] }, 'push' => nil })
  ),
  false,
  'ci.yml: required pull_request trigger must not use types'
)
add_case.call(
  'required-push-tags-only',
  required_files.call(
    'ci.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => nil, 'push' => { 'tags' => ['v*'] } })
  ),
  false,
  'ci.yml: required push trigger must cover literal staging branch'
)
add_case.call(
  'required-invalid-event-config',
  required_files.call(
    'ci.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => 'invalid', 'push' => nil })
  ),
  false,
  'ci.yml: required pull_request trigger configuration is invalid'
)
add_case.call(
  'required-push-invalid-types',
  required_files.call(
    'ci.yml',
    workflow_yaml(
      safe_sha,
      events: { 'pull_request' => nil, 'push' => { 'branches' => ['staging'], 'types' => ['created'] } }
    )
  ),
  false,
  'ci.yml: required push trigger configuration is invalid'
)
add_case.call(
  'required-empty-on-config',
  required_files.call('ci.yml', workflow_yaml(safe_sha, events: {})),
  false,
  'ci.yml: required workflow event configuration is invalid'
)
add_case.call(
  'required-array-pr-and-push',
  required_files.call('ci.yml', workflow_yaml(safe_sha, events: ['pull_request', 'push'])),
  true
)
add_case.call(
  'required-unfiltered-pr-and-push',
  required_files.call('ci.yml', workflow_yaml(safe_sha, events: { 'pull_request' => nil, 'push' => nil })),
  true
)
add_case.call(
  'required-staging-mapping',
  required_files.call(
    'ci.yml',
    workflow_yaml(
      safe_sha,
      events: {
        'pull_request' => { 'branches' => 'staging' },
        'push' => { 'branches' => ['staging'] }
      }
    )
  ),
  true
)
add_case.call(
  'required-main-staging-develop-mapping',
  required_files.call(
    'security.yml',
    workflow_yaml(
      safe_sha,
      events: {
        'pull_request' => { 'branches' => ['main', 'staging', 'develop'] },
        'push' => { 'branches' => ['main', 'staging', 'develop'] }
      }
    )
  ),
  true
)
add_case.call(
  'required-extra-schedule',
  required_files.call(
    'security.yml',
    workflow_yaml(
      safe_sha,
      events: {
        'pull_request' => nil,
        'push' => nil,
        'schedule' => [{ 'cron' => '0 0 * * 1' }]
      }
    )
  ),
  true
)
add_case.call(
  'required-extra-workflow-dispatch',
  required_files.call(
    'ci.yml',
    workflow_yaml(
      safe_sha,
      events: { 'pull_request' => nil, 'push' => nil, 'workflow_dispatch' => nil }
    )
  ),
  true
)
add_case.call(
  'required-pr-staging-then-negative-staging',
  required_files.call(
    'ci.yml',
    workflow_yaml(
      safe_sha,
      events: { 'pull_request' => { 'branches' => ['staging', '!staging'] }, 'push' => nil }
    )
  ),
  false,
  'ci.yml: required pull_request branches must use only allowed literal branches'
)
add_case.call(
  'required-push-staging-then-negative-staging',
  required_files.call(
    'ci.yml',
    workflow_yaml(
      safe_sha,
      events: { 'pull_request' => nil, 'push' => { 'branches' => ['staging', '!staging'] } }
    )
  ),
  false,
  'ci.yml: required push branches must use only allowed literal branches'
)
add_case.call(
  'required-pr-negative-staging-then-staging',
  required_files.call(
    'security.yml',
    workflow_yaml(
      safe_sha,
      events: { 'pull_request' => { 'branches' => ['!staging', 'staging'] }, 'push' => nil }
    )
  ),
  false,
  'security.yml: required pull_request branches must use only allowed literal branches'
)
add_case.call(
  'required-pr-staging-glob',
  required_files.call(
    'ci.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => { 'branches' => ['staging*'] }, 'push' => nil })
  ),
  false,
  'ci.yml: required pull_request branches must use only allowed literal branches'
)
add_case.call(
  'required-push-staging-glob',
  required_files.call(
    'security.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => nil, 'push' => { 'branches' => ['staging?'] } })
  ),
  false,
  'security.yml: required push branches must use only allowed literal branches'
)
add_case.call(
  'required-pr-unknown-literal-branch',
  required_files.call(
    'ci.yml',
    workflow_yaml(
      safe_sha,
      events: { 'pull_request' => { 'branches' => ['staging', 'release'] }, 'push' => nil }
    )
  ),
  false,
  'ci.yml: required pull_request branches must use only allowed literal branches'
)
add_case.call(
  'required-pr-tags-only',
  required_files.call(
    'ci.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => { 'tags' => ['v*'] }, 'push' => nil })
  ),
  false,
  'ci.yml: required pull_request trigger must not use tags'
)
add_case.call(
  'required-pr-tags-ignore-only',
  required_files.call(
    'ci.yml',
    workflow_yaml(safe_sha, events: { 'pull_request' => { 'tags-ignore' => ['v*'] }, 'push' => nil })
  ),
  false,
  'ci.yml: required pull_request trigger must not use tags-ignore'
)
add_case.call(
  'required-pr-tags-with-branches',
  required_files.call(
    'ci.yml',
    workflow_yaml(
      safe_sha,
      events: { 'pull_request' => { 'branches' => ['staging'], 'tags' => ['v*'] }, 'push' => nil }
    )
  ),
  false,
  'ci.yml: required pull_request trigger must not use tags'
)
add_case.call(
  'required-pr-tags-ignore-with-branches',
  required_files.call(
    'ci.yml',
    workflow_yaml(
      safe_sha,
      events: { 'pull_request' => { 'branches' => ['staging'], 'tags-ignore' => ['v*'] }, 'push' => nil }
    )
  ),
  false,
  'ci.yml: required pull_request trigger must not use tags-ignore'
)
add_case.call(
  'required-push-tags-with-branches',
  required_files.call(
    'ci.yml',
    workflow_yaml(
      safe_sha,
      events: { 'pull_request' => nil, 'push' => { 'branches' => ['staging'], 'tags' => ['v*'] } }
    )
  ),
  false,
  'ci.yml: required push trigger must not use tags'
)
add_case.call(
  'required-push-tags-ignore-with-branches',
  required_files.call(
    'ci.yml',
    workflow_yaml(
      safe_sha,
      events: { 'pull_request' => nil, 'push' => { 'branches' => ['staging'], 'tags-ignore' => ['v*'] } }
    )
  ),
  false,
  'ci.yml: required push trigger must not use tags-ignore'
)
add_case.call(
  'required-escaped-glob-pattern',
  required_files.call(
    'security.yml',
    workflow_yaml(
      safe_sha,
      events: { 'pull_request' => { 'branches' => ['staging', 'feature\\*'] }, 'push' => nil }
    )
  ),
  false,
  'security.yml: required pull_request branches must use only allowed literal branches'
)

current_category = :structural_yaml_cases
add_case.call('safe', workflow_yaml(safe_sha), true)

current_category = :malformed_job_structure_cases
add_case.call(
  'workflow-root-sequence',
  YAML.dump([{ 'name' => 'not a workflow mapping' }]),
  false,
  'workflow root must be a mapping'
)

missing_jobs = YAML.safe_load(workflow_yaml(safe_sha), aliases: false)
missing_jobs.delete('jobs')
add_case.call('missing-jobs', YAML.dump(missing_jobs), false, 'jobs must be a non-empty mapping')
add_case.call(
  'empty-jobs',
  amend_workflow(workflow_yaml(safe_sha)) { |workflow| workflow['jobs'] = {} },
  false,
  'jobs must be a non-empty mapping'
)
add_case.call(
  'jobs-not-mapping',
  amend_workflow(workflow_yaml(safe_sha)) { |workflow| workflow['jobs'] = 'unsafe' },
  false,
  'jobs must be a non-empty mapping'
)
add_case.call(
  'job-not-mapping',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => 'not a mapping' }),
  false,
  'job unsafe must be a mapping'
)
add_case.call(
  'ordinary-job-missing-runs-on',
  workflow_yaml(
    safe_sha,
    jobs: { 'unsafe' => standard_job(safe_sha).tap { |job| job.delete('runs-on') } }
  ),
  false,
  'job unsafe must declare runs-on'
)
add_case.call(
  'ordinary-job-missing-steps',
  workflow_yaml(
    safe_sha,
    jobs: { 'unsafe' => standard_job(safe_sha).tap { |job| job.delete('steps') } }
  ),
  false,
  'job unsafe steps must be a non-empty array'
)
add_case.call(
  'ordinary-job-steps-not-array',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => 'echo unsafe') }),
  false,
  'job unsafe steps must be a non-empty array'
)
add_case.call(
  'ordinary-job-empty-steps',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => []) }),
  false,
  'job unsafe steps must be a non-empty array'
)

add_case.call(
  'job-without-ordinary-or-reusable-structure',
  workflow_yaml(
    safe_sha,
    jobs: {
      'unsafe' => {
        'timeout-minutes' => 5,
        'permissions' => { 'contents' => 'read' }
      }
    }
  ),
  false,
  'job unsafe must declare runs-on'
)

current_category = :reusable_workflow_forbidden_cases
external_reusable_reference = "owner/repo/.github/workflows/reusable.yml@#{safe_sha}"
add_case.call(
  'job-level-action-reference-forbidden',
  workflow_yaml(
    safe_sha,
    jobs: {
      'unsafe' => {
        'uses' => "actions/checkout@#{safe_sha}",
        'timeout-minutes' => 5,
        'permissions' => { 'contents' => 'read' }
      }
    }
  ),
  false,
  'reusable workflow calls are forbidden in policy v1'
)
add_case.call(
  'external-reusable-workflow-forbidden',
  workflow_yaml(
    safe_sha,
    jobs: {
      'unsafe' => {
        'uses' => external_reusable_reference,
        'timeout-minutes' => 5,
        'permissions' => { 'contents' => 'read' }
      }
    }
  ),
  false,
  'reusable workflow calls are forbidden in policy v1'
)
add_case.call(
  'local-reusable-workflow-forbidden',
  workflow_yaml(
    safe_sha,
    jobs: {
      'unsafe' => {
        'uses' => './.github/workflows/reusable.yml',
        'timeout-minutes' => 5,
        'permissions' => { 'contents' => 'read' }
      }
    }
  ),
  false,
  'reusable workflow calls are forbidden in policy v1'
)
add_case.call(
  'reusable-workflow-with-timeout-forbidden',
  workflow_yaml(
    safe_sha,
    jobs: {
      'unsafe' => {
        'uses' => external_reusable_reference,
        'timeout-minutes' => 5,
        'permissions' => { 'contents' => 'read' }
      }
    }
  ),
  false,
  'reusable workflow calls are forbidden in policy v1'
)
add_case.call(
  'reusable-workflow-without-timeout-forbidden',
  workflow_yaml(
    safe_sha,
    jobs: { 'unsafe' => { 'uses' => external_reusable_reference, 'permissions' => { 'contents' => 'read' } } }
  ),
  false,
  'reusable workflow calls are forbidden in policy v1',
  'must declare timeout-minutes'
)
add_case.call(
  'reusable-workflow-with-inputs-forbidden',
  workflow_yaml(
    safe_sha,
    jobs: {
      'unsafe' => {
        'uses' => external_reusable_reference,
        'with' => { 'mode' => 'safe' },
        'needs' => ['prepare'],
        'permissions' => { 'contents' => 'read' }
      }
    }
  ),
  false,
  'reusable workflow calls are forbidden in policy v1',
  'must declare timeout-minutes'
)

current_category = :malformed_step_structure_cases
add_case.call(
  'step-not-mapping',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => ['echo unsafe']) }),
  false,
  'step 1 in job unsafe must be a mapping'
)
add_case.call(
  'step-without-run-or-uses',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'name' => 'empty step' }]) }),
  false,
  'step 1 in job unsafe must define exactly one of run or uses'
)
add_case.call(
  'step-with-run-and-uses',
  workflow_yaml(
    safe_sha,
    jobs: {
      'unsafe' => standard_job(
        safe_sha,
        'steps' => [{ 'run' => 'echo unsafe', 'uses' => "actions/checkout@#{safe_sha}", 'with' => { 'persist-credentials' => false } }]
      )
    }
  ),
  false,
  'step 1 in job unsafe must define exactly one of run or uses'
)
add_case.call(
  'step-run-empty-string',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'run' => '' }]) }),
  false,
  'step 1 in job unsafe run must be a non-empty string'
)
add_case.call(
  'step-run-not-string',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'run' => ['echo unsafe'] }]) }),
  false,
  'step 1 in job unsafe run must be a non-empty string'
)
add_case.call(
  'step-uses-empty-string',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'uses' => '' }]) }),
  false,
  'step 1 in job unsafe uses must be a non-empty string'
)
add_case.call(
  'step-uses-not-string',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'uses' => ['unsafe'] }]) }),
  false,
  'step 1 in job unsafe uses must be a non-empty string'
)
add_case.call(
  'valid-run-step',
  workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha, 'steps' => [{ 'run' => 'echo safe' }]) }),
  true
)
add_case.call(
  'valid-uses-step',
  workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha, 'steps' => [checkout_step(safe_sha)]) }),
  true
)

current_category = :permissions_cases
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

current_category = :timeout_continue_on_error_cases
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

current_category = :action_pinning_cases
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

current_category = :structural_yaml_cases
add_case.call('pull-request-target', workflow_yaml(safe_sha, events: ['pull_request_target']), false, 'pull_request_target is forbidden')

current_category = :action_pinning_cases
add_case.call(
  'floating-step-action',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'uses' => 'actions/checkout@v5' }]) }),
  false,
  'action is not pinned'
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

current_category = :local_action_cases
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
  'local-action-hides-floating-action',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'steps' => [{ 'uses' => './.github/actions/hides-floating-action' }]) }),
  false,
  'local actions and local reusable workflows are forbidden in policy v1'
)

current_category = :container_service_cases
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

current_category = :privileged_environment_cases
add_case.call(
  'job-environment-string',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'environment' => 'Production') }),
  false,
  'policy v1 forbids job environments'
)
add_case.call(
  'job-environment-mapping',
  workflow_yaml(
    safe_sha,
    jobs: { 'unsafe' => standard_job(safe_sha, 'environment' => { 'name' => 'Production' }) }
  ),
  false,
  'policy v1 forbids job environments'
)
add_case.call(
  'job-environment-expression',
  workflow_yaml(
    safe_sha,
    jobs: { 'unsafe' => standard_job(safe_sha, 'environment' => '${{ github.event_name }}') }
  ),
  false,
  'policy v1 forbids job environments'
)
add_case.call(
  'job-environment-null',
  workflow_yaml(safe_sha, jobs: { 'unsafe' => standard_job(safe_sha, 'environment' => nil) }),
  false,
  'policy v1 forbids job environments'
)
add_case.call(
  'job-without-environment',
  workflow_yaml(safe_sha, jobs: { 'safe' => standard_job(safe_sha) }),
  true
)

current_category = :secret_reference_cases
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
  'must not declare or pass secrets'
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
  'must not declare or pass secrets'
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
  'must not declare or pass secrets'
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

current_category = :runner_cases
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

current_category = :timeout_continue_on_error_cases
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

current_category = :wrapped_github_expression_cases
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

current_category = :implicit_if_expression_cases
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
  add_case.call(
    name,
    amend_workflow(workflow_yaml(safe_sha)) { |workflow| mutation.call(workflow) },
    false,
    'if expression direct github context is forbidden except github.sha and github.event_name'
  )
end

current_category = :wrapped_github_expression_cases
{
  'job-if-wrapped-untrusted-context' => lambda { |workflow| workflow['jobs']['test']['if'] = "${{ github.event.pull_request.head.ref == 'main' }}" },
  'step-if-wrapped-untrusted-context' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['if'] = "${{ github.event.pull_request.head.ref == 'main' }}" }
}.each do |name, mutation|
  add_case.call(
    name,
    amend_workflow(workflow_yaml(safe_sha)) { |workflow| mutation.call(workflow) },
    false,
    'direct github context interpolation is forbidden except github.sha and github.event_name'
  )
end

current_category = :implicit_if_expression_cases
{
  'job-if-implicit-safe-event-name' => lambda { |workflow| workflow['jobs']['test']['if'] = "github.event_name == 'push'" },
  'step-if-implicit-safe-event-name' => lambda { |workflow| workflow['jobs']['test']['steps'][1]['if'] = "github.event_name == 'push'" },
  'job-if-implicit-safe-sha' => lambda { |workflow| workflow['jobs']['test']['if'] = "github.sha != ''" }
}.each do |name, mutation|
  add_case.call(name, amend_workflow(workflow_yaml(safe_sha)) { |workflow| mutation.call(workflow) }, true)
end

current_category = :wrapped_github_expression_cases
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

current_category = :structural_yaml_cases
add_case.call('yaml-alias', "name: alias\non: [push]\npermissions: &p\n  contents: read\njobs:\n  test:\n    permissions: *p\n", false, 'forbidden alias')
add_case.call('oversized-workflow', "# generated oversize fixture\n#{'x' * (513 * 1024)}", false, 'workflow exceeds')
add_case.call('malformed-yaml', "name: [broken\n", false, 'invalid YAML')

policy_case_failures = []
Dir.mktmpdir('graylum-workflow-policy-') do |root|
  cases.each do |name, (content, should_pass, expected_error, forbidden_error)|
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
        File.write(File.join(directory, 'fixture.yml'), content)
        File.write(File.join(directory, 'ci.yml'), manifest_workflow)
        File.write(File.join(directory, 'security.yml'), manifest_workflow)
      end
    end
    _stdout, stderr, status = Open3.capture3('ruby', checker, directory)
    actual = status.success?
    expected_error_present = expected_error.nil? || stderr.include?(expected_error)
    forbidden_error_absent = forbidden_error.nil? || !stderr.include?(forbidden_error)
    next if actual == should_pass && expected_error_present && forbidden_error_absent

    policy_case_failures << "#{name}: expected pass=#{should_pass}, error=#{expected_error.inspect}, and no error=#{forbidden_error.inspect}; got pass=#{actual}: #{stderr}"
  end
end

unless policy_case_failures.empty?
  policy_case_failures.each { |failure| warn failure }
  exit 1
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

categorized_case_count = case_categories.values.sum(&:length)
unless categorized_case_count == cases.length
  warn "expected #{cases.length} categorized policy cases, got #{categorized_case_count}"
  exit 1
end

fixture_directory_safety_cases = dangerous_fixture_cases.length + 1
case_category_order.each do |category|
  puts "#{category}=#{case_categories.fetch(category).length}"
end
puts "fixture_directory_safety_cases=#{fixture_directory_safety_cases}"
puts "Remaining structural policy cases passed (#{cases.length + fixture_directory_safety_cases} cases)."
