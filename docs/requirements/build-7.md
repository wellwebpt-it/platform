# Build 7 — Comissões e acompanhamento financeiro

Estado: preparação de requisitos; nenhuma lógica financeira foi implementada nesta Build 6.

Este documento inicia o histórico de requisitos da Build 7. Complementa as Builds 5.5 e 6 sem alterar o ciclo de reservas, cancelamentos ou notificações já existente.

## Objetivo

Registar de forma auditável as comissões associadas a reservas concluídas e disponibilizar informação financeira adequada a profissionais, hotéis e administração. Os dados financeiros são privados e devem ser isolados por perfil.

## Requisitos previstos

| ID | Requisito | Estado no checkpoint |
|---|---|---|
| WW-B7-001 | Ledger financeiro imutável, com registos append-only e correções por lançamento compensatório | A implementar |
| WW-B7-002 | Configuração de comissão independente para hotel e profissional | A implementar; não há tabelas/configurações encontradas |
| WW-B7-003 | Receita esperada versus recebida e valores em dívida | A implementar; não há pagamentos/recebimentos registados |
| WW-B7-004 | Dashboard financeiro do profissional | A implementar |
| WW-B7-005 | Dashboard financeiro do hotel | A implementar |
| WW-B7-006 | Dashboard financeiro administrativo, agregado e filtrável | A implementar |
| WW-B7-007 | Filtros temporais e detalhe por reserva | A implementar |
| WW-B7-008 | Uso seguro dos snapshots históricos; sem recalcular com preços atuais | A implementar, sujeito a qualidade dos dados históricos |
| WW-B7-009 | Nenhuma comissão por pedidos rejeitados, cancelados ou expirados | Regra obrigatória |
| WW-B7-010 | Isolamento RLS por hotel/profissional e acesso administrativo controlado | A implementar |
| WW-B7-011 | Moeda, arredondamento, impostos, pagamentos, reconciliação e exportação | Decisões pendentes antes do desenho final |

## Evidência da estrutura atual

- `wellweb_bookings` guarda `service_name_snapshot`, `service_duration_minutes_snapshot`, `service_price_snapshot` e `service_currency_snapshot` desde a criação.
- A Build 5.1 acrescenta `price_type_snapshot`, `students_count`, `max_students_snapshot` e `total_price_snapshot`; os dados anteriores foram preenchidos com o preço de serviço e tipo `SERVICE`.
- Reservas criadas sem preço podem ter snapshots nulos. Para serviços `PER_STUDENT`, o total esperado depende do snapshot por aluno e da quantidade de alunos.
- Não foram encontradas tabelas, funções ou políticas para comissão, ledger, faturas, pagamentos, liquidações ou montantes recebidos.
- O esquema não preserva uma taxa de comissão histórica por reserva. Portanto, mesmo com snapshots de preço, a taxa que estaria em vigor no passado não pode ser reconstruída com evidência.
- Não foi possível consultar as linhas atuais de produção nem da base local neste checkpoint. A ligação local falhou e nenhuma consulta à produção foi executada. A quantidade de reservas sem snapshots utilizáveis continua desconhecida.

## Regras financeiras de base

1. Apenas uma reserva elegível concluída pode originar comissão; definir se o momento de reconhecimento é a transição para `COMPLETED` ou um evento posterior.
2. `PENDING`, `CONFIRMED`, `REJECTED`, `CANCELLED` e reservas expiradas nunca geram comissão. Expiração permanece `CANCELLED` com `PROFESSIONAL_RESPONSE_TIMEOUT`.
3. A comissão do hotel e a do profissional são configuradas e calculadas separadamente, com snapshots imutáveis da taxa, base, valor, moeda e versão da regra usada.
4. O valor bruto deve derivar dos snapshots da reserva, nunca do preço atual do serviço. Se faltar preço ou quantidade histórica necessária, o resultado deve ser marcado como não calculável e excluído de totais monetários até revisão autorizada.
5. Receita esperada, comissão calculada, pagamento iniciado e valor efetivamente recebido são estados distintos. Não inferir recebimento a partir de `COMPLETED`.
6. Alterações financeiras posteriores usam novos lançamentos referenciados ao original; lançamentos confirmados não são atualizados ou apagados.
7. Reprocessamentos devem ser idempotentes por reserva, beneficiário e tipo de lançamento.
8. Nenhum endpoint público ou utilizador autenticado pode consultar dados financeiros de terceiros.

## Segurança e RLS previstas

- Armazenar ledger e informação de pagamento num schema não exposto pela API pública, com RLS ativada e acesso direto revogado.
- Expor consultas por RPCs/views cuidadosamente autorizadas: profissional consulta apenas a sua conta; hotel consulta apenas entidades hoteleiras às quais pertence; ADMIN consulta o âmbito administrativo permitido.
- Gravar a identidade do ator, a origem, a reserva, timestamps e referências de reversão em cada evento financeiro.
- Separar configuração de comissão de identidade/perfil e impedir que parceiros alterem taxas sem autorização administrativa.
- Não colocar credenciais de pagamento, service role ou segredos financeiros no frontend.

## Decisões necessárias antes da implementação

- Percentagens/valores de comissão e se cada lado paga uma comissão independente.
- Base de cálculo: preço total, preço por aluno, tratamento de descontos, reembolsos, IVA/impostos, arredondamento e moeda.
- Momento de reconhecer receita e de marcar valores como pagos/recebidos.
- Quem pode ajustar ou dispensar uma comissão e como auditar a decisão.
- Se a comissão depende da conclusão, confirmação manual, prova de pagamento ou liquidação externa.
- Política para reservas históricas com preço nulo, quantidade ausente ou sem configuração histórica da taxa.
- Necessidades de exportação contabilística, retenção e eventual integração com processador de pagamentos.

## Plano de validação para Build 7

- Verificar localmente snapshots e estados históricos antes de qualquer backfill; produzir contagens por estado e por disponibilidade dos campos, sem incluir dados pessoais.
- Testar que uma reserva concluída cria os lançamentos esperados uma única vez.
- Testar que pedido rejeitado, cancelamento e expiração não criam comissão.
- Testar reversões, pagamentos parciais, filtros temporais, limites RLS entre hotel/profissional/ADMIN e tentativas de acesso direto.
- Não executar backfills, alterações remotas ou alterações financeiras de produção sem um plano revisto e autorização explícita.

## Pendências herdadas

- Build 5.5: validar transações, RLS e Edge Function na stack local; testes automatizados atuais são sobretudo verificações estáticas.
- Build 6: aplicar e validar as migrations localmente, incluindo consentimento HOTEL e supressão de email/WhatsApp para expiração; configurar templates Meta por evento e testar notificações HOTEL. Integrações oficiais de email e WhatsApp em produção permanecem pendentes.
