import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logServerError } from '@/lib/server-log';
import { uploadWithIntent } from './upload-intent';

async function isMaintenanceModeEnabled(supabaseAdmin: any) {
  const { data, error } = await supabaseAdmin
    .from('system_settings')
    .select('value')
    .eq('key', 'maintenance_mode')
    .maybeSingle();

  if (error) {
    logServerError('system', 'upload_maintenance_mode_read_failed', {
      code: error.code,
    });
    return true;
  }

  const value = data && typeof data === 'object' && 'value' in data ? data.value : null;
  return value === true || value === 'true';
}

export async function POST(request: NextRequest) {
  try {
    // Get auth token from header
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseServiceRoleKey) {
      return NextResponse.json({ error: 'Upload service is not configured' }, { status: 503 });
    }
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Verify user
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role, status')
      .eq('id', user.id)
      .maybeSingle();

    // Closed, disabled or banned accounts must not create storage objects.
    if (profileError || !profile) {
      return NextResponse.json({ error: '账号状态暂时无法验证，请稍后重试' }, { status: 503 });
    }
    if (profile.status !== 'active') {
      return NextResponse.json({ error: '当前账号不能上传附件' }, { status: 403 });
    }

    const maintenanceModeEnabled = await isMaintenanceModeEnabled(supabaseAdmin);

    if (maintenanceModeEnabled) {
      if (profile.role !== 'admin') {
        return NextResponse.json(
          { error: '系统维护中，暂时无法上传附件' },
          { status: 503 }
        );
      }
    }

    // Parse form data
    const formData = await request.formData();
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ error: 'Invalid file type. Only images are allowed.' }, { status: 400 });
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: 'File too large. Max 5MB allowed.' }, { status: 400 });
    }

    // Convert File to ArrayBuffer then to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const uploaded = await uploadWithIntent({ client: supabaseAdmin, profileId: user.id, mime: file.type, body: buffer });
    return NextResponse.json(uploaded.status === 200 ? { path: uploaded.path } : { error: uploaded.error }, { status: uploaded.status });
  } catch {
    logServerError('api', 'upload_handler_failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
