import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };
const json = (body: unknown, status=200) => new Response(JSON.stringify(body), { status, headers:cors });
Deno.serve(async (req) => {
  if (req.method==='OPTIONS') return new Response('ok',{headers:cors});
  if (req.method!=='POST') return json({error:'Method not allowed'},405);
  const length=Number(req.headers.get('content-length')??0); if(length>8192)return json({error:'Invalid request'},413);
  let body:Record<string,unknown>; try { body=await req.json(); } catch { return json({error:'Invalid request'},400); }
  if (JSON.stringify(body).length>8192 || typeof body.token!=='string' || !/^[a-f0-9]{64}$/.test(body.token)) return json({error:'Link indisponível.'},400);
  const url=Deno.env.get('SUPABASE_URL');
  const legacyKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  let secretKey:string|undefined;
  try {
    const secretKeys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')??'{}');
    if(typeof secretKeys.default==='string')secretKey=secretKeys.default;
  } catch { /* Ignore malformed optional key bundle; report only its presence below. */ }
  const key=legacyKey||secretKey;
  if(!url||!key){
    console.error('guest-reviews missing Supabase runtime configuration',{hasSupabaseUrl:Boolean(url),hasLegacyServiceRoleKey:Boolean(legacyKey),hasSecretKeys:Boolean(Deno.env.get('SUPABASE_SECRET_KEYS'))});
    return json({error:'Serviço temporariamente indisponível.'},503);
  }
  const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const ip=req.headers.get('cf-connecting-ip')?.trim()||req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||null;
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body.token));
  const tokenHash=[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
  if(body.action==='context'){
    const {data,error}=await client.rpc('get_guest_professional_review_context',{p_token_hash:tokenHash,p_source_ip:ip});
    if(error){console.error('guest-reviews context RPC failed',{code:error.code,message:error.message});return json({available:false,code:'BACKEND_ERROR'},200);} return json(data??{available:false});
  }
  if(body.action!=='submit'||typeof body.requestId!=='string'||!/^[-a-f0-9]{36}$/i.test(body.requestId)||!Number.isInteger(body.rating)||Number(body.rating)<1||Number(body.rating)>5||typeof body.comment!=='string'||body.comment.length>500) return json({ok:false,code:'INVALID_INPUT'},400);
  const {data,error}=await client.rpc('submit_guest_professional_review',{p_token_hash:tokenHash,p_request_id:body.requestId,p_rating:body.rating,p_comment:body.comment,p_source_ip:ip});
  if(error){console.error('guest-reviews submit RPC failed',{code:error.code,message:error.message});return json({ok:false,code:'BACKEND_ERROR'},200);} return json(data??{ok:false,code:'UNAVAILABLE'});
});
