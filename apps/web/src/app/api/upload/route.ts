import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logServerError } from '@/lib/server-log';

const TICKET_ATTACHMENT_BUCKET = 'ticket-attachments';

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

    const maintenanceModeEnabled = await isMaintenanceModeEnabled(supabaseAdmin);

    if (maintenanceModeEnabled) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();

      if (profile?.role !== 'admin') {
        return NextResponse.json(
          { error: '系统维护中，暂时无法上传附件' },
          { status: 503 }
        );
      }
    }

    // Parse form data
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
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

    // Generate unique filename
    const timestamp = Date.now();
    const ext = file.name.split('.').pop() || 'jpg';
    const fileName = `${user.id}/${timestamp}-${Math.random().toString(36).substring(7)}.${ext}`;

    // Convert File to ArrayBuffer then to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from(TICKET_ATTACHMENT_BUCKET)
      .upload(fileName, buffer, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      logServerError('api', 'upload_storage_failed', {
        errorName: uploadError.name,
      });
      // If bucket doesn't exist, try to create it (first time setup)
      if (uploadError.message?.includes('not found') || uploadError.message?.includes('does not exist')) {
        // Try creating the bucket
        const { error: createBucketError } = await supabaseAdmin.storage.createBucket(TICKET_ATTACHMENT_BUCKET, {
          public: false,
          fileSizeLimit: 5 * 1024 * 1024, // 5MB
          allowedMimeTypes: allowedTypes,
        });

        if (createBucketError && !createBucketError.message?.includes('already exists')) {
          logServerError('api', 'upload_bucket_create_failed', {
            errorName: createBucketError.name,
          });
          return NextResponse.json({ error: 'Storage not configured. Please contact support.' }, { status: 500 });
        }

        // Retry upload
        const { data: retryData, error: retryError } = await supabaseAdmin.storage
          .from(TICKET_ATTACHMENT_BUCKET)
          .upload(fileName, buffer, {
            contentType: file.type,
            upsert: false,
          });

        if (retryError) {
          logServerError('api', 'upload_retry_failed', {
            errorName: retryError.name,
          });
          return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 });
        }

        return NextResponse.json({ path: retryData.path });
      }

      return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 });
    }

    return NextResponse.json({ path: uploadData.path });
  } catch {
    logServerError('api', 'upload_handler_failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
