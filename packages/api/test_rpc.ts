
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: '../../.env.local' });

function writeStdout(message: string) {
    process.stdout.write(`${message}\n`);
}

function writeStderr(message: string) {
    process.stderr.write(`${message}\n`);
}

async function test() {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        writeStderr('Missing env vars');
        process.exit(1);
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data: users, error: userError } = await supabase.from('profiles').select('id, credits').limit(1);

    if (userError) {
        writeStderr(`User fetch error: ${JSON.stringify(userError)}`);
        process.exit(1);
    }

    writeStdout(`User found: ${JSON.stringify(users?.[0] ?? null)}`);

    if (users?.[0]) {
        const { data, error } = await supabase.rpc('atomic_pre_deduct', {
            p_user_id: users[0].id,
            p_amount: 1,
            p_reason: 'Test pre-deduct from scratch script',
            p_request_id: '00000000-0000-0000-0000-000000000001'
        });
        writeStdout(`RPC result: ${JSON.stringify(data ?? null)}`);
        writeStdout(`RPC error: ${JSON.stringify(error ?? null)}`);
    } else {
        writeStdout('No users found in profiles table');
    }
}

test().catch(err => {
    writeStderr(`Test failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
});
