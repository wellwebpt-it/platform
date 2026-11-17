# Build 6 — Notificações multicanal, consentimento e SLA

Complementa as Builds 5.3–5.5. O SLA único para novos pedidos pendentes é de quatro horas, contado no servidor no momento da criação. O prazo anterior de antecedência mínima de quatro horas para pedir uma reserva mantém-se; os prazos de cancelamento de reservas confirmadas (24 h profissional, 12 h hotel) não são alterados.

## Requisitos e estado

| ID | Requisito | Estado nesta implementação |
|---|---|---|
| WW-B6-001 | Deadline UTC de quatro horas, verificação no servidor e apresentação em Europe/Lisbon | Implementado na migration e UI |
| WW-B6-002 | Expiração automática, auditoria, libertação da disponibilidade e sem comissão | Implementado como PENDING → CANCELLED com `PROFESSIONAL_RESPONSE_TIMEOUT`; o fluxo financeiro não existe nesta build |
| WW-B6-003 | Eventos transacionais para pedido, decisão, cancelamento e expiração | Outbox adicionada para eventos persistidos na tabela de notificações |
| WW-B6-004 | Meta WhatsApp Cloud API, templates, teste autorizado e webhook | Worker/webhook preparados; envio real depende de configuração Meta e teste autorizado |
| WW-B6-005 | Telefone internacional E.164 reutilizado | Normalização e validação no registo e RPC no backend |
| WW-B6-006 | Consentimento específico opcional, desmarcado por defeito | Profissionais implementados na migration original; hotéis adicionados na migration incremental `202611170001` |
| WW-B6-007 | Consentimento versionado, com número, origem e histórico de revogação | Tabelas privadas de eventos para profissionais e hotéis; alteração do telefone desativa a opção |
| WW-B6-008 | Ativar/revogar em definições | RPCs limitadas à própria conta profissional ou hotel |
| WW-B6-009 | Validar elegibilidade imediatamente antes do envio | RPC do worker verifica estado, número e consentimento atuais |
| WW-B6-010 | Email é base; falhas não afetam reserva nem deadline | Outbox isolada da transição; worker tem canal email |
| WW-B6-011 | Outbox idempotente, retries e concorrência | Unique por notificação/canal, SKIP LOCKED, máximo 8 tentativas |
| WW-B6-012 | Estado e prazo na área de reservas | Deadline, estado expirado e motivo apresentados |
| WW-B6-013 | Sem expiração retroativa | Só linhas com deadline explícito são elegíveis; dados antigos permanecem NULL |
| WW-B6-014 | Segurança, RLS, segredos backend | Dados privados em schema não exposto, RLS e RPC service-role |
| WW-B6-015 | Testes funcionais e regressões | Testes estáticos adicionados; integração local e chamada real Meta dependem do ambiente |
| WW-B6-016 | Documentação | Registada aqui |

## Modelo e regras

- Pedidos novos recebem `response_deadline_at = clock_timestamp() + 4 hours` no trigger BEFORE INSERT. Os históricos ficam sem deadline e não expiram retroativamente.
- Aceitar/rejeitar no instante do deadline já falha. O job de minuto bloqueia candidatos com `FOR UPDATE SKIP LOCKED`, marca `CANCELLED`, razão `PROFESSIONAL_RESPONSE_TIMEOUT`, cria histórico e notifica as partes. A aceitação e expiração concorrentes são serializadas pelo lock da linha.
- Rejeições usam `PROFESSIONAL_REJECTED`; expiração não é rejeição voluntária. Não foi criada comissão nem lógica financeira (Build 7 fora do âmbito).
- `wellweb_private.notification_outbox` tem unicidade evento/canal, RLS sem acesso direto dos utilizadores, limite de oito tentativas e backoff exponencial até uma hora. Consentimento revogado ou número alterado resulta em `SKIPPED` no canal WhatsApp sem afetar email/plataforma nem SLA. A migration `202611170001` exclui `BOOKING_EXPIRED` dos canais de email e WhatsApp; a notificação interna de expiração mantém-se.
- O consentimento é opcional, independente de Termos e marketing, para profissionais e hotéis; registar inclui versão do texto e origem. Troca de número desativa WhatsApp e exige adesão explícita ao novo número. Contas HOTEL existentes ficam desativadas até aceitarem o consentimento nas definições.
- A integração usa templates Cloud API. Em ambiente local/teste, o destinatário precisa estar em `META_WHATSAPP_TEST_RECIPIENTS`; templates e credenciais só ficam em secrets do backend. Webhook público valida `X-Hub-Signature-256` e token de verificação GET; nunca regista corpo ou segredos.
- Email local usa Inbucket por SMTP. O worker roda via cron a cada minuto; o email usa SMTP/Inbucket por omissão ou Resend com `WELLWEB_EMAIL_TRANSPORT=resend`, `RESEND_API_KEY` e `WELLWEB_MAIL_FROM`; o dispatch fica inativo até existirem os secrets Vault `wellweb_supabase_url` e `wellweb_service_role_key`.

