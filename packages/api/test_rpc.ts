
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: '../../.env.local' });

async function test() {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        console.error('Missing env vars');
        process.exit(1);
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data: users, error: userError } = await supabase.from('profiles').select('id, credits').limit(1);

    if (userError) {
        console.error('User fetch error:', userError);
        process.exit(1);
    }

    console.log('User found:', users?.[0]);

    if (users?.[0]) {
        const { data, error } = await supabase.rpc('atomic_pre_deduct', {
            p_user_id: users[0].id,
            p_amount: 1,
            p_reason: 'Test pre-deduct from scratch script',
            p_request_id: '00000000-0000-0000-0000-000000000001'
        });
        console.log('RPC result:', data);
        console.log('RPC error:', error);
    } else {
        console.log('No users found in profiles table');
    }
}

test().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
