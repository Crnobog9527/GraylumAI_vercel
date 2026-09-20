# Minimal secretless CI scope utility. Unknown or incomplete evidence runs full CI.
require 'json'
require 'open3'

module CIScope
  # Exact prose-only files, never directories/globs. New paths require review.
  DOCS = %w[README.md docs/ARCHITECTURE.md docs/PROJECT_MAP_FOR_OWNER.md docs/development/ci-efficiency.md].freeze
  SHA = /\A[0-9a-f]{40}\z/

  def self.git(*args)
    out, err, status = Open3.capture3('git', *args)
    raise "git evidence unavailable: #{args.first}" unless status.success?
    out
  end

  def self.commit(value)
    raise 'invalid exact commit' unless value.is_a?(String) && SHA.match?(value) && value != '0' * 40
    git('cat-file', '-e', "#{value}^{commit}")
    value
  end

  def self.classify(event_name, event)
    return 'full' unless %w[pull_request push].include?(event_name)
    if event_name == 'pull_request'
      base = commit(event.fetch('pull_request').fetch('base').fetch('sha'))
      head = commit(event.fetch('pull_request').fetch('head').fetch('sha'))
      event_base = base
      bases = git('merge-base', '--all', base, head).lines.map(&:strip)
      raise 'ambiguous merge base' unless bases.length == 1
      base = commit(bases.first)
      # A behind/diverged PR includes integration code not proved by prose-only
      # head changes. Require the event base to be an ancestor of the PR head.
      return 'full' unless base == event_base
      checkout = git('rev-parse', 'HEAD').strip
      unless checkout == head
        parents = git('show', '-s', '--format=%P', 'HEAD').strip.split(' ')
        return 'full' unless parents == [event_base, head]
        return 'full' unless git('diff', '--raw', head, checkout, '--').empty?
      end
    else
      base = commit(event.fetch('before'))
      head = commit(event.fetch('after'))
      return 'full' unless git('rev-parse', 'HEAD').strip == head
    end
    # --no-renames represents BOTH rename endpoints as deletion/addition. Raw -z
    # retains arbitrary filenames and old/new modes, with no path quoting/truncation.
    raw = git('diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', base, head, '--')
    return 'full' if raw.empty?
    fields = raw.split("\0", -1)
    raise 'unterminated diff' unless fields.pop == '' && fields.length.even?
    fields.each_slice(2) do |metadata, path|
      match = /\A:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([AMD])\z/.match(metadata)
      return 'full' unless match && DOCS.include?(path)
      modes = [match[1], match[2]]
      return 'full' unless (modes - %w[000000 100644]).empty? && modes.include?('100644')
      next if match[2] == '000000'
      content = git('show', "#{head}:#{path}").force_encoding(Encoding::UTF_8)
      raise 'invalid documentation encoding/content' unless content.valid_encoding? && !content.include?("\0") && !content.strip.empty?
    end
    'docs'
  rescue KeyError, TypeError, NoMethodError, RuntimeError, ArgumentError
    'full'
  end
end

if $PROGRAM_NAME == __FILE__
  mode = begin
    CIScope.classify(ENV.fetch('GITHUB_EVENT_NAME'), JSON.parse(File.binread(ENV.fetch('GITHUB_EVENT_PATH'))))
  rescue StandardError
    'full'
  end
  puts "CI scope: #{mode}"
  File.open(ENV.fetch('GITHUB_OUTPUT'), 'a') { |file| file.puts "mode=#{mode}" }
end
