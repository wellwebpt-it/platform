# WellWeb — operações locais das Builds 5.1 e 5.2

## Supabase local

O projeto de desenvolvimento usa a instância Supabase local persistente `wellweb-mvp-local-only`. Confirma sempre que o URL configurado no `.env.local` aponta para `127.0.0.1` antes de executar os testes. O ficheiro `.env.local` não deve ser commitado.

Aplica apenas migrations incrementais locais com `npx supabase migration up --workdir /home/wellweb/wellweb-supabase-local`. Não executar `db reset` nesta base, porque contém contas e perfis de teste do Product Owner.

## Email local de rejeição

O serviço de email da stack é o Inbucket, com interface local em `http://127.0.0.1:54324`. Não é necessário fornecedor pago nem envio externo para testar rejeições.

1. Cria `supabase/functions/.env` (ignorado pelo Git) com `WELLWEB_EMAIL_TRANSPORT=local-smtp`.
2. Opcionalmente define `WELLWEB_LOCAL_SMTP_HOST=supabase_inbucket_wellweb-mvp-local-only`, `WELLWEB_LOCAL_SMTP_PORT=1025` e `WELLWEB_MAIL_FROM=no-reply@localhost`.
3. Inicia o Supabase local e executa `npx supabase functions serve send-partner-rejection --workdir /home/wellweb/wellweb-foundation`.
4. Rejeita um parceiro de teste pela administração. A função atualiza a outbox e encaminha a mensagem apenas para o SMTP do Inbucket local.
5. Abre a interface em `http://127.0.0.1:54324` para verificar a caixa de teste.

O transporte `local-smtp` liga-se ao nome de serviço Docker interno e não executa chamadas HTTP para fornecedores. O transporte `resend` é o modo predefinido para outros ambientes e só envia se estiver explicitamente configurado com as respetivas variáveis. Não guardar chaves em ficheiros versionados nem no frontend.

## Conclusão automática de reservas

O job `wellweb-complete-bookings` é criado no PostgreSQL através de `pg_cron` e chama a função idempotente a cada minuto. A conclusão local só está validada quando um teste integrado confirmar que uma reserva fixture, sem intervenção do browser, muda para `COMPLETED`, com um evento de auditoria e notificações únicas; uma reserva cancelada deve permanecer cancelada.

Os testes integrados usam identidades e registos temporários de teste e limpam apenas os respetivos IDs no fim. Não executar estes scripts contra URLs remotos.
