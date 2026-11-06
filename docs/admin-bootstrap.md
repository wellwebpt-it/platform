# Administração WellWeb em desenvolvimento local

## Acesso e permissões

A página administrativa está em `http://localhost:5173/admin` (ou no endereço/porta
apresentado pelo Vite). A rota exige uma sessão ativa e `app_users.account_type =
'ADMIN'`. O cabeçalho mostra **Administração** para contas ADMIN ativas, incluindo
em ecrãs pequenos. O registo público continua a aceitar apenas `HOTEL` e
`PROFESSIONAL`.

A página `/admin` lista parceiros, permite filtrar por estado, abrir os dados e
fotografias do perfil, aprovar/rejeitar registos e alterações pendentes, e gerir o
catálogo de modalidades. As operações passam por funções RPC que validam novamente
no servidor que a conta é ADMIN ativa; a visibilidade do botão não é uma barreira
de segurança.

## Confirmar a identidade local

Usa uma ligação explicitamente local. Este exemplo consulta apenas o PostgreSQL
no container local e não imprime palavras-passe nem tokens:

```sh
docker exec -it supabase_db_wellweb-mvp-local-only psql -X -U postgres -d postgres
```

Na sessão `psql`, identifica a tua conta pelo email que reconheces e confirma o
tipo associado:

```sql
select u.id as auth_user_id, u.email, a.account_type, a.status
from auth.users u
left join public.app_users a on a.auth_user_id = u.id
order by u.created_at;
```

Confirma também que a aplicação aponta para `127.0.0.1`/`localhost` antes de
iniciar sessão. Não partilhes a saída com emails se não for necessário.

## Promover uma conta existente apenas no Supabase local

Na verificação atual, a base local tem um hotel ativo, dois profissionais ativos
e nenhuma conta ADMIN. Como o tipo de conta é imutável por trigger, a promoção
local exige desativar temporariamente apenas esse trigger dentro de uma transação,
atualizar exatamente a identidade escolhida e voltar a ativá-lo. Isto preserva o
perfil associado, mas a conta deixa de aceder à área HOTEL/PROFESSIONAL enquanto
for ADMIN. Para manter uma conta de parceiro separada, provisiona uma identidade
Auth dedicada em vez de promover essa conta.

1. Na consulta acima, confirma o email e copia o `auth_user_id` da tua conta.
2. Confirma outra vez que o terminal usa o projeto local. O comando abaixo é
   deliberadamente `docker exec` contra o container local identificado acima;
   não o substituas por uma ligação remota.
3. Substitui o UUID e executa o bloco. Ele aborta se não encontrar exatamente
   uma conta ativa HOTEL/PROFESSIONAL; a transação repõe o trigger se houver erro.

```sql
begin;

do $$
declare
  v_auth_user_id uuid := 'SUBSTITUIR-PELO-AUTH-USER-ID'::uuid;
  v_rows integer;
begin
  if current_database() <> 'postgres' then
    raise exception 'Base inesperada; promoção cancelada';
  end if;

  if (select count(*) from public.app_users
      where auth_user_id = v_auth_user_id
        and account_type in ('HOTEL', 'PROFESSIONAL')
        and status = 'ACTIVE') <> 1 then
    raise exception 'Esperada exatamente uma conta parceira ativa; promoção cancelada';
  end if;

  alter table public.app_users disable trigger app_users_immutable_account_type;
  update public.app_users
  set account_type = 'ADMIN', status = 'ACTIVE'
  where auth_user_id = v_auth_user_id
    and account_type in ('HOTEL', 'PROFESSIONAL')
    and status = 'ACTIVE';
  get diagnostics v_rows = row_count;
  alter table public.app_users enable trigger app_users_immutable_account_type;

  if v_rows <> 1 then
    raise exception 'Atualização inesperada; promoção cancelada';
  end if;
end;
$$;

commit;
```

Executa-o apenas no container local, por exemplo:

```sh
docker exec -i supabase_db_wellweb-mvp-local-only psql -X -U postgres -d postgres -v ON_ERROR_STOP=1
```

Cola o bloco SQL na sessão. Depois confirma `account_type = 'ADMIN'` e `status =
'ACTIVE'`, termina a sessão na aplicação e volta a entrar para recarregar as
permissões. A rota `/admin` deve abrir e o cabeçalho deve mostrar
**Administração**. Nunca executar este bloco numa ligação remota.

## Testar a revisão de parceiros

1. Cria ou usa uma conta HOTEL e uma PROFESSIONAL separadas da conta ADMIN.
2. Completa e submete os perfis; confirma que o estado indica **Pendente de
   aprovação**.
3. Termina sessão e entra com a conta ADMIN; abre `/admin`.
4. Filtra por **Pendentes**, abre cada perfil e confirma os dados/fotografias.
5. Aprova um perfil e rejeita o outro. Confirma os estados no filtro **Todos** e
   nos dashboards das contas parceiras. Um perfil rejeitado pode ser atualizado
   e submetido novamente.

Não são necessárias alterações às migrations históricas para este bootstrap.
