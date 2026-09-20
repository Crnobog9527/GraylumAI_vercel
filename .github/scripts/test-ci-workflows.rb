require 'minitest/autorun'
require 'yaml'
require 'open3'

class CIWorkflowsTest < Minitest::Test
  ROOT = File.expand_path('..', __dir__)
  def setup
    @ci = YAML.safe_load(File.read("#{ROOT}/workflows/ci.yml"))
    @security = YAML.safe_load(File.read("#{ROOT}/workflows/security.yml"))
  end
  GATES = {'lint-check'=>['Lint & Type Check','lint-and-type'], 'typecheck'=>['TypeScript Check','lint-and-type'],
           'unit-check'=>['Unit Tests','test'], 'security-unit-tests'=>['Security Unit Tests','test'],
           'build'=>['Build Check','build-and-e2e'], 'security-e2e-tests'=>['Security E2E Tests','build-and-e2e']}.freeze
  def test_required_context_names_unique
    names = [@ci, @security].flat_map { |w| w.fetch('jobs').values.map { |j| j.fetch('name') } }
    (GATES.values.map(&:first) + ['Dependency Audit','Code Security Scan','Workflow Policy Check','Secret Scan']).each do |name|
      assert_equal 1, names.count(name), name
    end
  end
  def test_gate_real_shell_truth_table_and_needs_contract
    GATES.each do |id, (name, worker)|
      job=@ci.fetch('jobs').fetch(id)
      assert_equal name, job.fetch('name'); assert_equal 'always()', job.fetch('if')
      assert_equal ['scope',worker], job.fetch('needs')
      assert_equal 1, job.fetch('steps').length
      step=job['steps'].first
      assert_equal({'SCOPE_RESULT'=>'${{ needs.scope.result }}', 'SCOPE_MODE'=>'${{ needs.scope.outputs.mode }}',
                    'WORK_RESULT'=>"${{ needs.#{worker}.result }}"}, step.fetch('env'))
      %w[success failure cancelled skipped].product(['full','docs','', 'invalid'], %w[success failure cancelled skipped]).each do |scope, mode, result|
        _,_,status=Open3.capture3({'SCOPE_RESULT'=>scope, 'SCOPE_MODE'=>mode,'WORK_RESULT'=>result},'bash','-c',step.fetch('run'))
        expected=scope=='success' && ((mode=='full' && result=='success') || (mode=='docs' && result=='skipped'))
        assert_equal expected,status.success?,"#{id}: #{[scope,mode,result].inspect}"
      end
      work=@ci['jobs'].fetch(worker)
      assert_equal ['scope'], work.fetch('needs')
      assert_equal "needs.scope.outputs.mode == 'full'", work.fetch('if')
      refute work.key?('continue-on-error')
    end
  end
  def test_scans_always_and_no_event_path_filters
    %w[audit workflow-policy secret-scan code-scan].each do |id|
      job=@security['jobs'].fetch(id); refute job.key?('if'); refute job.key?('needs')
    end
    [@ci,@security].each do |workflow|
      events=workflow['on'] || workflow[true]
      %w[pull_request push].each do |event|
        assert_equal ['branches'], events.fetch(event).keys
        assert_includes events[event]['branches'], 'staging'
      end
      assert_equal [{'cron'=>'0 9 * * 1'}], events.fetch('schedule')
    end
  end
  def test_expensive_commands_not_duplicated_and_regressions_retained
    runs=[@ci,@security].flat_map { |w| w['jobs'].values.flat_map { |j| j['steps'].map { |s| s['run'] }.compact } }
    %w[pnpm\ build pnpm\ --filter\ web\ typecheck pnpm\ test:api].each { |command| assert_equal 1,runs.count(command),command }
    refute_includes runs, 'pnpm --filter @repo/api test:run'
    %w[auth-bootstrap checkout-cancellation pay-1-frontend skill-runtime year-calendar refund-race billing-cron proxy-hostname safeguards].each do |suite|
      assert_includes runs, "pnpm test:ci:#{suite}"
    end
    assert_equal 'true', @ci['jobs']['build-and-e2e']['env']['SECURITY_E2E_LOCAL_ONLY']
    assert_equal 'false', @ci['jobs']['build-and-e2e']['env']['E2E_ALLOW_DATABASE_FIXTURES']
  end
end
