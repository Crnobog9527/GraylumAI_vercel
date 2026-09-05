#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const LEGAL_MIGRATION_FILENAME = /^(?<number>\d{4})_(?<name>[A-Za-z0-9][A-Za-z0-9._-]*)\.sql$/;
const POST_BASELINE_START = 48;
const REQUIRED_POST_BASELINE_HIGHEST = 63;

// These two already-applied migrations predate the ledger rule and must remain
// byte-for-byte untouched. No other duplicate number is permitted.
const HISTORICAL_DUPLICATE_ALLOWLIST = new Map([
  ['0018', new Set([
    '0018_payment_fulfillment_atomicity.sql',
    '0018_rls_text_flags_and_job_runs.sql',
  ])],
]);

const FROZEN_MIGRATION_HASHES = new Map([
  ['0001_ai_billing_tables.sql', 'e951b7cba65eda65cc5297e55a1de87c2828be3a1d4bcb41a7c7553b7a0e575c'],
  ['0002_enable_rls_all_tables.sql', '4076a65db5b320468ec77a5bfbbcfe55f44a8395b5b06e70f1f2898e84d09a00'],
  ['0003_atomic_billing_rpc.sql', '228f530399f421da727dfde62c1d7725891faafdf95de32c41a11b26ec2cd1a5'],
  ['0004_recursive_summary_and_soft_delete.sql', 'b7c8dd9bf478888ee6bdee07dbb69d0aa2dc44c4d365106fc0dee286d7d8de99'],
  ['0005_diagnostics.sql', '44f15021b056219c49f93dea23da1cb2933cbae0d35cc8e08e698d3f93532d52'],
  ['0006_application_logs.sql', '134350bdce1decd74f5bc27eb4d4113183395bc77e75e9234fcb948c7aa71d96'],
  ['0007_performance_indexes.sql', 'f926f7d72674568d4b1c90644ff44309237d8bf4544b0c903281bb23de980919'],
  ['0008_modules_schema_update.sql', '0482ee27b8d3ac3da485e36084382631f16dfb6539ceb0fc9d3950b49f239531'],
  ['0009_context_length_limit.sql', '2f6cfbd4edecefef89ae808995dbbbc50a1bc652c7e874ca948440801b63e232'],
  ['0010_ticket_auto_close_supabase_cron.sql', 'e63dc44cc0d9aedd2a3077ea09f83d086188d757a5239fb796a554cbdb6db9e2'],
  ['0011_public_maintenance_mode.sql', '1270f36e46cbe098a5e91c7f6f7dd276ed0f4feab87763c26043d60f76faddcc'],
  ['0012_stripe_payments.sql', '560fa73fbda9635e305785cbbf556169780ca0eea80c70b36173061b1af8c06b'],
  ['0013_checkin_rewards.sql', '9a1e219e26145efff03b5adfbad2477de6f9e9eb8a60d1431aed135d263d3f54'],
  ['0014_ai_runtime_closure.sql', 'bbf74d91974f2ec7fe23ec0fba0985e109892159dee4b946fc1a8f435db0fa8a'],
  ['0015_security_advisor_hardening.sql', '2a941c961780ce351d220bfd6db1705edf33f899891ce0ea8f7eed79c8031a76'],
  ['0016_live_db_drift_security_cleanup.sql', '3840d14944e1c653914f7e253dc451587e30494bbcffd34d9c4eb065f3d6a486'],
  ['0017_scheduled_job_runs.sql', 'b18d2f1274f9c5127d55ae2ac2b7328d3d12481464cac0421520935d802a65bc'],
  ['0018_payment_fulfillment_atomicity.sql', '494d1f5b55d3a0cb2e7a1bdf291870bd402db36a9ff5abf15700f982c4245fd8'],
  ['0018_rls_text_flags_and_job_runs.sql', 'e8e4e3bd5aaf4ecec634229de40a8a591e8a31e7c693b59eb69f82f61a6fb0da'],
  ['0019_public_route_rls_hardening.sql', '1e7815f34b99498866a0b88b8280a6d6316e9ae2c06523e7849add4443c0eebf'],
  ['0020_admin_query_indexes.sql', 'f945cd5fa6b63e1904beb2c9ed70ea8f94dcc35ed3d7d654026ce4a2df2d3703'],
  ['0021_supabase_security_advisor_cleanup.sql', '8bef69889dd2ad7e6f56cec130ff2cfc90773fd1a3845f8e57c90d49ad89f597'],
  ['0022_openrouter_claude_provider_default.sql', '897d03339f7c9330dd6cc90325d6563101812b411a49ee6952c6311c2b9a7f87'],
  ['0023_ai_settle_pricing_metadata.sql', '0c0e4e4ca620422e9809a4722be6f7a7167663782fcd9ec49a1098fa1892af86'],
  ['0024_atomic_apply_credit_ledger_entry.sql', 'a29159f74126562484c388e3b321cc4cf34613c5cd3f32870cb8f9cc2d8fb429'],
  ['0025_atomic_claim_invitation_code.sql', 'c10ddafacb39a9473d73e8fb532d61046f5655d97da04b427cd1394bbe5913f0'],
  ['0026_atomic_apply_invitation_rebate.sql', '4f6e97b90c74f8d2da63899b46d5c03d31af7a893e5d58721b32219195701def'],
  ['0027_balance_write_surface_lockdown.sql', 'dbe8384eeb7997375c2a2b661dc496d1287bcc5bc6059e8d6e89a349bb433c00'],
  ['0028_restore_staging_helper_functions.sql', '2bebcf285208c53931fd4e93103dab4829e034b08699dc268809709bbe174d79'],
  ['0029_client_role_non_dml_grant_hardening.sql', 'd76c6832922284bbbe2dd7f0812ce20aab776a6efe88fe525e7b09eeef4c36ca'],
  ['0030_privileged_rpc_execute_posture.sql', 'b4ca6975fa7e648415a6a0440d3e57b2f0839893f191cc26f0f901373d4d7276'],
  ['0031_validate_invitation_code_posture.sql', 'b6346512f48fce75bfba4939f1c7fd83fb2251c718f865b47d49717e454856b8'],
  ['0032_admin_policy_shape_reconciliation.sql', '18bfa12292335c8b51207f35ae2e5dbf37c1e1650ce10b81364dd1670c1f4edf'],
  ['0033_package_config_admin_write_posture.sql', '0be791d014f11871d3847be3b7bc960b7327de873c1147918de359994b0bd8bc'],
  ['0034_staging_checkout_runtime_grants.sql', '60a7d6a385d0be9e3a2fdfaa67f601df3f92f58b0f75140bf8799d48dadee752'],
  ['0035_fix_payment_fulfillment_rpc_ambiguity.sql', '5f1ca2a4c8c36669f4269c5b164a997ba9fab7100dc3323ace7671bec9ed1fb2'],
  ['0036_public_module_display_fields.sql', '672e36ad505b4f32dc7b977bce0d5f8c683fed0acad280e8b910e1be28ef27dc'],
  ['0037_preserve_subscription_status_on_invoice_fulfillment.sql', '5e74b8f347221e9ee3d84c92e8828d8f6c7556191bffb4ca59bfdeedb0cc060a'],
  ['0038_normalize_module_boolean_flags.sql', 'bcb66233ddc2708bb603a64ec17524ac89e4668bde81a2fb8c0b6e51306c183e'],
  ['0039_normalize_module_policy_shape.sql', '3dd6747f873f1151bdd60f2f6651e80b69f2499e8b231375cb8a021e293875ae'],
  ['0040_reconcile_module_public_grants.sql', '9e428e558be081a81928b9fa7e91fdb2ea5dfb15bdccbba16e8e0a5fe9a552e0'],
  ['0041_stripe_refund_reconciliation.sql', 'ac1d29419c23c40fd7794b9344794c3451e16d6b7b8ef022f6fa5fa4560ad611'],
  ['0042_canceled_subscription_profile_downgrade.sql', '0686c126a547d0f86bbece5edd3e05b117cb783227d034d1ba4d0d4469b03f02'],
  ['0043_payment_order_status_machine.sql', '15c8798612e53e76c6a9da96e233b0a93c495c60a6146496d42c27a5671cc90d'],
  ['0044_credit_transactions_v2_semantics.sql', 'e5dcaa1114ef7cec3071f8713f9d2c10c371b2760154e66d03b27e9ed0e66401'],
  ['0045_subscription_credit_grants.sql', '4c627ac0a2b124428840c2221bdfa32745b2d260d3f23d5bf87c73b417354039'],
  ['0046_profile_bootstrap_service_role_grants.sql', '3ee3d7d0d80951d78151bd4881d26166134f0c03b6464e626997b1ffcbd4bddb'],
  ['0047_subscription_fulfillment_service_role_grants.sql', '1b3c8bd65a67652194bbcdb5199cdf9f0a13c160491b93d430fa45eac1e05cb8'],
  ['0048_restore_staging_baseline_objects.sql', '8cdd968b60bd581f9311c4e9f7466d5a5a7117fdc09dc160a9bec3aa281b8c7b'],
  ['0049_reconcile_stg_fix_target_grants.sql', '7ef35d2efd2d87812d74a1764cb08755d4c67aa418393437aa2e0251c0178b6a'],
  ['0050_sec1_privileged_rpc_execute_posture_closure.sql', 'b9a48d341e410999d1af532a57bd883278939f87b2e0717b40e8fb70b1127095'],
  ['0051_auth_opening_grant_profile_defaults.sql', '53eda27ac246c8cf9622cfcc10e0f6a0a5766365e5e77b1013da0b826650dcf7'],
  ['0052_year1_annual_calendar_period_keys.sql', ['cd6204cc2d841623', '249c1a836a4ab0e593b0f4b7e75613b75735e13768f53fd3'].join('')],
  ['0053_refund_1b_consumed_amount_termination.sql', 'ab9440499a10f7315227c34c20881acfcaef8ef89aee1fa011f84ae060fab359'],
  ['0054_refund_1b_profiles_column_contract_repair.sql', '5cb00742ac7da4789235a31b38fefcdcd21b60693a8b451bf5afcd86bb7258b5'],
  ['0055_refund_1b_invoice_rpc_credits_granted_ambiguity_repair.sql', '8bf8f0f3746e451164ca4b4b75e0f2920d32b4efaae6fedf0ba1b3a79852a62f'],
  ['0056_refund_1b_service_role_select_contract_repair.sql', 'fb382ed6067acda63c4bdfb6d38bc8ac65adfe875fcc32d0745697ae548ee3b4'],
  ['0057_refund_1b_actual_refund_accounting_repair.sql', 'af4e5f8d5faad31c111b0600257095454f54617cee5f519007c0d89573bd1f18'],
  ['0058_refund_1b_canonical_metadata_merge_repair.sql', '71fe5650985b6ec2458b8a18a9644cdec6b760703c76be589e33b18ba90e52a0'],
  ['0059_refund_1b_failure_period_metadata_repair.sql', 'a45083073b8ed20da3dbe587e5d8192e18ea4d58834f7e9ef370886cd4de80aa'],
  ['0060_refund_1b_post_merge_forward_repair.sql', 'bf8e45743ddf84fb2e4737cb3960e558497e805fbd77a28c9fa54c180eb83c58'],
  ['0061_refund_1b_expired_quarantine_repair.sql', 'a6275bc4b78529985bbe0dbfca85fb8ef17b652cec697672d06127da749d297d'],
  ['0062_skill_1a_db_publish_contract.sql', 'd3bb64c7aa037176023cab579bb7ea3ac9399b425891cf80d10ec26b76c481c8'],
  ['0063_bill_1_reconciliation_select_contract.sql', 'bf6edeffeb6c858f15454674bd73fb01fc25ea08d0f2f559da08159d8cdd6694'],
]);

