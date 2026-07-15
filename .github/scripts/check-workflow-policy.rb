#!/usr/bin/env ruby

require 'yaml'

MAX_WORKFLOW_BYTES = 512 * 1024
REQUIRED_WORKFLOW_FILES = %w[ci.yml security.yml].freeze
ALLOWED_REQUIRED_BRANCHES = %w[main staging develop].freeze
ALLOWED_GITHUB_CONTEXTS = %w[github.sha github.event_name].freeze
APPROVED_ACTION_REPOSITORIES = %w[
  actions/checkout
  actions/dependency-review-action
  actions/download-artifact
  actions/setup-node
  actions/upload-artifact
  github/codeql-action
  gitleaks/gitleaks-action
  pnpm/action-setup
].freeze
APPROVED_DOCKER_IMAGES = [].freeze
APPROVED_PR_RUNNERS = [
  /\Aubuntu-(?:latest|24\.04|22\.04)\z/,
  /\Awindows-(?:latest|2025|2022)\z/,
  /\Amacos-(?:latest|15|14|13)\z/
].freeze
CODEQL_WRITE_EVENTS = %w[push schedule].freeze
CODEQL_WRITE_JOB_NAMES = %w[codeql codeql-analysis].freeze
LOCAL_USES_ERROR = 'local actions and local reusable workflows are forbidden in policy v1'

workflow_dir = ARGV.fetch(0, '.github/workflows')
failures = []

def event_config(workflow)
  workflow['on'] || workflow[true]
end

def event_names(events)
  case events
  when String then [events]
  when Array then events.map(&:to_s)
  when Hash then events.keys.map(&:to_s)
  else []
  end
end

def event_enabled?(events, name)
  event_names(events).include?(name)
end

def required_branch_literals(value)
  values = value.is_a?(Array) ? value : [value]
  return nil if values.empty?
  return nil unless values.all? { |item| item.is_a?(String) && !item.empty? }

  values
end

def valid_required_event_collection?(events)
  case events
  when String
    !events.empty?
  when Array
    !events.empty? && events.all? { |event| event.is_a?(String) && !event.empty? }
  when Hash
    !events.empty? && events.keys.all? { |event| event.is_a?(String) && !event.empty? }
  else
    false
  end
end

def required_event_configuration_failures(file, event_name, configuration)
  return [] if configuration.nil?

  unless configuration.is_a?(Hash)
    return ["#{file}: required #{event_name} trigger configuration is invalid"]
  end

  failures = []
  keys = configuration.keys
  unless keys.all? { |key| key.is_a?(String) && !key.empty? }
    failures << "#{file}: required #{event_name} trigger configuration is invalid"
    return failures
  end

  %w[branches-ignore paths paths-ignore].each do |forbidden_filter|
    if configuration.key?(forbidden_filter)
      failures << "#{file}: required #{event_name} trigger must not use #{forbidden_filter}"
    end
  end
  if event_name == 'pull_request' && configuration.key?('types')
    failures << "#{file}: required pull_request trigger must not use types"
  elsif event_name == 'push' && configuration.key?('types')
    failures << "#{file}: required push trigger configuration is invalid"
  end
  if event_name == 'push'
    %w[tags tags-ignore].each do |forbidden_filter|
      if configuration.key?(forbidden_filter)
        failures << "#{file}: required push trigger must not use #{forbidden_filter}"
      end
    end
  end

  allowed_keys = %w[branches]
  known_forbidden_keys = %w[branches-ignore paths paths-ignore types tags tags-ignore]
  if (keys - allowed_keys - known_forbidden_keys).any?
    failures << "#{file}: required #{event_name} trigger configuration is invalid"
  end

  if configuration.key?('branches')
    branches = required_branch_literals(configuration['branches'])
    unless branches
      failures << "#{file}: required #{event_name} trigger configuration is invalid"
      return failures
    end
    unless branches.all? { |branch| ALLOWED_REQUIRED_BRANCHES.include?(branch) }
      failures << "#{file}: required #{event_name} branches must use only allowed literal branches"
    end
    unless branches.include?('staging')
      failures << "#{file}: required #{event_name} trigger must cover literal staging branch"
    end
  elsif event_name == 'push' && (configuration.key?('tags') || configuration.key?('tags-ignore'))
    failures << "#{file}: required push trigger must cover literal staging branch"
  end

  failures
