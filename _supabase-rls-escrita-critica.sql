-- ============================================================================
-- CRM AUDAZ — RLS: trava as ações de ESCRITA mais perigosas
-- ============================================================================
-- Por que isso existe:
-- A autorização por cargo (Diretor/Gerente/Administrativo/Corretor) hoje só
-- existe em JavaScript no navegador. Qualquer usuário autenticado consegue
-- abrir o console do navegador e chamar o Supabase direto, pulando toda
-- checagem de permissão da tela — inclusive existe uma função no app,
-- `resetSystem()`, que apaga TODAS as tabelas (leads, usuários, config) sem
-- NENHUMA checagem de cargo, só um confirm() do navegador.
--
-- Este script NÃO mexe em LEITURA (o app inteiro assume que consegue ler as
-- tabelas por completo pra popular dropdowns/rankings/contadores pra
-- qualquer cargo — travar isso exigiria auditar cada tela). Só trava:
--   1) ninguém além do Diretor consegue se auto-promover (ou promover
--      outra pessoa) a um cargo acima de Corretor;
--   2) só o Diretor consegue EXCLUIR usuários, leads, ou linhas de
--      configuração (crm_storage) — fecha o resetSystem()/limparTodosLeads()
--      via API direta por qualquer outro cargo;
--   3) só o Diretor consegue editar as configurações globais (pipelines,
--      listas de construtoras/empreendimentos, % de nota, mês comercial).
--
-- Como funciona: usa políticas RESTRICTIVE (não PERMISSIVE). Restritivas se
-- combinam por AND com as políticas que já existem no projeto — ou seja,
-- isso RECORTA uma exceção nas regras atuais sem precisar saber o nome ou
-- o conteúdo delas. Não corre risco de "abrir" nada, só de "fechar" a mais
-- (por isso o roteiro de teste + rollback no final).
--
-- COMO USAR:
--  1. Abra o SQL Editor do seu projeto no Supabase.
--  2. Cole e rode este arquivo inteiro.
--  3. Siga o roteiro de verificação no final deste arquivo (comentado).
--  4. Se algo quebrar, rode o bloco de ROLLBACK (também no final).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Funções auxiliares: descobrem o cargo/e-mail de quem está autenticado
--    agora, usando o MESMO critério que o app já usa no navegador (achar o
--    usuário pela tabela `users` comparando e-mail) — só que aqui é o e-mail
--    do próprio token (JWT) de login, não pode ser forjado pelo cliente.
--
--    Nome com prefixo "crm_blob_" DE PROPÓSITO: o projeto já tem funções
--    current_user_role()/current_user_name()/current_user_team() usadas por
--    políticas em outras tabelas (profiles/lead_messages/lead_files — uma
--    estrutura paralela que o app não usa). Sobrescrever essas funções
--    mudaria o comportamento daquelas políticas sem querer — por isso nomes
--    totalmente distintos aqui, só pras tabelas que o app realmente usa.
-- ----------------------------------------------------------------------------

create or replace function crm_blob_user_email()
returns text
language sql
stable
set search_path = public
as $$
  select auth.jwt() ->> 'email';
$$;

create or replace function crm_blob_user_role()
returns text
language sql
stable
set search_path = public
as $$
  select data ->> 'role'
  from users
  where data ->> 'email' = auth.jwt() ->> 'email'
  limit 1;
$$;


-- ----------------------------------------------------------------------------
-- 2) USERS — ninguém escala o próprio cargo (nem o de outra pessoa) além do
--    que já pode hoje: Diretor pode tudo; Administrativo/Gerente só gravam
--    linha com cargo Corretor; qualquer um pode editar a PRÓPRIA linha desde
--    que o cargo dela não mude.
-- ----------------------------------------------------------------------------

drop policy if exists users_insert_role_guard on users;
create policy users_insert_role_guard
on users
as restrictive
for insert
with check (
  crm_blob_user_role() = 'Diretor'
  or (
    crm_blob_user_role() in ('Administrativo', 'Gerente')
    and data ->> 'role' = 'Corretor'
  )
);