## Configuração local / Meta

A função `process-wellweb-notification-outbox` requer os secrets locais do Supabase e configuração SMTP/Inbucket. Para WhatsApp configurar apenas no runtime local: `WELLWEB_ENVIRONMENT=local`, `META_WHATSAPP_PHONE_NUMBER_ID`, `META_WHATSAPP_BUSINESS_ACCOUNT_ID` (referência operacional), `META_WHATSAPP_ACCESS_TOKEN`, `META_GRAPH_API_VERSION`, `META_TEMPLATE_<EVENT>[_PROFESSIONAL|_HOTEL]`, `META_TEMPLATE_LANGUAGE`, `META_WHATSAPP_TEST_RECIPIENTS`, `META_WEBHOOK_VERIFY_TOKEN` e `META_APP_SECRET`. O worker não revela valores em respostas/logs. Templates devem existir e estar aprovados no WABA Meta; os templates configurados devem acomodar os parâmetros de nome, referência, data/hora local e link da área autenticada.

Meta entrega estados (sent/delivered/read/failed) pelo webhook. O DB deduplica por message ID + estado. Chamadas externas têm limites de entrega: queda de rede após aceitação do fornecedor pode deixar o resultado ambíguo e um retry pode duplicar uma mensagem; a chave local deduplica eventos e evita claims simultâneos, mas não afirma exatamente-uma-entrega externa.

Para validação local, configure os segredos somente no Vault local através do Studio local (porta 54323): URL `http://kong:8000` e chave service role obtida localmente via `npx supabase status`; grave-os sob os nomes `wellweb_supabase_url` e `wellweb_service_role_key`. Não copie esses valores para ficheiros versionados ou para conversas. A migração para produção exige provisionar os secrets no ambiente backend/Vault, configurar URL pública e webhook HTTPS na Meta, templates aprovados e destinatários apropriados, com autorização separada para alterações remotas. Substituir o número de teste por um empresarial requer apenas configuração de Phone Number ID/WABA e templates.

## Privacidade, segurança e pendências

A página `/privacidade` descreve finalidade operacional, revogação e Meta como fornecedor. A redação é informativa para a funcionalidade e deve ser integrada na revisão legal geral da política. Dados privados não são expostos pelo API schema; profissionais e hotéis acedem às próprias preferências apenas por RPC. O worker requer service role no backend; nunca no browser.

Pendências para validação completa: aplicar migrations apenas na stack local, validar cron/Vault/pg_net local, percorrer cenários com contas HOTEL/PROFESSIONAL reais locais e testar webhook com assinatura. A validação de produção continua pendente.

## Checkpoint de integrações — 2026-11-17

- Product Owner confirmou envio WhatsApp real de teste através da Cloud API Meta e envio local de email pelo Mailpit.
- O template Meta definitivo e a lista de nomes/variáveis ainda estão pendentes; o Phone Number empresarial WellWeb e a configuração oficial da Meta também estão pendentes.
- Google Workspace para produção ainda não foi configurado nem validado. A implementação local oferece transporte Resend; alojar email no Workspace não configura automaticamente o envio transacional da aplicação.
- A elegibilidade WhatsApp agora suporta HOTEL e PROFESSIONAL após consentimento individual; contas HOTEL existentes começam desativadas e devem consentir nas definições. Troca de telefone invalida o consentimento anterior.
- A migration incremental `202611170001_build6_hotel_whatsapp_consent.sql` retira `BOOKING_EXPIRED` do email e WhatsApp. As notificações in-app de expiração permanecem. A migration ainda não foi aplicada localmente neste checkpoint porque a ligação à base Supabase local recusou em `127.0.0.1:54322` e Docker negou acesso ao socket nesta sessão.
- O disparo WhatsApp para novos eventos HOTEL aguarda os templates e variáveis correspondentes; não se declara esse fluxo validado.
- Não houve alterações ou chamadas à produção.
