import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  // In a real environment, these must be set. 
  // For the public repo, we use placeholders to allow the code to be reviewed.
}

export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-key',
  { auth: { autoRefreshToken: false, persistSession: false } }
);
