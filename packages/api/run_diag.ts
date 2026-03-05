
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { DiagnosticsService } from './src/services/diagnostics';

dotenv.config({ path: '../../.env.local' });

async function runDiagnostics() {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const userId = '59410ee2-d995-414a-b330-a503a4e0ba6b'; // Active user from profiles table

    if (!supabaseUrl || !supabaseKey) {
        console.error('Missing env vars');
        process.exit(1);
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const service = new DiagnosticsService({
        supabase: supabase as any,
        userId,
        runType: 'manual'
    });

    console.log('Running all diagnostic tests...');
    const result = await service.runAllTests();

    console.log('\n--- DIAGNOSTIC RESULTS ---');
    console.log(`Summary: ${result.summary.passed}/${result.summary.total} passed`);

    result.results.forEach(r => {
        console.log(`[${r.status.toUpperCase()}] ${r.testName}: ${r.message}`);
        if (r.status === 'failed' || r.status === 'error' || r.testId === 'ai_model_status') {
            console.log('Details:', JSON.stringify(r.details, null, 2));
        }
    });
}

runDiagnostics().catch(err => {
    console.error('Diagnostics failed:', err);
    process.exit(1);
});
