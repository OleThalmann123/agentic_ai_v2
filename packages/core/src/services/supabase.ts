import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Supabase URL oder Anon Key fehlen. Bitte VITE_SUPABASE_URL und VITE_SUPABASE_ANON_KEY in .env setzen.'
  );
}

// Auf Token-Login-Seiten (/t/:token) wird der access_token als x-access-token-Header
// mitgesendet, damit die RLS-Funktion current_assistant_id() den Scope einschränken kann.
function getTokenFromUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const m = window.location.pathname.match(/^\/t\/([^/?#]+)/);
  return m?.[1];
}

const _tokenFromUrl = getTokenFromUrl();

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-key',
  _tokenFromUrl ? { global: { headers: { 'x-access-token': _tokenFromUrl } } } : undefined
);
