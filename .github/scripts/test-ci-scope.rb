require 'minitest/autorun'
require 'tmpdir'
require 'fileutils'
require_relative 'ci-scope'

class CIScopeTest < Minitest::Test
  def setup
    @previous = Dir.pwd
    @dir = Dir.mktmpdir('ci-scope-')
    Dir.chdir(@dir)
    git('init', '-q'); git('config', 'user.name', 'CI fixture'); git('config', 'user.email', 'fixture@example.invalid')
    write('README.md', "Initial prose\n"); write('app.js', 'code'); write('docs/ARCHITECTURE.md', 'architecture')
    @base = save
  end
  def teardown
    Dir.chdir(@previous); FileUtils.remove_entry(@dir)
  end
  def git(*args); CIScope.git(*args); end
  def write(path, text)
    FileUtils.mkdir_p(File.dirname(path)); File.binwrite(path, text)
  end
  def save
    git('add', '-A'); git('commit', '-qm', 'fixture'); git('rev-parse', 'HEAD').strip
  end
  def mode(base = @base, head = save)
    CIScope.classify('pull_request', {'pull_request'=>{'base'=>{'sha'=>base}, 'head'=>{'sha'=>head}}})
  end
  def test_allowlisted_prose
    write('README.md', 'New prose'); assert_equal 'docs', mode
  end
  def test_push_exact_hashes
    write('README.md', 'New prose'); head=save
    assert_equal 'docs', CIScope.classify('push', {'before'=>@base, 'after'=>head})
  end
  def test_mixed_code
    write('README.md', 'New prose'); write('app.js', 'new code'); assert_equal 'full', mode
  end
  def test_governance_skills_configuration_unknown_and_weird_paths
    %W[AGENTS.md docs/AGENTS.md docs/launch/plan-core.md .agents/skills/test/SKILL.md package.json .github/scripts/ci-scope.rb docs/new.md docs/a\nb.md docs/a\tb.md].each do |path|
      git('reset', '--hard', @base); git('clean', '-fd'); write(path, 'text'); assert_equal 'full', mode, path.inspect
    end
  end
  def test_new_allowlisted_document
    write('docs/PROJECT_MAP_FOR_OWNER.md', 'Owner overview'); assert_equal 'docs', mode
  end
  def test_old_executable_mode_cannot_be_hidden
    File.chmod(0755, 'README.md'); base=save
    File.chmod(0644, 'README.md'); assert_equal 'full', mode(base)
  end
  def test_deletion
    File.unlink('README.md'); assert_equal 'docs', mode
  end
  def test_rename_from_executable_to_documentation
    write('script.sh', 'text'); File.chmod(0755, 'script.sh'); base=save
    File.unlink('README.md'); File.rename('script.sh', 'README.md'); File.chmod(0644, 'README.md')
    assert_equal 'full', mode(base)
  end
  def test_rename_from_unknown_regular_file
    write('unknown.txt', 'text'); base=save
    File.unlink('README.md'); File.rename('unknown.txt', 'README.md'); assert_equal 'full', mode(base)
  end
  def test_rename_to_unknown_file
    File.rename('README.md', 'other.md'); assert_equal 'full', mode
  end
  def test_executable_mode_and_symlink
    File.chmod(0755, 'README.md'); assert_equal 'full', mode
    git('reset', '--hard', @base); File.unlink('README.md'); File.symlink('app.js', 'README.md'); assert_equal 'full', mode
  end
  def test_bad_content
    ["\xFF".b, "a\0b", " \n"].each do |content|
      git('reset', '--hard', @base); write('README.md', content); assert_equal 'full', mode
    end
  end
  def test_malformed_missing_and_unknown_event
    [nil, {}, {'pull_request'=>{}}, {'pull_request'=>{'base'=>{'sha'=>'0'*40}, 'head'=>{'sha'=>@base}}}].each do |event|
      assert_equal 'full', CIScope.classify('pull_request', event)
    end
    assert_equal 'full', CIScope.classify('push', {'before'=>'f'*40, 'after'=>@base})
    assert_equal 'full', CIScope.classify('schedule', {})
    assert_equal 'full', CIScope.classify('workflow_dispatch', {})
  end
  def test_detached_diverged_pr_requires_full_integration_validation
    write('app.js', 'base advanced'); advanced=save
    git('checkout', '--detach', @base); write('README.md', 'PR prose')
    assert_equal 'full', mode(advanced)
  end
  def test_diverged_pr_retains_earlier_code_change
    write('README.md', 'base prose'); advanced=save
    git('checkout', '--detach', @base); write('app.js', 'PR code'); save; write('README.md', 'PR prose')
    assert_equal 'full', mode(advanced)
  end
  def test_exact_synthetic_merge_checkout
    write('README.md', 'PR prose'); head=save
    git('checkout', '--detach', @base); git('merge', '--no-ff', '-m', 'integration', head)
    assert_equal 'docs', mode(@base, head)
    write('app.js', 'unexpected integration change'); save
    assert_equal 'full', mode(@base, head)
  end
  def test_checkout_mismatch
    write('README.md', 'PR prose'); head=save; git('checkout', '--detach', @base)
    assert_equal 'full', mode(@base, head)
    assert_equal 'full', CIScope.classify('push', {'before'=>@base, 'after'=>head})
  end
  def test_empty_diff
    assert_equal 'full', mode(@base, @base)
  end
end