export async function checkMigrationLedger(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrationsByNumber = new Map();
  const errors = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.sql')) continue;

    const match = LEGAL_MIGRATION_FILENAME.exec(entry.name);
    if (!match?.groups) {
      errors.push(`Malformed migration filename: ${entry.name}`);
      continue;
    }

    const files = migrationsByNumber.get(match.groups.number) ?? [];
    files.push(entry.name);
    migrationsByNumber.set(match.groups.number, files);
  }

  for (const [number, files] of migrationsByNumber) {
    if (files.length < 2) continue;

    const allowlisted = HISTORICAL_DUPLICATE_ALLOWLIST.get(number);
    const isExactHistoricalPair = allowlisted
      && files.length === allowlisted.size
      && files.every((file) => allowlisted.has(file));
    if (!isExactHistoricalPair) {
      errors.push(`Duplicate migration number ${number}: ${files.sort().join(', ')}`);
    }
  }

  for (const [file, expectedHash] of FROZEN_MIGRATION_HASHES) {
    let contents;
    try {
      contents = await readFile(path.join(directory, file));
    } catch {
      errors.push(`Missing frozen migration: ${file}`);
      continue;
    }

    const actualHash = createHash('sha256').update(contents).digest('hex');
    if (actualHash !== expectedHash) {
      errors.push(`Modified frozen migration: ${file}`);
    }
  }

  const postBaselineNumbers = [...migrationsByNumber.keys()]
    .map(Number)
    .filter((number) => number >= POST_BASELINE_START)
    .sort((left, right) => left - right);

  const highestNumber = Math.max(postBaselineNumbers.at(-1) ?? 0, REQUIRED_POST_BASELINE_HIGHEST);
  for (let number = POST_BASELINE_START; number <= highestNumber; number += 1) {
    const paddedNumber = String(number).padStart(4, '0');
    if (!migrationsByNumber.has(paddedNumber)) {
      errors.push(`Missing post-baseline migration number ${paddedNumber}`);
    }
  }

  return errors;
}

async function main() {
  const directory = path.resolve(process.argv[2] ?? 'packages/db/migrations');
  let errors;
  try {
    errors = await checkMigrationLedger(directory);
  } catch (error) {
    console.error(`Migration ledger check could not inspect the migration directory: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`Migration ledger check failed: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('Migration ledger check passed.');
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) await main();
