#!/usr/bin/env ruby

require 'yaml'

MAX_WORKFLOW_BYTES = 512 * 1024
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
CODEQL_WRITE_EVENTS = %w[push schedule].freeze
UNTRUSTED_RUN_CONTEXTS = [
  /github\.event\.pull_request\.(?:title|body)/i,
  /github\.event\.issue\.body/i,
  /github\.event\.comment\.body/i,
  /github\.head_ref/i,
  /github\.event\.head_commit\.message/i,
  /github\.event\.commits(?:\[[^\]]+\]|\.[\w*-]+)*\.message/i
].freeze

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

def each_string(value, &block)
  case value
  when String then block.call(value)
  when Array then value.each { |item| each_string(item, &block) }
  when Hash then value.each_value { |item| each_string(item, &block) }
  end
end

def immutable_uses?(reference)
  return true if reference.start_with?('./')
  return reference.match?(/\A[\w.-]+\/[\w.-]+(?:\/[\w.\/-]+)?@[a-f0-9]{40}\z/i) unless reference.start_with?('docker://')

  reference.match?(/\Adocker:\/\/.+@sha256:[a-f0-9]{64}\z/i)
end

def action_repository(reference)
  return nil if reference.start_with?('./', 'docker://')

  reference.split('@', 2).first.split('/').first(2).join('/')
end

def approved_action?(reference)
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

def codeql_write_allowed?(events, job, permission, value)
  names = event_names(events)
  permission == 'security-events' && value.to_s == 'write' &&
    !names.empty? && (names - CODEQL_WRITE_EVENTS).empty? && codeql_job?(job)
end

def validate_permissions(file, label, permissions, events, job = nil)
  failures = []
  if permissions == 'write-all'
    failures << "#{file}: #{label} permissions: write-all is forbidden"
    return failures
  end
  return failures unless permissions.is_a?(Hash)

  permissions.each do |permission, value|
    next unless value.to_s == 'write'
    next if job && codeql_write_allowed?(events, job, permission.to_s, value)

    failures << "#{file}: #{label} write permission #{permission}: write is forbidden"
  end
  failures
end

def secret_reference?(value)
  value.match?(/\bsecrets\s*(?:\.|\[)/i) ||
    value.match?(/\$\{\{\s*secrets\s*\}\}/i) ||
    value.match?(/\btojson\s*\(\s*secrets\s*\)/i)
end

def privileged_secret_reference?(value)
  secret_reference?(value) && value.match?(/PROD|PRODUCTION|LIVE|SERVICE_ROLE|DATABASE|STRIPE|OPENAI|OPENROUTER|ANTHROPIC|CRON/i)
end

def pipe_to_shell?(value)
  value.match?(/\b(?:curl|wget)\b[\s\S]*?\|\s*(?:bash|sh)\b/i)
end

def untrusted_context_in_run?(value)
  value.include?('${{') && UNTRUSTED_RUN_CONTEXTS.any? { |pattern| value.match?(pattern) }
end

def self_hosted_runner?(runs_on)
  case runs_on
  when String then runs_on.match?(/(?:^|[,\s])self-hosted(?:$|[,\s])/i)
  when Array then runs_on.any? { |label| label.to_s.casecmp('self-hosted').zero? }
  else false
  end
end

files = Dir.glob(File.join(workflow_dir, '*.{yml,yaml}')).sort
files.each do |file|
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
  pull_request = event_enabled?(events, 'pull_request')
  failures << "#{file}: pull_request_target is forbidden" if event_enabled?(events, 'pull_request_target')

  top_permissions = workflow['permissions']
  failures << "#{file}: top-level permissions must be declared" if top_permissions.nil?
  failures.concat(validate_permissions(file, 'top-level', top_permissions, events))

  each_string(workflow) do |value|
    failures << "#{file}: unsafe runner flag is forbidden" if value.match?(/danger-full-access|--yolo/)
    failures << "#{file}: auto-merge commands are forbidden" if value.match?(/\bgh\s+pr\s+merge\b|\bauto-merge\b/i)
    failures << "#{file}: pipe-to-shell command is forbidden" if pipe_to_shell?(value)
    next unless pull_request && secret_reference?(value)

    failures << "#{file}: pull_request workflows must not reference secrets"
    failures << "#{file}: privileged secret name found in pull_request workflow" if privileged_secret_reference?(value)
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

    failures.concat(validate_permissions(file, "job #{job_name}", job['permissions'], events, job))
    failures << "#{file}: job #{job_name} must declare timeout-minutes" unless job.key?('timeout-minutes')
    if pull_request && job['secrets'].to_s == 'inherit'
      failures << "#{file}: pull_request job #{job_name} must not use secrets: inherit"
    end
    if pull_request && self_hosted_runner?(job['runs-on'])
      failures << "#{file}: pull_request job #{job_name} must not use a self-hosted runner"
    end

    if job['uses']
      reference = job['uses'].to_s
      unless immutable_uses?(reference)
        failures << "#{file}: reusable workflow is not pinned to an immutable reference"
      end
      unless approved_action?(reference)
        failures << "#{file}: reusable workflow repository is not approved"
      end
    end

    steps = job['steps']
    next unless steps.is_a?(Array)

    steps.each_with_index do |step, index|
      next unless step.is_a?(Hash)

      run = step['run']
      if run.is_a?(String) && untrusted_context_in_run?(run)
        failures << "#{file}: run step #{index + 1} in job #{job_name} directly interpolates untrusted GitHub context"
      end
      next unless step['uses']

      reference = step['uses'].to_s
      failures << "#{file}: action is not pinned to an immutable reference" unless immutable_uses?(reference)
      failures << "#{file}: action repository is not approved" unless approved_action?(reference)
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
