import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function equalBytes(a:Uint8Array,b:Uint8Array){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;}
Deno.serve(async request=>{
 const url=Deno.env.get('SUPABASE_URL')??'',key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??Deno.env.get('SUPABASE_SECRET_KEY')??'';
 if(request.method==='GET'){
  const params=new URL(request.url).searchParams,verify=Deno.env.get('META_WEBHOOK_VERIFY_TOKEN')??'';
  if(params.get('hub.mode')==='subscribe'&&verify&&params.get('hub.verify_token')===verify)return new Response(params.get('hub.challenge')??'',{status:200});
  return new Response('Forbidden',{status:403});
 }
 if(request.method!=='POST')return new Response('Method not allowed',{status:405});
 const secret=Deno.env.get('META_APP_SECRET')??'',signature=request.headers.get('x-hub-signature-256')??'';
 if(!secret||!signature.startsWith('sha256='))return new Response('Unauthorized',{status:401});
 const raw=new Uint8Array(await request.arrayBuffer());const cryptoKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const digest=new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,raw));const expected='sha256='+Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
 if(!equalBytes(new TextEncoder().encode(expected),new TextEncoder().encode(signature)))return new Response('Unauthorized',{status:401});
 if(!url||!key)return json({error:'Webhook backend unavailable'},503);
 let payload:any;try{payload=JSON.parse(new TextDecoder().decode(raw));}catch{return new Response('Bad request',{status:400});}
 const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});const statuses=[];
 for(const entry of payload?.entry??[])for(const change of entry?.changes??[])for(const status of change?.value?.statuses??[])statuses.push(status);
 for(const status of statuses){const errorCode=Array.isArray(status.errors)?String(status.errors[0]?.code??'')||null:null;const {error}=await client.rpc('record_wellweb_whatsapp_delivery',{p_provider_message_id:String(status.id??''),p_status:String(status.status??''),p_error_code:errorCode});if(error)return json({error:'Delivery status could not be recorded'},503);}
 return json({received:true,count:statuses.length});
});
