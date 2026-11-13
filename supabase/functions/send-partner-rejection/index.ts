import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]!));

async function sendLocalSmtp(input: { host:string; port:number; from:string; to:string; subject:string; text:string; html:string }) {
  const connection = await Deno.connect({ hostname: input.host, port: input.port });
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  const response = async () => {
    const bytes = new Uint8Array(2048);
    while (true) {
      const count = await connection.read(bytes);
      if (count === null) throw new Error('A ligação SMTP local foi encerrada.');
      pending += decoder.decode(bytes.subarray(0,count));
      const lines = pending.split('\r\n');
      const end = lines.findIndex(line => /^\d{3} /.test(line));
      if (end >= 0) {
        const result = lines.slice(0,end+1).join('\n');
        pending = lines.slice(end+1).join('\r\n');
        if (!/^[23]\d\d[ -]/.test(lines[end])) throw new Error('O servidor SMTP local recusou uma operação.');
        return;
      }
    }
  };
  const command = async (line:string) => { await connection.write(encoder.encode(`${line}\r\n`)); await response(); };
  try {
    await response();
    await command('EHLO wellweb.local');
    await command(`MAIL FROM:<${input.from.match(/<([^>]+)>/)?.[1]??input.from}>`);
    await command(`RCPT TO:<${input.to}>`);
    await command('DATA');
    const from=input.from.includes('<')?input.from:`WellWeb <${input.from}>`;
    const body=[
      `From: ${from}`,`To: ${input.to}`,`Subject: ${input.subject}`,'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="wellweb-local-boundary"','',
      '--wellweb-local-boundary','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: 8bit','',input.text.replace(/^\./gm,'..'),
      '--wellweb-local-boundary','Content-Type: text/html; charset=UTF-8','Content-Transfer-Encoding: 8bit','',input.html.replace(/^\./gm,'..'),
      '--wellweb-local-boundary--','', '.',
    ].join('\r\n');
    await connection.write(encoder.encode(`${body}\r\n`));
    await response();
    await command('QUIT');
  } finally { connection.close(); }
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    const url = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!token || !url || !anonKey || !serviceKey) return json({ error: 'Configuração segura da função incompleta.' }, 503);
    const caller = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return json({ error: 'Sessão inválida.' }, 401);
    const { data: actor } = await caller.from('app_users').select('id,account_type,status').eq('auth_user_id', user.id).maybeSingle();
    if (!actor || actor.account_type !== 'ADMIN' || actor.status !== 'ACTIVE') return json({ error: 'Acesso administrativo necessário.' }, 403);

    const { outbox_id } = await request.json();
    if (typeof outbox_id !== 'string') return json({ error: 'Identificador de envio inválido.' }, 400);
    const service = createClient(url, serviceKey);
    const { data: previous } = await service.from('partner_rejection_email_outbox').select('status,attempts').eq('id', outbox_id).maybeSingle();
    if (previous?.status === 'SENT') return json({ status: 'SENT' });
    const { data: email, error: claimError } = await service.from('partner_rejection_email_outbox')
      .update({ status: 'SENDING', attempts: Number(previous?.attempts ?? 0) + 1, last_error: null, updated_at: new Date().toISOString() })
      .eq('id', outbox_id).in('status', ['PENDING','FAILED']).select('id,recipient_email,reason,partner_id,attempts').maybeSingle();
    if (claimError || !email) {
      const { data: state } = await service.from('partner_rejection_email_outbox').select('status').eq('id', outbox_id).maybeSingle();
      return state?.status === 'SENT' ? json({ status: 'SENT' }) : json({ error: 'Não foi possível preparar o envio.' }, 409);
    }

    const transport = Deno.env.get('WELLWEB_EMAIL_TRANSPORT') ?? 'resend';
    const apiKey = Deno.env.get('RESEND_API_KEY');
    const from = Deno.env.get('WELLWEB_MAIL_FROM') ?? (transport==='local-smtp'?'no-reply@localhost':undefined);
    if ((transport==='resend'&&!apiKey) || !from || !['resend','local-smtp'].includes(transport)) {
      await service.from('partner_rejection_email_outbox').update({ status: 'FAILED', last_error: 'Fornecedor de email não configurado.', updated_at: new Date().toISOString() }).eq('id', email.id);
      return json({ status: 'FAILED', message: 'Rejeição registada. O fornecedor de email ainda não está configurado.' });
    }
    const safeReason = escapeHtml(email.reason);
    let response: Response;
    try {
      if (transport==='local-smtp') {
        const host=Deno.env.get('WELLWEB_LOCAL_SMTP_HOST')??'supabase_inbucket_wellweb-mvp-local-only';
        const port=Number(Deno.env.get('WELLWEB_LOCAL_SMTP_PORT')??'1025');
        await sendLocalSmtp({host,port,from,to:email.recipient_email,subject:'Atualização do teu cadastro WellWeb',
          text:`Olá,\n\nO teu cadastro WellWeb não foi aprovado nesta revisão.\n\nMotivo: ${email.reason}\n\nPodes corrigir o perfil e submetê-lo novamente, quando aplicável.\n\nEquipa WellWeb`,
          html:`<p>Olá,</p><p>O teu cadastro WellWeb não foi aprovado nesta revisão.</p><p><strong>Motivo:</strong></p><p>${safeReason}</p><p>Podes corrigir o perfil e submetê-lo novamente, quando aplicável.</p><p>Equipa WellWeb</p>`});
        response=new Response('accepted',{status:202});
      } else response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `wellweb-rejection-${email.id}` },
      body: JSON.stringify({ from, to: [email.recipient_email], subject: 'Atualização do teu cadastro WellWeb',
        text: `Olá,\n\nO teu cadastro WellWeb não foi aprovado nesta revisão.\n\nMotivo: ${email.reason}\n\nPodes corrigir o perfil e submetê-lo novamente, quando aplicável.\n\nEquipa WellWeb`,
        html: `<p>Olá,</p><p>O teu cadastro WellWeb não foi aprovado nesta revisão.</p><p><strong>Motivo:</strong></p><p>${safeReason}</p><p>Podes corrigir o perfil e submetê-lo novamente, quando aplicável.</p><p>Equipa WellWeb</p>` })
      });
    } catch {
      await service.from('partner_rejection_email_outbox').update({ status: 'FAILED', last_error: 'Falha de ligação ao fornecedor de email.', updated_at: new Date().toISOString() }).eq('id', email.id);
      return json({ status: 'FAILED', message: 'A rejeição ficou registada, mas o email não pôde ser enviado. Podes tentar novamente.' });
    }
    await response.text();
    if (!response.ok) {
      await service.from('partner_rejection_email_outbox').update({ status: 'FAILED', last_error: `Fornecedor recusou o envio (HTTP ${response.status}).`, updated_at: new Date().toISOString() }).eq('id', email.id);
      return json({ status: 'FAILED', message: 'A rejeição foi registada, mas o email falhou. Podes tentar novamente.' });
    }
    const { error: sentStateError } = await service.from('partner_rejection_email_outbox').update({ status: 'SENT', last_error: null, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', email.id);
    if (sentStateError) return json({ status: 'UNKNOWN', message: 'O fornecedor aceitou o email, mas o estado não pôde ser atualizado.' }, 503);
    return json({ status: 'SENT' });
  } catch {
    return json({ error: 'Erro inesperado no processamento do email.' }, 500);
  }
});
