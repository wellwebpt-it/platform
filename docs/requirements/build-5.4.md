# WellWeb Build 5.4 — Homepage, parceiros, rodapé e «Saiba mais»

Complementa a Build 5.3. Este documento consolida os requisitos WW-B54-001–016. A reestruturação WW-B54-015 substitui o conteúdo editorial anterior de `editorial-intro` e `experience-strip`; o histórico da Build 5.3 permanece em [build-5.3.md](build-5.3.md).

## Estado e requisitos

| ID | Requisito e aceitação | Estado nesta execução |
|---|---|---|
| WW-B54-001 | Homepage apresenta exatamente o novo texto sobre hotéis e espaços de hospitalidade, mantendo a hierarquia do hero. | Implementado; teste de conteúdo. |
| WW-B54-002 | Remover «Experiências locais com significado» sem deixar um espaço/elemento vazio. | Implementado; teste estrutural. |
| WW-B54-003 | CTA «Sou um alojamento» encaminha para o fluxo existente (`/registar/hotel`) ou para a área/sessão conforme o estado da conta. | Implementado; teste de routing estático. |
| WW-B54-004 | Remover o botão Contacto do corpo da homepage, preservando o menu, a página e os links do rodapé. | Implementado; teste estrutural. |
| WW-B54-005 | Compactar espaçamento do rodapé sem perder legibilidade ou colunas. | Implementado; CSS responsivo, browser pendente. |
| WW-B54-006 | Logo do rodapé menor que o do header, sem corte/distorção e com proporção preservada. | Implementado com `object-fit: contain`; inspeção visual pendente. |
| WW-B54-007 | Email `info@wellweb.pt`, Instagram `@wellweb.pt` e WhatsApp `+351918483987`, com links corretos, alinhamento, foco e interação. | Implementado; testes de conteúdo e CSS. |
| WW-B54-008 | Ícone WhatsApp SVG com dimensões, traço e alinhamento consistentes; sem integração WhatsApp. | Implementado; teste estrutural. |
| WW-B54-009 | Centralizar `WELLNESS · EXPERIENCES · CONNECTIONS`. | Implementado no layout da página «Saiba mais»; revisão visual pendente. |
| WW-B54-010 | Integrar o texto de `maintext.png`, remover «Saiba mais sobre a WellWeb» e apresentar as três frases em painéis centrados, sem a barra vertical decorativa. | Implementado; três painéis responsivos e teste estrutural/de conteúdo. A decisão visual foi refinada após revisão manual do produto. |
| WW-B54-011 | Restaurar as quatro etapas da referência, incluindo avaliação como funcionalidade futura, sem implementar avaliações nem ícones. | Implementado; teste de texto e ordem. |
| WW-B54-012 | Cartões de profissionais elegíveis com informação pública e sem dados fictícios/avaliações. | Implementado usando o diretório público; teste estrutural. |
| WW-B54-012A | Título «Encontre o próximo parceiro». | Implementado; teste de conteúdo. |
| WW-B54-012B | Disponibilidade calculada pela lógica Build 5.3 e colocada sobre a fotografia. | Implementado; usa o resumo público agregado existente. |
| WW-B54-012C | Menor preço público válido de serviços ativos; omitir preços inválidos/incomparáveis e identificar preço por pessoa. | Implementado; testes de cálculo. |
| WW-B54-012D | Carrossel compacto navegável por setas e teclado, com suporte a toque/scroll e carregamento progressivo, sem duplicar cartões nem mostrar scrollbar horizontal. | Implementado; teste estrutural; browser pendente. |
| WW-B54-013 | Reutilizar o mesmo componente de filtros da pesquisa pública. | Implementado por `ProfessionalFilterBar`, partilhado com o diretório. |
| WW-B54-014 | Pesquisa global sobre todos os perfis elegíveis, filtros antes da paginação, ordem determinística, keyset pagination e proteção contra respostas obsoletas. | Implementado no hook e RPC incremental; teste estrutural; execução local da migration pendente. |
| WW-B54-015 | Apresentar os oito benefícios exatos, em ordem, em grupos equilibrados para hotéis e profissionais. | Implementado e testado por conteúdo/estrutura; browser pendente. |
| WW-B54-016 | Preparar grupos para futuras CTAs sem incluir botões nesses grupos. | Implementado; estrutura sem botões. A CTA «Sou um alojamento» está no hero. |