end

def required_workflow_trigger_failures(file, events)
  unless valid_required_event_collection?(events)
    return ["#{file}: required workflow event configuration is invalid"]
  end

  failures = []
  %w[pull_request push].each do |required_event|
    unless event_enabled?(events, required_event)
      failures << "#{file}: required workflow must include #{required_event} trigger"
      next
    end
    next unless events.is_a?(Hash)

    failures.concat(required_event_configuration_failures(file, required_event, events[required_event]))
  end
  failures
end

def each_string(value, &block)
  case value
  when String then block.call(value)
  when Array then value.each { |item| each_string(item, &block) }
  when Hash then value.each_value { |item| each_string(item, &block) }
  end
end

def secrets_key_present?(value)
  case value
  when Array
    value.any? { |item| secrets_key_present?(item) }
  when Hash
    value.any? { |key, item| key.to_s.casecmp('secrets').zero? || secrets_key_present?(item) }
  else
    false
  end
end

def immutable_uses?(reference)
  return false if reference.start_with?('./')
  return reference.match?(/\A[\w.-]+\/[\w.-]+(?:\/[\w.\/-]+)?@[a-f0-9]{40}\z/i) unless reference.start_with?('docker://')

  reference.match?(/\Adocker:\/\/.+@sha256:[a-f0-9]{64}\z/i)
end

def action_repository(reference)
  return nil if reference.start_with?('./', 'docker://')

  reference.split('@', 2).first.split('/').first(2).join('/')
end

def approved_action?(reference)
  if reference.start_with?('docker://')
    image = reference.delete_prefix('docker://').split('@', 2).first
    return APPROVED_DOCKER_IMAGES.include?(image.downcase)
  end

  repository = action_repository(reference)
  repository.nil? || APPROVED_ACTION_REPOSITORIES.include?(repository.downcase)
end

def codeql_job?(job)
  steps = job['steps']
  return false unless steps.is_a?(Array)

  steps.any? do |step|
    step.is_a?(Hash) && step['uses'].to_s.match?(/\Agithub\/codeql-action\/(?:init|analyze)@/i)
  end
end

def codeql_write_allowed?(events, job_name, job, permission, value)
  names = event_names(events)
  permission == 'security-events' && value.to_s == 'write' &&
    CODEQL_WRITE_JOB_NAMES.include?(job_name.to_s) &&
    !names.empty? && (names - CODEQL_WRITE_EVENTS).empty? && codeql_job?(job)
end

def validate_permissions(file, label, permissions, events, job_name = nil, job = nil)
  failures = []
  if %w[read-all write-all].include?(permissions)
    failures << "#{file}: #{label} permissions: #{permissions} is forbidden"
    return failures
  end
  return failures unless permissions.is_a?(Hash)

  permissions.each do |permission, value|
    next unless value.to_s == 'write'
    next if job && codeql_write_allowed?(events, job_name, job, permission.to_s, value)

    failures << "#{file}: #{label} write permission #{permission}: write is forbidden"
  end
  failures
end

