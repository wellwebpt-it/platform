# Supabase local e baseline das migrations

As quatro migrations históricas permanecem intactas. A cópia versionada da
`202611020001` inclui objetos que a `202611030001` volta a criar; a sequência que
foi originalmente aplicada começa com a versão anterior ao commit `45f87a9`.

O script `scripts/supabase-local.sh` monta uma cópia temporária da configuração e
das migrations em `/tmp/wellweb-supabase-local-baseline`, substituindo apenas nessa
cópia a migration inicial pela versão original do Git. Assim, o reset local aplica
a sequência histórica sem duplicações, depois as migrations atuais. Não copia a
referência `.temp/project-ref`, não liga o diretório temporário a um projeto remoto
e só aceita `start`, `stop`, `status` ou `reset`.

```bash
./scripts/supabase-local.sh start
./scripts/supabase-local.sh reset
./scripts/supabase-local.sh status
```

O script requer o Docker Desktop acessível no WSL. Se já existir outra stack local
na porta 54322, não inicies outra: usa a stack local ativa e `npx supabase migration
up --local` a partir da raiz do repositório. O helper de baseline só deve iniciar uma
stack quando as portas estiverem livres. Para aplicar as migrations ao único ambiente
remoto será necessária uma etapa operacional posterior, fora deste script e sujeita
a revisão própria.
