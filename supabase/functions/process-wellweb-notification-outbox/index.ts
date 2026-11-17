import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
type Item={id:string;channel:'EMAIL'|'WHATSAPP';event_type:string;title:string;body:string;email:string;display_name:string;account_type:string;phone_e164:string|null;booking_reference:string;starts_at:string;attempts:number};
async function sendSmtp(to:string,subject:string,text:string,html:string){
 const host=Deno.env.get('WELLWEB_LOCAL_SMTP_HOST')??'supabase_inbucket_wellweb-mvp-local-only',port=Number(Deno.env.get('WELLWEB_LOCAL_SMTP_PORT')??'1025'),from=Deno.env.get('WELLWEB_MAIL_FROM')??'WellWeb <no-reply@localhost>';
 const conn=await Deno.connect({hostname:host,port});const enc=new TextEncoder(),dec=new TextDecoder();let buffer='';
 const read=async()=>{while(true){const b=new Uint8Array(2048),n=await conn.read(b);if(n===null)throw new Error('SMTP_CONNECTION_CLOSED');buffer+=dec.decode(b.subarray(0,n));const lines=buffer.split('\r\n'),i=lines.findIndex(x=>/^\d{3} /.test(x));if(i>=0){const last=lines[i];buffer=lines.slice(i+1).join('\r\n');if(!/^[23]\d\d[ -]/.test(last))throw new Error('SMTP_REJECTED');return;}}};
 const cmd=async(s:string)=>{await conn.write(enc.encode(s+'\r\n'));await read();};
 try{await read();await cmd('EHLO wellweb.local');await cmd(`MAIL FROM:<${from.match(/<([^>]+)>/)?.[1]??from}>`);await cmd(`RCPT TO:<${to}>`);await cmd('DATA');const body=`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="ww-boundary"\r\n\r\n--ww-boundary\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}\r\n--ww-boundary\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--ww-boundary--\r\n.`;await conn.write(enc.encode(body+'\r\n'));await read();await cmd('QUIT');}finally{conn.close();}
}
function templateName(item:Item){const suffix=item.account_type==='PROFESSIONAL'?'PROFESSIONAL':'HOTEL';return Deno.env.get(`META_TEMPLATE_${item.event_type}_${suffix}`)??Deno.env.get(`META_TEMPLATE_${item.event_type}`)??'';}
Deno.serve(async request=>{
 if(request.method!=='POST')return json({error:'Method not allowed'},405);
 const url=Deno.env.get('SUPABASE_URL')??'',key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??Deno.env.get('SUPABASE_SECRET_KEY')??'';
 if(!url||!key)return json({error:'Worker backend is not configured'},503);
 const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 try{
  const {data:rows,error}=await client.rpc('claim_wellweb_notification_outbox',{p_batch_size:25});if(error)return json({error:'Outbox claim failed'},503);
  let processed=0;
  for(const item of (rows??[]) as Item[]){
   try{
    if(item.channel==='EMAIL'){
      if(!item.email){await client.rpc('finish_wellweb_notification_outbox',{p_outbox_id:item.id,p_status:'SKIPPED',p_error_code:'EMAIL_UNAVAILABLE'});continue;}
      const text=`Olá ${item.display_name||''},\n\n${item.body}\n\nReserva ${item.booking_reference}. Consulte a sua área WellWeb para gerir este pedido.\n\n${Deno.env.get('WELLWEB_APP_URL')??'http://127.0.0.1:5173'}`;
      const html=`<p>Olá ${escapeHtml(item.display_name||'')},</p><p>${escapeHtml(item.body)}</p><p>Reserva ${escapeHtml(item.booking_reference)}.</p><p>Consulte a sua área WellWeb para gerir este pedido.</p>`;
      if(Deno.env.get('WELLWEB_EMAIL_TRANSPORT')==='resend'){
        const apiKey=Deno.env.get('RESEND_API_KEY')??'',from=Deno.env.get('WELLWEB_MAIL_FROM')??'WellWeb <info@wellweb.pt>';
        if(!apiKey){await client.rpc('finish_wellweb_notification_outbox',{p_outbox_id:item.id,p_status:'SKIPPED',p_error_code:'EMAIL_NOT_CONFIGURED'});continue;}
        const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','Idempotency-Key':`wellweb-notification-${item.id}`},body:JSON.stringify({from,to:[item.email],subject:item.title,text,html})});
        if(!response.ok){await client.rpc('finish_wellweb_notification_outbox',{p_outbox_id:item.id,p_status:'FAILED',p_error_code:`EMAIL_HTTP_${response.status}`,p_retryable:response.status===429||response.status>=500});continue;}
      }else await sendSmtp(item.email,item.title,text,html);
      await client.rpc('finish_wellweb_notification_outbox',{p_outbox_id:item.id,p_status:'SENT'});processed++;continue;
    }
    const {data:eligibility,error:eligibilityError}=await client.rpc('check_wellweb_whatsapp_eligibility',{p_outbox_id:item.id});
    if(eligibilityError||!eligibility?.eligible){await client.rpc('finish_wellweb_notification_outbox',{p_outbox_id:item.id,p_status:'SKIPPED',p_error_code:eligibility?.reason??'ELIGIBILITY_CHECK_FAILED'});continue;}
    const environment=Deno.env.get('WELLWEB_ENVIRONMENT')??'local';const allowed=(Deno.env.get('META_WHATSAPP_TEST_RECIPIENTS')??'').split(',').map(x=>x.trim()).filter(Boolean);
    if(environment!=='production'&&!allowed.includes(eligibility.phone_e164)){await client.rpc('finish_wellweb_notification_outbox',{p_outbox_id:item.id,p_status:'SKIPPED',p_error_code:'TEST_RECIPIENT_NOT_ALLOWED'});continue;}
    const token=Deno.env.get('META_WHATSAPP_ACCESS_TOKEN')??'',phoneId=Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID')??'',template=templateName(item);
    if(!token||!phoneId||!template){await client.rpc('finish_wellweb_notification_outbox',{p_outbox_id:item.id,p_status:'SKIPPED',p_error_code:'WHATSAPP_NOT_CONFIGURED'});continue;}
    const version=Deno.env.get('META_GRAPH_API_VERSION')??'v27.0';
    const bodyParameters=[
      {type:'text',parameter_name:'professional_name',text:String(eligibility.display_name||'Olá')},
      {type:'text',parameter_name:'booking_code',text:String(item.booking_reference)},
      {type:'text',parameter_name:'booking_timestamp',text:new Intl.DateTimeFormat('pt-PT',{timeZone:'Europe/Lisbon',dateStyle:'short',timeStyle:'short'}).format(new Date(item.starts_at))},
      {type:'text',parameter_name:'booking_link',text:`${Deno.env.get('WELLWEB_APP_URL')??'http://127.0.0.1:5173'}/reservas`},
    ];
    const response=await fetch(`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(phoneId)}/messages`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:eligibility.phone_e164,type:'template',template:{name:template,language:{code:Deno.env.get('META_TEMPLATE_LANGUAGE')??'pt_PT'},components:[{type:'body',parameters:bodyParameters}]}})});
    const result=await response.json().catch(()=>({}));const messageId=result?.messages?.[0]?.id as string|undefined;
    if(response.ok&&messageId){await client.rpc('finish_wellweb_notification_outbox',{p_outbox_id:item.id,p_status:'SENT',p_provider_message_id:messageId});processed++;}
    else {
      const providerError=result?.error;
      const safeMessage=typeof providerError?.message==='string'
        ? providerError.message.replaceAll(token,'[redacted]').replaceAll(phoneId,'[redacted]').replace(/\+?[1-9][0-9]{7,14}/g,'[redacted phone]').slice(0,300)
        : undefined;
      console.error('[wellweb] WhatsApp provider rejected notification',{
        http_status:response.status,
        error_type:providerError?.type,
        error_code:providerError?.code,
        error_subcode:providerError?.error_subcode,
        fbtrace_id:providerError?.fbtrace_id,
        error_message:safeMessage,
      });
      const retryable=response.status===429||response.status>=500;await client.rpc('finish_wellweb_notification_outbox',{p_outbox_id:item.id,p_status:'FAILED',p_error_code:`META_HTTP_${response.status}`,p_retryable:retryable});
    }
   }catch(error){const code=error instanceof TypeError?'NETWORK_ERROR':'DELIVERY_ERROR';await client.rpc('finish_wellweb_notification_outbox',{p_outbox_id:item.id,p_status:'FAILED',p_error_code:code,p_retryable:true});}
  }
  return json({processed,claimed:(rows??[]).length});
 }catch{return json({error:'Outbox worker failed'},503);}
});