## Conteúdo WW-B54-015

**PARA HOTÉIS**

1. Serviços que se adaptam às suas necessidades
2. Profissionais locais de confiança
3. Experiências que valorizam a estadia
4. Mais praticidade para a sua equipa

**PARA PROFISSIONAIS**

1. Mais visibilidade para o seu talento
2. Novas oportunidades de negócio
3. Menos tempo à procura de clientes
4. Maior autonomia para crescer

Os dois grupos têm hierarquia equivalente lado a lado em desktop e empilhados em mobile. Os antigos textos/tiles substituídos não são apresentados em duplicado. O hero e a imagem principal são preservados.

## Decisões técnicas e segurança

- A pesquisa pública partilha `ProfessionalFilterBar` e `usePublicProfessionalSearch` entre o diretório e o preview; não existe uma filtragem local limitada aos primeiros dez resultados.
- Sem filtros, o preview inicia pelos dez perfis publicados mais recentes. Com filtros, a função `wellweb_search_public_professionals` filtra a view pública antes da paginação por cursor, ordena por `published_at DESC, id ASC` e limita cada página a 30 registos. A interface pede páginas seguintes progressivamente, elimina IDs repetidos e ignora respostas obsoletas.
- A migration incremental `202611160001_build54_public_professional_search.sql` cria uma função `STABLE SECURITY INVOKER` com `search_path` vazio e usa `public.public_professional_directory` como allowlist. Concede execução a `anon` e `authenticated`; não desativa RLS nem amplia a view para dados privados. Deve ser validada apenas localmente antes de qualquer decisão de publicação.
- Disponibilidade continua a usar o cálculo agregado Build 5.3. Preço é calculado apenas a partir de `service_details` da view pública; o valor é omitido quando moeda ou base de preço não são comparáveis.
- Refinamento visual posterior: as três frases de maintext têm painéis individuais e texto centrado; não existe a barra vertical esquerda. Os cartões do carrossel ficaram mais baixos/compactos. O rodapé de cada cartão alinha o preço público inicial à esquerda e «Ver perfil» à direita. Sem preço público válido, apresenta «Consultar serviços» em vez de inventar um valor. A scrollbar fica oculta, mantendo scroll por toque e navegação através dos botões/setas do teclado.
- O workflow mostra avaliação como futura. Não foram implementadas avaliações, WhatsApp Cloud API, comissões ou mudanças de reservas, cancelamentos e autenticação.
- Contacto oficial: `info@wellweb.pt`. Build 6: WhatsApp e notificações. Build 7: comissões. Futuro: evolução da pesquisa pública e avaliações.

## Referências, dependências e validação

Referências visuais consultadas: `img/saibamais/maintext.png`, `workflow.png` e `services-preview.png`. Dados de demonstração da referência não são usados como perfis reais. A migration da pesquisa depende da view pública criada em `202611150001_build53_public_professional_availability.sql`.

Testes adicionados/atualizados em `tests/build54.test.mjs` cobrem copy, ordenação dos benefícios e workflow, CTA/menu, contactos, remoção de conteúdo antigo, estrutura sem card, preço, badges, filtros partilhados, paginação global/keyset, estados, e regras de segurança da RPC. `npm test`, `npm run build` e `git diff --check` devem ser executados para a validação final. A validação visual nos viewports 1440, 1024, 768, 390 e 320 px requer um browser controlável; não será declarada como concluída sem essa inspeção efetiva.

### Pendências

- Aplicar/validar a migration apenas no Supabase local e confirmar consulta com sessão pública; não tocar no Supabase remoto.
- Concluir testes e build após a migration.
- Inspeção visual real em desktop e mobile permanece pendente se não houver browser disponível nesta execução.
