# Runbook: cutover de tenancy (migrations 0001–0002 + RLS)

Ordem de aplicação do retrofit inteiro em produção. O código dos PR1–PR3 já
está no repositório e é **inerte** até estes passos rodarem — `withOrg` sem
policies é uma transação comum, e `findNumberBySessionName` cai no caminho
antigo enquanto `app.resolve_session_org()` não existir.

Contexto: `DATABASE_URL` aponta para o Hetzner. O app na Vercel entra pelo
PgBouncer (`:5432`, transaction mode); o worker fala direto com o Postgres pela
rede Docker. **Tudo abaixo roda direto no Postgres, nunca pelo PgBouncer.**

## 0. Pré-condições

- [ ] Cadastro público continua fechado (`disableSignUp` em `@/services/auth`).
- [ ] Existe uma organização fundadora, e você sabe o `id` dela.
- [ ] Sem imports/cadências em voo (a janela é curta, mas o worker para).

## 1. Backup

```bash
docker compose exec -T postgres pg_dump -U marko -d marko \
  | gzip > backup-pre-tenancy-$(date +%F-%H%M).sql.gz
```

Confira o tamanho do arquivo antes de seguir. Este é o único ponto de retorno
para os passos 3 e 4.

## 2. Pré-check de `session_name` duplicado

A migration 0002 cria `UNIQUE (session_name)` em `whatsapp_numbers`. Se houver
duplicata, ela falha e faz rollback.

```sql
SELECT session_name, count(*) FROM whatsapp_numbers
GROUP BY session_name HAVING count(*) > 1;
```

Zero linhas ⇒ pode seguir. Qualquer linha ⇒ resolva à mão antes (a sessão
duplicada é a que resolve inbound→org; duas orgs com o mesmo nome tornam essa
resolução ambígua).

## 3. Expand + backfill

```bash
npm run db:migrate           # aplica 0001 (colunas nullable + FKs + índices)
```

Verifique de verdade — `drizzle-kit migrate` já falhou silenciosamente neste
projeto:

```bash
docker compose exec -T postgres psql -U marko -d marko -c '\d leads'
```

Espere `organization_id | text | not null` **ainda não** — nesta fase a coluna é
nullable. Então:

```bash
npm run db:backfill-org -- --org-id=<ID_DA_ORG_FUNDADORA>
```

O script imprime a org escolhida e os counts por tabela e pede confirmação. Ele
é idempotente (só toca `organization_id IS NULL`), então pode ser repetido.

> **Rode o backfill ANTES do passo 5.** Depois que o RLS estiver ativo, ele roda
> como `marko`, que passa a estar sujeito às policies, e não enxergaria as
> linhas que precisa atualizar.

## 4. Contract + máquina de 7 estados

```bash
npm run db:migrate           # aplica 0002 (NOT NULL, uniques, PK composta)
                             # e 0003 (10 -> 7 estados, drop de score/band)
```

A `0003` é **editada à mão** (ADR-003): ela reescreve os valores legados antes
de trocar o CHECK, e levanta exceção se sobrar algum estado não mapeado. Não
regenere pelo drizzle-kit — o gerado troca a constraint sem migrar os dados e
aborta na primeira linha.

Confira o resultado do rename:

```sql
SELECT lifecycle_state, count(*) FROM leads GROUP BY 1 ORDER BY 2 DESC;
-- só QUEUED / IN_CADENCE / REPLIED / COMPLETED / WON / LOST / OPTED_OUT
```

Verifique:

```sql
\d leads              -- organization_id NOT NULL; sem score/classification_band
\d message_templates  -- PK composta (organization_id, template_key)
\d whatsapp_numbers   -- whatsapp_numbers_session_name_unique
```

**Ponto de parada seguro.** Daqui o sistema já está correto: a aplicação escopa
tudo por organização (PR2) e o banco tem as constraints. O passo 5 é a rede de
segurança e pode esperar.

## 5. RLS (ADR-004)

Este passo tem um acoplamento obrigatório: **a role do worker muda no mesmo
deploy.** Com `FORCE ROW LEVEL SECURITY` as policies valem para a dona das
tabelas, então um worker ainda conectando como `marko` para de funcionar na
hora.

```bash
# 5a. roles (edite a senha de marko_worker antes)
docker compose exec -T postgres psql -U marko -d marko -f - < docs/ops/rls-roles.sql

# 5b. policies
docker compose exec -T postgres psql -U marko -d marko -v ON_ERROR_STOP=1 \
  -f - < docs/ops/rls-policies.sql
```

O próprio `rls-policies.sql` termina com as queries de verificação. As duas que
importam:

- as nove tabelas com `relrowsecurity = t` **e** `relforcerowsecurity = t` —
  `relforcerowsecurity = f` significa que as policies não valem para a dona, ou
  seja, a rede não existe;
- `SELECT count(*) FROM leads` sem contexto retornando **0**.

```bash
# 5c. worker passa a usar marko_worker
#     em .env.production: DATABASE_URL=postgres://marko_worker:<senha>@postgres:5432/marko
docker compose --env-file .env.production up -d --build worker
docker compose logs -f worker    # espere "worker ready"
```

Nada muda na Vercel: o app continua entrando pelo PgBouncer como `marko`, que é
exatamente quem o `FORCE` passa a cobrir.

### Verificação pós-cutover

- [ ] Login no CRM e a lista de leads carrega (RLS + `withOrg` conversando).
- [ ] Import de um CSV pequeno cria leads e agenda a cadência.
- [ ] Uma resposta real de WhatsApp chega e muda o estado do lead (isso exercita
      `app.resolve_session_org` + `withOrg` no webhook).
- [ ] `docker compose logs worker` sem `job.org_unresolved`.

### Rollback

```sql
ALTER TABLE leads DISABLE ROW LEVEL SECURITY;
-- ... idem para as outras oito
```

E volte a `DATABASE_URL` do worker para `marko`. As policies podem ficar no
banco: são inertes com o RLS desligado. Os passos 3 e 4 **não** têm rollback por
DDL — é o dump do passo 1.

## 6. Depois

- Reabrir o cadastro público (remover `disableSignUp`) só depois desta lista
  inteira, incluindo o passo 5.
- Remover o fallback de backlog (`resolveOrganizationIdForLead` e o probe em
  `findNumberBySessionName`) quando os jobs pré-retrofit tiverem expirado.
