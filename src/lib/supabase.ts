import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
const isConfigured = Boolean(url && key && !url.includes('YOUR_') && !key.includes('YOUR_'));

function isLoopbackUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

// Hosted projects require an explicit deployment opt-in. This also keeps local
// builds and Vite preview safe when a developer's ignored .env.local is stale.
const hostedProjectAllowed = import.meta.env.PROD && import.meta.env.VITE_SUPABASE_ENV === 'production';
const hostedProjectBlocked = Boolean(url) && !isLoopbackUrl(url) && !hostedProjectAllowed;

export const supabaseConfigurationMessage = !isConfigured
  ? 'Configura o Supabase local em .env.local para ativar autenticação.'
  : hostedProjectBlocked
    ? 'O ambiente local está apontado para um projeto remoto. A autenticação foi bloqueada por segurança; usa o Supabase local.'
    : null;

export const supabase = isConfigured && !hostedProjectBlocked
  ? createClient(url!, key!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export const isSupabaseConfigured = Boolean(supabase);