drop policy if exists users_update_role_guard on users;
create policy users_update_role_guard
on users
as restrictive
for update
using (true)
with check (
  crm_blob_user_role() = 'Diretor'
  or (
    crm_blob_user_role() in ('Administrativo', 'Gerente')
    and data ->> 'role' = 'Corretor'
  )
  or (
    data ->> 'email' = crm_blob_user_email()
    and data ->> 'role' = crm_blob_user_role()
  )
);

-- ----------------------------------------------------------------------------
-- 3) USERS / LEADS / CRM_STORAGE — exclusão travada no mesmo limite que a UI
--    já usa (ROLE_PERMISSIONS, app.js:4077): Diretor exclui qualquer um;
--    Administrativo/Gerente só excluem usuário com cargo Corretor; Corretor
--    não exclui ninguém. Fecha resetSystem() e limparTodosLeads() (que já
--    são Diretor-only na tela) via chamada direta à API por qualquer outro
--    cargo — e também fecha um Administrativo/Gerente tentando excluir
--    alguém acima do que a UI permite.
-- ----------------------------------------------------------------------------

drop policy if exists users_delete_role_guard on users;
create policy users_delete_role_guard
on users
as restrictive
for delete
using (
  crm_blob_user_role() = 'Diretor'
  or (
    crm_blob_user_role() in ('Administrativo', 'Gerente')
    and data ->> 'role' = 'Corretor'
  )
);

drop policy if exists leads_delete_diretor_only on leads;
create policy leads_delete_diretor_only
on leads
as restrictive
for delete
using (crm_blob_user_role() = 'Diretor');

drop policy if exists crm_storage_delete_diretor_only on crm_storage;
create policy crm_storage_delete_diretor_only
on crm_storage
as restrictive
for delete
using (crm_blob_user_role() = 'Diretor');


-- ----------------------------------------------------------------------------
-- 4) CRM_STORAGE — as chaves de configuração global só o Diretor edita
--    (pipelines, listas de construtoras/empreendimentos, % de nota e mês
--    comercial). Notificações e o resto continuam abertos, sem mudança.
-- ----------------------------------------------------------------------------

drop policy if exists crm_storage_update_config_guard on crm_storage;
create policy crm_storage_update_config_guard
on crm_storage
as restrictive
for update
using (true)
with check (
  key not in ('audaz_pipelines', 'audaz_listas', 'audaz_config')
  or crm_blob_user_role() = 'Diretor'
);


-- ============================================================================
-- ROTEIRO DE VERIFICAÇÃO (rode depois de aplicar, antes de confiar nisso)
-- ============================================================================
-- 1. Login como Diretor no CRM de verdade → confirme que continua editando
--    qualquer usuário, excluindo lead, mudando pipelines/config normalmente.
--
-- 2. Login como um Corretor de TESTE → confirme que ainda consegue editar o
--    próprio perfil (telefone/foto). Depois, no console do navegador (F12),
--    tente isto (troque SEU-ID-AQUI pelo id do próprio usuário de teste):
--
--      await _sb.from('users').update({
--        data: { ...currentUser, role: 'Diretor' }
--      }).eq('id', 'SEU-ID-AQUI');
--
--    Isso deve FALHAR silenciosamente (0 linhas afetadas) — se a mudança de
--    cargo aparecer na tabela, a política não pegou.
--
-- 3. Ainda como o Corretor de teste, confirme que as telas normais (kanban,
--    dropdown de corretor, etc.) continuam funcionando sem erro — este
--    script não mexe em leitura, mas vale conferir.
--
-- 4. Se qualquer coisa quebrar, rode o bloco de ROLLBACK abaixo.
-- ============================================================================


-- ============================================================================
-- ROLLBACK (copie e rode só isto, separado, se precisar desfazer tudo)
-- ============================================================================
-- drop policy if exists users_insert_role_guard on users;
-- drop policy if exists users_update_role_guard on users;
-- drop policy if exists users_delete_role_guard on users;
-- drop policy if exists leads_delete_diretor_only on leads;
-- drop policy if exists crm_storage_delete_diretor_only on crm_storage;
-- drop policy if exists crm_storage_update_config_guard on crm_storage;
-- drop function if exists crm_blob_user_role();
-- drop function if exists crm_blob_user_email();
-- ============================================================================
