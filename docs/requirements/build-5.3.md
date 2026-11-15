# WellWeb Build 5.3 — «Saiba mais» e disponibilidade pública

**Estado:** implementado nesta branch; migration aplicada e validada no Supabase local; aguarda validação visual no browser e aprovação do Product Owner.
**Build:** 5.3
**Branch:** `feature/build5-3-saiba-mais`
**Checkpoint de origem:** `30d6531` — Build 5.1/5.2.

## Objetivo

Criar uma página pública «Saiba mais», manter a pesquisa de profissionais acessível pelos fluxos existentes, mostrar perfis reais publicados num carrossel e apresentar uma indicação agregada e atualizada da disponibilidade.

## Requisitos funcionais

| ID | Requisito solicitado | Estado |
|---|---|---|
| WW-B53-001 | A navegação «Saiba mais» abre `/saiba-mais`, uma rota pública compatível com refresh e histórico do browser. O diretório continua acessível em `/profissionais`. | Implementado; teste de rota incluído. |
| WW-B53-002 | A introdução usa texto HTML fiel à imagem de referência, adaptado à identidade WellWeb. | Implementado; verificação visual pendente. |
| WW-B53-003 | Explicar o fluxo funcional atual com uma animação discreta, responsiva e compatível com `prefers-reduced-motion`. | Implementado com 3 etapas atualmente disponíveis. A etapa «Avaliar» da referência não foi apresentada porque avaliações públicas estão fora do âmbito desta build e não existem no produto. |
| WW-B53-004 | Carrossel de perfis profissionais reais, com foto, nome, especialidade/modalidades, localização e serviços públicos; navegação por toque, teclado e controlos; cartões abrem o perfil público existente. | Implementado; dados dependem da migration local e de perfis publicados. |
| WW-B53-005 | Selecionar perfis publicados pela publicação mais recente e desempatar por ID; permitir personalizar inclusão/ordenação sem mudar o componente. | Implementado. A seleção manual e avaliações ficam adiadas: ainda não há infraestrutura de destaque nem de avaliações. |
| WW-B53-006 | Mostrar um resumo de disponibilidade agregado, calculado no backend em lote sem revelar horários exatos, reservas ou bloqueios. | Implementado por RPC pública de resumo; execução local validada como `anon` após aplicação da migration. |
| WW-B53-007 | Mostrar a mensagem final exata e encaminhar para o registo profissional existente; contas autenticadas vão para a sua própria área. | Implementado. |
| WW-B53-008 | Respeitar publicação/aprovação, RLS, minimização de dados, acessibilidade, responsividade e evitar N+1. | Implementado no código e na proposta de migration; validação local pendente. |

## Regras de disponibilidade implementadas

- A janela é móvel: desde agora até antes de `now() + 7 days`; a grelha candidata avança em blocos de 30 minutos.
- Só contam serviços ativos com duração entre 5 e 1440 minutos, pertencentes a um perfil aprovado, público e ativo.
- Para cada serviço, a duração completa tem de caber no intervalo semanal ou numa exceção `AVAILABLE`.
- O motor existente `wellweb_booking_interval_is_available` decide cobertura e precedência de exceções; não é substituído por uma regra paralela no cliente.
- Aplicam-se a antecedência mínima de 4 horas, bloqueios e reservas `CONFIRMED`. A implementação atual do motor de reservas não ocupa horários com pedidos `PENDING`; o resumo conserva essa regra. A criação do pedido volta a validar a vaga no backend.
- «Disponível esta semana» significa existir uma vaga até ao fim do domingo em `Europe/Lisbon`. Caso contrário, mostra-se a data relativa da primeira vaga na janela móvel; sem vaga, «Sem disponibilidade nos próximos 7 dias».
- Não se apresenta contagem de horários porque os serviços podem ter durações diferentes e a contagem sem serviço de referência seria enganadora. Sem serviço válido ou perante erro da consulta, omite-se a etiqueta.
- O resumo nunca devolve a hora exata, a reserva ocupante, o motivo de bloqueio ou dados de hóspedes.

## Decisões de arquitetura

1. A página reutiliza a rota de perfil `/profissional/:id` e o registo `/registar/profissional` existentes.
2. A vista pública mantém o seu allowlist e recebe apenas `published_at` como campo adicional. Os perfis existentes sem histórico fiável recebem uma data-base comum na instalação da migration; os novos eventos de publicação são datados por trigger. Não se usa a data de criação do perfil como aproximação.
3. A RPC `wellweb_public_professional_availability(uuid[])` aceita até 50 IDs por chamada, filtra novamente a publicação e devolve apenas código de resumo e diferença em dias. O carrossel envia um único lote de até 30 perfis.
4. A indicação não garante reserva: o backend volta a validar o pedido. Não se adiciona cache de disponibilidade nesta fase.
5. A referência visual contém uma quarta etapa de avaliação, indisponível no âmbito aprovado. Foi omitida para não anunciar uma funcionalidade inexistente. Esta decisão não altera requisitos de builds anteriores.

## Impacto no modelo de dados

Migration incremental `202611150001_build53_public_professional_availability.sql`:

- Adiciona `professional_profiles.published_at`.
- Regista transições de publicação e estado ativo da conta.
- Acrescenta `published_at` à vista pública existente.
- Cria uma função de conversão de hora local `Europe/Lisbon` e uma RPC SECURITY DEFINER com `search_path` vazio. A RPC tem limite de lote, filtra perfis publicados e apenas concede execução a `anon` e `authenticated`.
- Não altera migrations históricas. Nenhuma alteração remota foi feita.

## Dependências

- Supabase local com migrations até `202611150001`.
- Fotos existentes no bucket público de media de perfis.
- `lucide-react` já instalado; não foram adicionadas dependências.

## Critérios de aceitação e testes

- Unidade: rota pública, menu, seleção e ordenação, filtragem de estados, lote de RPC, mensagens, casos sem dados e datas/semana em `Europe/Lisbon`.
- Contrato SQL: timezone, grelha de 30 minutos, antecedência de 4 horas, intervalos de serviço, exceções/bloqueios, reservas confirmadas, filtros de publicação e privilégios públicos minimizados.
- Projeto: `npm test`, `npm run build`, `git diff --check`.
- Testes no browser em desktop/mobile: pendentes; esta sessão não dispõe de browser controlável.
- Migration `202611150001` aplicada pelo Supabase CLI explicitamente a `--local`, sem reset e sem operação remota. Confirmação no histórico local, coluna `published_at` presente e chamada RPC sob o papel `anon` devolvendo 6 perfis. A execução prévia por transação com `ROLLBACK` também validou conversões de horário de primavera/outono e privilégios. Nenhuma operação remota nem reset local foi executada.

## Limitações e adiamentos

- Publicação histórica anterior à migration não pode ser reconstruída; os perfis já públicos empatam na data-base e a ordenação usa ID como desempate determinístico.
- Destaque manual exige modelação de dados e fluxo administrativo; fica adiado até proposta própria.
- Melhor avaliação, avaliação pública, WhatsApp e comissões não fazem parte desta build.
- Os exemplos de «2 horários livres» não são usados porque não existe uma duração única aplicável a todos os serviços.

## Aprovação do Product Owner

Ainda não registada. A revisão desta implementação e da semântica da etiqueta continua pendente.
