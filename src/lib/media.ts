import { supabase } from './supabase';

export const PROFILE_MEDIA_BUCKET = 'wellweb-public-media';
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxBytes = 10 * 1024 * 1024;

export async function uploadProfileImage(file: File, accountType: 'HOTEL' | 'PROFESSIONAL') {
  if (!supabase) throw new Error('O armazenamento de imagens não está configurado.');
  if (!allowedTypes.has(file.type)) throw new Error('Escolhe uma imagem JPG, PNG ou WebP.');
  if (file.size > maxBytes) throw new Error('Cada imagem deve ter no máximo 10 MB.');

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) throw new Error('Inicia sessão novamente para carregar imagens.');
  const extension = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/png' ? 'png' : 'webp';
  const kind = accountType === 'HOTEL' ? 'hotels' : 'professionals';
  const path = `${kind}/${user.id}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from(PROFILE_MEDIA_BUCKET).upload(path, file, {
    cacheControl: '3600',
    contentType: file.type,
    upsert: false,
  });
  if (error) throw error;
  return path;
}

export function publicImageUrl(path: string | null | undefined) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return supabase?.storage.from(PROFILE_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl ?? null;
}
