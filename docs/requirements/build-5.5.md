# Build 5.5 — Avaliações de profissionais

Estado: implementação em validação local. Complementa as Builds 5.3 e 5.4 sem alterar o fluxo de reservas.

## Decisões e requisitos

- **WW-B55-001/002:** hóspedes avaliam sem conta através de link/QR de reserva concluída. O token é gerado pelo backend, apresentado uma única vez e persistido somente como SHA-256. A validade é de 14 dias após `completed_at` (fallback `ends_at`), em UTC; a UI apresenta Europe/Lisbon. Submissões múltiplas são permitidas até ao número `students_count` (fallback `participants`), com serialização por lock da reserva.
- **WW-B55-003:** cada par hotel/profissional tem uma avaliação ativa editável, elegível apenas com reserva concluída. Todos os utilizadores ativos associados ao hotel podem editar; alterações geram auditoria.
- **WW-B55-004/005:** avaliações GUEST e HOTEL e respetivos agregados são independentes. Cartões mostram primeiro média/quantidade de hóspedes, depois, se necessário, média/quantidade de hotéis; sem avaliações, mostram “Novo · Sem avaliações”. Perfil apresenta as duas secções e comentários públicos.
- **WW-B55-006:** “Melhor avaliados” usa média bayesiana apenas para ordenar: `score = n/(n+5) × R + 5/(n+5) × C`, onde `R` é média pública do profissional, `C` a média global de hóspedes e `n` a quantidade de avaliações. Profissionais sem avaliações ficam depois dos avaliados; desempate por média, contagem, publicação e UUID. Filtros e paginação são executados pela RPC no servidor.
- **WW-B55-007:** publicação automática; profissionais podem denunciar comentários do próprio perfil. Administração filtra por origem/estado, oculta, restaura ou invalida com motivo e pode resolver denúncias. Alterações ficam em `professional_review_audit`; estrelas não são reescritas.
- **WW-B55-008/009:** migration incremental `202611160002_build55_professional_reviews.sql` cria convites, avaliações, denúncias, auditoria, agregados e RPCs. RLS permite leitura pública apenas de avaliações publicadas de perfis presentes no diretório público. Não há INSERT anónimo direto; submissão convidada só é executável pela Edge Function com service role.
- **WW-B55-010:** limite de 20 chamadas por hora por digest HMAC da origem, com janela no banco; o IP em claro não é persistido. Convites podem ser revogados. Respostas do endpoint não devolvem dados da reserva. O limite de participantes é a proteção principal; IP não confirma identidade e os cabeçalhos encaminhados dependem do proxy Supabase.
- **WW-B55-011/012:** hotel gera link/QR na reserva concluída; hóspede avalia sem login; hotel cria/edita no perfil; profissional consulta/denuncia; admin modera. Comentários são texto simples, limitado a 500 caracteres.

## Segurança e privacidade

Sem dados de hóspedes na avaliação. Links guardam hash, não token. IP é reduzido a HMAC e retido apenas na tabela interna de rate limit, com limpeza após 24 horas de inatividade. Contexto e submissão estão limitados a 20 chamadas por hora e origem técnica. As funções privilegiadas usam `search_path=''`, autorização explícita e privilégios EXECUTE restritos. A página pública define `noindex,nofollow` e `no-referrer`. A identidade individual de quem usa um QR partilhado não é verificada.

## Testes e estado

`tests/build55.test.mjs` verifica contratos de interface e segurança da migration. `npm run build` e `npm test` devem ser executados. A validação transacional/RLS da migration requer Supabase local ativo; não foi validada em produção. A Edge Function requer teste local com runtime Supabase. Testes de concorrência real e browser permanecem pendentes se o Docker/Edge Runtime não estiver disponível.

## Futuro (não implementado)

Convites automáticos, WhatsApp, respostas públicas, verificação individual de participantes, deteção avançada de fraude, estatísticas de reputação e moderação automatizada.
