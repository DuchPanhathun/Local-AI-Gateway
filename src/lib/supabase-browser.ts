import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Supabase in the browser, for signing up and in on /account and the console.
// The URL and anon key are public by design (Next.js builds them into the
// page); the service role key never comes here (lib/supabase.ts). Null when
// accounts aren't set up.

let client: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  client ??= createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}