def secret_reference?(value)
  value.match?(/\bsecrets\s*(?:\.|\[)/i) ||
    value.match?(/\$\{\{\s*secrets\s*\}\}/i) ||
    value.match?(/\btojson\s*\(\s*secrets\s*\)/i)
end

def workflow_expressions(value)
  expressions = []
  cursor = 0

  while (start_index = value.index('${{', cursor))
    index = start_index + 3
    quote = nil
    closed = false

    while index < value.length
      character = value[index]
      if quote
        if character == quote && value[index + 1] == quote
          index += 2
          next
        end
        quote = nil if character == quote
      elsif character == "'" || character == '"'
        quote = character
      elsif value[index, 2] == '}}'
        expressions << value[(start_index + 3)...index]
        cursor = index + 2
        closed = true
        break
      end
      index += 1
    end

    unless closed
      expressions << value[(start_index + 3)..]
      break
    end
  end

  expressions
end

def github_contexts_in_expression(expression)
  normalized = expression.gsub(/\[\s*['"]([^'"]+)['"]\s*\]/, '.\\1')
  normalized = normalized.gsub(/\s*\.\s*/, '.').downcase
  normalized.scan(/\bgithub(?:\.[a-z_][a-z0-9_]*)*/)
end

def github_contexts_in_wrapped_expressions(value)
  workflow_expressions(value).flat_map do |expression|
    github_contexts_in_expression(expression)
  end.uniq
end

def github_contexts_in_implicit_if_expression(value)
  github_contexts_in_expression(value).uniq
end

def forbidden_github_contexts?(contexts)
  contexts.any? do |context|
    !ALLOWED_GITHUB_CONTEXTS.include?(context)
  end
end

def forbidden_github_context_in_wrapped_expressions?(value)
  forbidden_github_contexts?(github_contexts_in_wrapped_expressions(value))
end

def forbidden_github_context_in_if?(value)
  contexts = github_contexts_in_wrapped_expressions(value)
  contexts.concat(github_contexts_in_implicit_if_expression(value))
  forbidden_github_contexts?(contexts.uniq)
end

def approved_runner?(runs_on)
  runs_on.is_a?(String) && APPROVED_PR_RUNNERS.any? { |pattern| runs_on.match?(pattern) }
end

def valid_timeout?(timeout)
  timeout.is_a?(Integer) && timeout.between?(1, 60)
end

files = []
unless Dir.exist?(workflow_dir)
  failures << "#{workflow_dir}: workflow directory is missing"
else
  files = Dir.glob(File.join(workflow_dir, '*.{yml,yaml}')).sort
  failures << "#{workflow_dir}: workflow directory must contain workflow files" if files.empty?

  REQUIRED_WORKFLOW_FILES.each do |required_file|
    required_path = File.join(workflow_dir, required_file)
    unless File.file?(required_path) && !File.symlink?(required_path)
      failures << "#{required_path}: required workflow must exist as a regular non-symlink file"
    end
  end
end

files.each do |file|
  next unless File.file?(file)

  if File.size(file) > MAX_WORKFLOW_BYTES
    failures << "#{file}: workflow exceeds #{MAX_WORKFLOW_BYTES} byte policy limit"
    next
  end

  begin
    source = File.binread(file)
    workflow = YAML.safe_load(source, permitted_classes: [], permitted_symbols: [], aliases: false) || {}
  rescue Psych::Exception => e
    failures << "#{file}: invalid YAML or forbidden alias: #{e.message.lines.first.strip}"
    next
  end

  unless workflow.is_a?(Hash)
    failures << "#{file}: workflow root must be a mapping"
    next
  end

  events = event_config(workflow)
  if REQUIRED_WORKFLOW_FILES.include?(File.basename(file))
    failures.concat(required_workflow_trigger_failures(file, events))
  end
  failures << "#{file}: pull_request_target is forbidden" if event_enabled?(events, 'pull_request_target')

  top_permissions = workflow['permissions']
  failures << "#{file}: top-level permissions must be declared" if top_permissions.nil?
  unless top_permissions.nil? || top_permissions.is_a?(Hash)
    failures << "#{file}: top-level permissions must be an explicit mapping"
  end
  failures.concat(validate_permissions(file, 'top-level', top_permissions, events))

  if secrets_key_present?(workflow)
    failures << "#{file}: trusted_policy_material_v1 workflows must not declare or pass secrets"
  end

  each_string(workflow) do |value|
    if forbidden_github_context_in_wrapped_expressions?(value)
      failures << "#{file}: direct github context interpolation is forbidden except github.sha and github.event_name"
    end
    next unless secret_reference?(value)

    failures << "#{file}: trusted_policy_material_v1 workflows must not reference secrets"
  end

  jobs = workflow['jobs']
  unless jobs.is_a?(Hash) && !jobs.empty?
    failures << "#{file}: jobs must be a non-empty mapping"
    next
  end

  jobs.each do |job_name, job|
    unless job.is_a?(Hash)
      failures << "#{file}: job #{job_name} must be a mapping"
      next
    end

    if job.key?('uses')
      failures << "#{file}: reusable workflow calls are forbidden in policy v1"
      next
    end

    if job.key?('environment')
      failures << "#{file}: policy v1 forbids job environments"
    end

    job_permissions = job['permissions']
    unless job_permissions.is_a?(Hash)
      failures << "#{file}: job #{job_name} permissions must be an explicit mapping"
    end
    failures.concat(validate_permissions(file, "job #{job_name}", job_permissions, events, job_name, job))

    unless job.key?('timeout-minutes')
      failures << "#{file}: job #{job_name} must declare timeout-minutes"
    end
    if job.key?('timeout-minutes') && !valid_timeout?(job['timeout-minutes'])
      failures << "#{file}: job #{job_name} timeout-minutes must be an integer from 1 to 60"
    end
    if job.key?('continue-on-error') && job['continue-on-error'] != false
      failures << "#{file}: job #{job_name} continue-on-error must be explicitly false when present"
    end
    if job.key?('container')
      failures << "#{file}: job #{job_name} containers are forbidden in policy v1"
    end
    if job.key?('services')
      failures << "#{file}: job #{job_name} services are forbidden in policy v1"
    end
    if job['secrets'].to_s == 'inherit'
      failures << "#{file}: trusted_policy_material_v1 job #{job_name} must not use secrets: inherit"
    end
    job_if = job['if']
    if job_if.is_a?(String) && forbidden_github_context_in_if?(job_if)
      failures << "#{file}: job #{job_name} if expression direct github context is forbidden except github.sha and github.event_name"
    end

    unless job.key?('runs-on')
      failures << "#{file}: job #{job_name} must declare runs-on"
    end
    if job.key?('runs-on') && !approved_runner?(job['runs-on'])
      failures << "#{file}: job #{job_name} must use an approved GitHub-hosted runner"
    end

    steps = job['steps']
    unless steps.is_a?(Array) && !steps.empty?
      failures << "#{file}: job #{job_name} steps must be a non-empty array"
      next
    end

    steps.each_with_index do |step, index|
      unless step.is_a?(Hash)
        failures << "#{file}: step #{index + 1} in job #{job_name} must be a mapping"
        next
      end

      if step.key?('continue-on-error') && step['continue-on-error'] != false
        failures << "#{file}: step #{index + 1} in job #{job_name} continue-on-error must be explicitly false when present"
      end

      step_if = step['if']
      if step_if.is_a?(String) && forbidden_github_context_in_if?(step_if)
        failures << "#{file}: step #{index + 1} in job #{job_name} if expression direct github context is forbidden except github.sha and github.event_name"
      end

      has_run = step.key?('run')
      has_uses = step.key?('uses')
      unless has_run ^ has_uses
        failures << "#{file}: step #{index + 1} in job #{job_name} must define exactly one of run or uses"
        next
      end

      if has_run
        run = step['run']
        unless run.is_a?(String) && !run.strip.empty?
          failures << "#{file}: step #{index + 1} in job #{job_name} run must be a non-empty string"
        end
        next
      end

      reference = step['uses']
      unless reference.is_a?(String) && !reference.strip.empty?
        failures << "#{file}: step #{index + 1} in job #{job_name} uses must be a non-empty string"
        next
      end
      if reference.start_with?('./')
        failures << "#{file}: #{LOCAL_USES_ERROR}"
      else
        failures << "#{file}: action is not pinned to an immutable reference" unless immutable_uses?(reference)
        unless approved_action?(reference)
          label = reference.start_with?('docker://') ? 'docker image' : 'action repository'
          failures << "#{file}: #{label} is not approved"
        end
      end
      next unless reference.match?(/\Aactions\/checkout@[a-f0-9]{40}\z/i)

      with = step['with']
      persist = with.is_a?(Hash) ? with['persist-credentials'] : nil
      unless persist == false || persist.to_s == 'false'
        failures << "#{file}: checkout step #{index + 1} in job #{job_name} must set persist-credentials: false"
      end
    end
  end
end

if failures.any?
  warn 'Workflow policy check failed:'
  failures.uniq.each { |failure| warn "- #{failure}" }
  exit 1
end

puts "Workflow policy check passed for #{files.length} workflow files."
