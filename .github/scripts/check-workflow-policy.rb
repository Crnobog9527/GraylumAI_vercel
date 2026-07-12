#!/usr/bin/env ruby

require 'yaml'

workflow_dir = ARGV.fetch(0, '.github/workflows')
failures = []

def event_config(workflow)
  workflow['on'] || workflow[true]
end

def event_enabled?(events, name)
  case events
  when String then events == name
  when Array then events.include?(name)
  when Hash then events.key?(name)
  else false
  end
end

def each_string(value, &block)
  case value
  when String then block.call(value)
  when Array then value.each { |item| each_string(item, &block) }
  when Hash then value.each_value { |item| each_string(item, &block) }
  end
end

def write_permission?(permissions)
  return true if permissions == 'write-all'
  return false unless permissions.is_a?(Hash)

  permissions.values.any? { |value| value.to_s == 'write' }
end

def immutable_uses?(reference)
  return true if reference.start_with?('./')
  return reference.match?(/\A[\w.-]+\/[\w.-]+(?:\/[\w.\/-]+)?@[a-f0-9]{40}\z/i) unless reference.start_with?('docker://')

  reference.match?(/\Adocker:\/\/.+@sha256:[a-f0-9]{64}\z/i)
end

files = Dir.glob(File.join(workflow_dir, '*.{yml,yaml}')).sort
files.each do |file|
  begin
    workflow = YAML.safe_load(File.read(file), aliases: true) || {}
  rescue Psych::Exception => e
    failures << "#{file}: invalid YAML: #{e.message.lines.first.strip}"
    next
  end

  unless workflow.is_a?(Hash)
    failures << "#{file}: workflow root must be a mapping"
    next
  end

  events = event_config(workflow)
  pull_request = event_enabled?(events, 'pull_request')
  if event_enabled?(events, 'pull_request_target')
    failures << "#{file}: pull_request_target is forbidden"
  end

  top_permissions = workflow['permissions']
  failures << "#{file}: top-level permissions must be declared" if top_permissions.nil?
  if top_permissions == 'write-all'
    failures << "#{file}: permissions: write-all is forbidden"
  end
  if pull_request && write_permission?(top_permissions)
    failures << "#{file}: pull_request workflows must not have write permissions"
  end

  each_string(workflow) do |value|
    failures << "#{file}: unsafe runner flag is forbidden" if value.match?(/danger-full-access|--yolo/)
    failures << "#{file}: auto-merge commands are forbidden" if value.match?(/\bgh\s+pr\s+merge\b|\bauto-merge\b/i)
    next unless pull_request && value.match?(/\$\{\{\s*secrets\./)

    failures << "#{file}: pull_request workflows must not reference secrets"
    if value.match?(/\$\{\{\s*secrets\.[^}]*?(PROD|PRODUCTION|LIVE|SERVICE_ROLE|DATABASE|STRIPE|OPENAI|OPENROUTER|ANTHROPIC|CRON)/i)
      failures << "#{file}: privileged secret name found in pull_request workflow"
    end
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

    if pull_request && write_permission?(job['permissions'])
      failures << "#{file}: pull_request job #{job_name} must not have write permissions"
    end
    failures << "#{file}: job #{job_name} must declare timeout-minutes" unless job.key?('timeout-minutes')

    if job['uses']
      reference = job['uses'].to_s
      failures << "#{file}: reusable workflow is not pinned to an immutable reference: #{reference}" unless immutable_uses?(reference)
    end

    steps = job['steps']
    next unless steps.is_a?(Array)

    steps.each_with_index do |step, index|
      next unless step.is_a?(Hash) && step['uses']

      reference = step['uses'].to_s
      failures << "#{file}: action is not pinned to an immutable reference: #{reference}" unless immutable_uses?(reference)
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
