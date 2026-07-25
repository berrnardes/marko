# Deploy do Marko num servidor Hetzner limpo

Do zero — VPS recém-criada, banco vazio, nenhuma sessão de WhatsApp — até o CRM
operando. Segue a ordem real de dependências: quem não pode subir antes de quê.

Para **migrar dados de uma instalação existente**, este documento não basta:
veja `docs/ops/runbook-tenancy-cutover.md`, que trata do backfill e da janela de
cutover com dados em produção. Aqui a premissa é banco vazio, o que elimina o
passo mais delicado daquele runbook.

## 0. O que roda onde

O sistema é dividido em duas máquinas, e isso não é acidental: o app é
serverless na Vercel, e o Hetzner hospeda exatamente o que a Vercel não
consegue manter de pé — um banco, um gateway de WhatsApp sempre conectado e um
consumidor de fila contínuo.

```
                        ┌─────────────────────────────────────────┐
   navegador ──HTTPS──▶ │  Vercel: app Next.js (CRM + rotas API)  │
                        └───────┬─────────────────────────┬───────┘
                                │ TLS                     │ HTTPS
                                ▼                         ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ Hetzner (docker compose)                                             │
  │                                                                      │
  │   pgbouncer:5432 ──▶ postgres ◀── worker (pg-boss, conexão direta)   │
  │   (público, TLS)      (interno)      │                               │
  │                            ▲         └──▶ waha:3000 (rede interna)   │
  │                            │                    ▲                    │
  │                       db-backup            caddy:80/443 ──▶ público  │
  └──────────────────────────────────────────────────────────────────────┘
```

Dois caminhos até o banco, de propósito:

- **App (Vercel)** abre e fecha conexões o tempo todo → entra pelo **PgBouncer**
  em modo transação, senão esgota o `max_connections`.
- **Worker (pg-boss)** exige **afinidade de sessão** → conexão direta ao
  Postgres pela rede Docker. Passar o worker pelo pooler de transação quebra a
  fila.

Containers: `postgres`, `pgbouncer`, `waha`, `worker`, `caddy`, `db-backup`.
Único com portas na internet: `caddy` (80/443) e `pgbouncer` (5432).

## 1. Pré-requisitos

**Servidor.** Hetzner Cloud CX22 ou maior (2 vCPU / 4 GB) com Ubuntu 24.04. O
WAHA sozinho consome ~1 GB; abaixo de 4 GB o Postgres e o WAHA competem por
memória.

**DNS** (zona `markohome.com.br`), dois registros `A` apontando para o IP
público do servidor:

| Nome | Aponta para | Serve |
|---|---|---|
| `waha.markohome.com.br` | IP do Hetzner | WAHA atrás do Caddy (TLS) |
| `db.markohome.com.br` | IP do Hetzner | PgBouncer |

O `waha.` precisa resolver **antes** de subir o Caddy — ele valida o desafio
ACME do Let's Encrypt no primeiro boot e, se falhar repetidamente, bate no rate
limit do LE.

**Firewall do Hetzner** — liberar entrada em:

| Porta | Origem | Motivo |
|---|---|---|
| 22 | seu IP | SSH |
| 80 | qualquer | desafio ACME (obrigatório para o TLS do Caddy) |
| 443 | qualquer | WAHA público |
| 5432 | qualquer | PgBouncer — a Vercel não tem IP fixo |

A 5432 aberta ao mundo é protegida por senha forte + TLS, não por rede. Use uma
senha de verdade no `POSTGRES_PASSWORD`.

## 2. Preparar o servidor

```bash
ssh root@<IP>

apt update && apt upgrade -y
apt install -y ca-certificates curl git

# Docker Engine + compose plugin (repositório oficial)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

docker --version && docker compose version
```

O servidor **não** precisa de Node.js: o worker roda dentro do container e as
migrations são aplicadas da sua máquina de dev.

## 3. Código e segredos

O CI/CD (`.github/workflows/deploy-worker.yml`) faz `cd ~/marko` por SSH — o
clone precisa ficar exatamente nesse caminho, ou o deploy automático quebra.

```bash
cd ~
git clone https://github.com/berrnardes/marko.git
cd ~/marko
```

**Certificado TLS do PgBouncer** (autoassinado — por isso o app usa
`sslmode=no-verify`):

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout certs/db.key -out certs/db.crt -subj "/CN=db.markohome.com.br"

# O PgBouncer roda como não-root no container e precisa LER a chave.
chmod 644 certs/db.crt certs/db.key
```

O `644` na chave privada é aceitável aqui: `certs/` está no `.gitignore`, nunca
sai do servidor, e o certificado serve só ao PgBouncer.

**Variáveis de produção:**

```bash
cp .env.production.example .env.production
nano .env.production
```

Preencher no mínimo:

| Variável | Observação |
|---|---|
| `POSTGRES_PASSWORD` | senha forte; alimenta postgres, pgbouncer e backup |
| `WAHA_API_KEY` | sem ela o WAHA sorteia uma chave a cada restart e devolve 401 |
| `WAHA_WEBHOOK_HMAC_SECRET` | **precisa ser idêntica na Vercel** — ver §10 |
| `WAHA_WEBHOOK_URL` | `https://<seu-app>.vercel.app/api/waha/webhook` |
| `WAHA_DASHBOARD_PASSWORD` | o dashboard fica público atrás do Caddy |
| `WHATSAPP_SWAGGER_PASSWORD` | idem |
| `CONSULTANT_NOTIFY_NUMBERS` | E.164, separados por vírgula; vazio desliga o alerta |
| `CRM_BASE_URL` | URL do app, sem barra final |

Deixe `CADENCE_TEST_MODE` ausente. Ligado, ele roda a cadência em segundos com
3 toques em vez dos 5 toques / 15 dias reais.

## 4. Subir o banco

Só o banco por enquanto — o worker ainda não tem schema para consumir.

```bash
docker compose --env-file .env.production up -d postgres pgbouncer
docker compose ps          # ambos Up; postgres healthy
```

Teste o caminho público **de fora do servidor** (é o caminho que a Vercel usa):

```bash
psql "postgres://marko:SENHA@db.markohome.com.br:5432/marko?sslmode=require" -c "select 1"
```

Falhou? Verifique nesta ordem: DNS resolvendo, porta 5432 no firewall,
permissão de leitura em `certs/db.key` (`docker compose logs pgbouncer`).

> Pelo `psql`, `sslmode=require` não verifica CA e aceita o autoassinado. É o
> node-postgres que exige `no-verify` na URL — daí a diferença entre o comando
> acima e a `DATABASE_URL` do app.

## 5. Migrations

Rode **da sua máquina de dev** (o servidor não tem Node). No `.env` local,
aponte a `DATABASE_URL` para o servidor novo:

```
DATABASE_URL=postgres://marko:SENHA@db.markohome.com.br:5432/marko?sslmode=no-verify
```

```bash
npm ci
npm run db:migrate      # aplica 0000 → 0003
```

**Confira o resultado — não confie na saída.** O `drizzle-kit migrate` já
falhou silenciosamente neste projeto (ele casa migrations pelo `created_at` do
`meta/_journal.json`, não pelo hash do arquivo; um journal desalinhado faz ele
pular arquivos e sair com código 0):

```bash
docker compose exec -T postgres psql -U marko -d marko -c '\d leads'
```

Espere ver `organization_id | text | not null` e **nenhuma** coluna `score` ou
`classification_band`. Confira também:

```bash
docker compose exec -T postgres psql -U marko -d marko -c '\d message_templates'  # PK (organization_id, template_key)
docker compose exec -T postgres psql -U marko -d marko -c '\d whatsapp_numbers'   # unique em session_name
```

> A `0003` é **editada à mão** (ela reescreve os estados legados antes de trocar
> o CHECK). Nunca a regenere com `drizzle-kit generate` — o arquivo gerado troca
> a constraint sem migrar os dados.

O passo de backfill do runbook de cutover (`npm run db:backfill-org`) **não se
aplica aqui**: não há linhas para backfillar num banco vazio.

## 6. Primeiro usuário e primeira organização

⚠️ **Este passo não é automatizado e o sistema não funciona sem ele.**

O cadastro público está fechado (`disableSignUp` em `src/services/auth.ts`), e
não existe no código nenhum caminho que crie uma organização. O
`db:seed-admin` cria apenas o usuário e sua credencial — sem uma linha em
`member`, o login funciona mas **toda rota do CRM responde 403 `no active
organization`**, porque o `activeOrganizationId` da sessão vem da associação do
usuário (`src/app/api/crm/_lib/guard.ts:50`).

**6a. Criar o admin** (da máquina de dev, com o mesmo `.env` do passo 5 —
precisa também de `BETTER_AUTH_SECRET` e `BETTER_AUTH_URL`):

```bash
ADMIN_EMAIL=voce@exemplo.com \
ADMIN_PASSWORD='uma-senha-forte' \
ADMIN_NAME='Seu Nome' \
npm run db:seed-admin
```

**6b. Criar a organização e a associação** (SQL direto — não há UI para isso):

```sql
-- No servidor:
--   docker compose exec -T postgres psql -U marko -d marko

INSERT INTO organization (id, name, slug)
VALUES ('org_marko', 'Marko', 'marko');

INSERT INTO member (id, organization_id, user_id, role, receives_handoff_alerts)
SELECT 'mem_' || u.id, 'org_marko', u.id, 'owner', true
FROM "user" u
WHERE u.email = 'voce@exemplo.com';

-- Confirme: deve retornar exatamente uma linha.
SELECT m.id, m.role, o.name, u.email
FROM member m
JOIN organization o ON o.id = m.organization_id
JOIN "user" u ON u.id = m.user_id;
```

Guarde o `organization_id` (`org_marko` acima) — o passo 7 e qualquer operação
manual no banco precisam dele.

`organization` e `member` são tabelas de auth e **não** entram no RLS do passo
7, então esses inserts funcionam com ou sem RLS ativo.

## 7. RLS — a rede de segurança

Enforcement duplo: os repositories já nascem amarrados a uma organização
(aplicação), e o RLS garante que uma query que esqueça o filtro devolva **zero
linhas** em vez de todas. Num servidor limpo é barato ligar agora, antes de
existir qualquer dado.

Este passo tem um acoplamento obrigatório: com `FORCE ROW LEVEL SECURITY` as
policies passam a valer **também para a dona das tabelas**, então o worker
precisa trocar de role no mesmo momento.

```bash
# 7a. Roles. EDITE a senha de marko_worker no arquivo antes de rodar.
docker compose exec -T postgres psql -U marko -d marko -f - < docs/ops/rls-roles.sql

# 7b. Policies + a função app.resolve_session_org (resolve sessão WAHA → org).
docker compose exec -T postgres psql -U marko -d marko -v ON_ERROR_STOP=1 \
  -f - < docs/ops/rls-policies.sql
```

O `rls-policies.sql` termina com as próprias queries de verificação. As duas que
importam:

- as nove tabelas de domínio com `relrowsecurity = t` **e**
  `relforcerowsecurity = t`. Um `relforcerowsecurity = f` significa que as
  policies não valem para a dona — ou seja, a rede não existe;
- `SELECT count(*) FROM leads` sem contexto de organização retornando **0**.

**7c. Apontar o worker para a nova role.** Em `.env.production`:

```
DATABASE_URL=postgres://marko_worker:<senha-do-7a>@postgres:5432/marko
```

Essa linha sobrescreve o default injetado pelo `docker-compose.yml` (que usa
`marko`). Nada muda na Vercel: o app continua entrando pelo PgBouncer como
`marko`, que é exatamente quem o `FORCE` passa a cobrir.

> O cabeçalho do `rls-roles.sql` diz "rode antes da migration 0003". Isso vale
> para o cutover com dados existentes; num banco vazio a ordem
> migrations → roles → policies é equivalente e mais simples.

## 8. Subir o resto da stack

```bash
docker compose --env-file .env.production up -d --build waha worker caddy db-backup
docker compose ps
docker compose logs -f worker     # espere "worker ready", sem erro de conexão
```

O Caddy emite o certificado do `waha.markohome.com.br` no primeiro boot:

```bash
docker compose logs caddy | grep -i "certificate obtained"
curl -I https://waha.markohome.com.br     # 200 ou 401, nunca erro de TLS
```

## 9. Conectar o WhatsApp

O WAHA precisa de uma sessão autenticada por QR code. Duas rotas:

- **Pelo CRM** (preferível): tela de Números → conectar → o app cria a sessão e
  renderiza o QR lendo a API do WAHA. Exige a Vercel já configurada (§10).
- **Pelo dashboard do WAHA**: `https://waha.markohome.com.br/dashboard`, com
  `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD`.

A sessão persiste no volume `waha-sessions` e sobrevive a restarts. O nome da
sessão é o que liga um inbound à organização (`whatsapp_numbers.session_name` é
unique global) — se você criar a sessão pelo dashboard, garanta que existe a
linha correspondente em `whatsapp_numbers` com o `organization_id` certo.

## 10. Configurar a Vercel

No projeto da Vercel, ambiente **Production**:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | `postgres://marko:SENHA@db.markohome.com.br:5432/marko?sslmode=no-verify` |
| `BETTER_AUTH_SECRET` | segredo forte e aleatório |
| `BETTER_AUTH_URL` | `https://<seu-app>.vercel.app` |
| `NEXT_PUBLIC_BETTER_AUTH_URL` | mesma URL acima |
| `WAHA_BASE_URL` | `https://waha.markohome.com.br` (pública, via Caddy) |
| `WAHA_API_KEY` | mesma do `.env.production` |
| `WAHA_WEBHOOK_HMAC_SECRET` | **mesma do `.env.production`** — ver abaixo |
| `CONSULTANT_NOTIFY_NUMBERS` | E.164, separados por vírgula |
| `CRM_BASE_URL` | URL do app, sem barra final |
| `LOG_LEVEL` | `info` (opcional) |

**Fuso horário:** não configure `TZ` na Vercel — é uma env reservada em todos os
planos. O app pina `America/Sao_Paulo` em código no boot
(`src/instrumentation.ts`); para trocar sem deploy, use `APP_TZ`.

Isso importa: janela de envio (9h–20h), virada do contador diário anti-ban e
contagem de dias do warm-up usam o fuso **local do processo**. Errado, a janela
roda 06h–17h no Brasil e o contador vira às 21h — dobrando o volume diário de um
número dentro do mesmo dia brasileiro, com risco real de ban.

### ⚠️ O HMAC do webhook tem dois lados

O mesmo segredo precisa existir **nos dois lugares**, com nomes diferentes:

| Onde | Variável |
|---|---|
| Vercel (app) | `WAHA_WEBHOOK_HMAC_SECRET` |
| Hetzner (`.env.production` → container WAHA) | `WAHA_WEBHOOK_HMAC_SECRET`, repassada ao WAHA como `WHATSAPP_HOOK_HMAC_KEY` |

O WAHA assina cada webhook (SHA-512 sobre o corpo cru, header `X-Webhook-Hmac`)
e o app **exige** a assinatura. Faltando de um lado: 401 nas entregas. Faltando
no lado da Vercel: 500. Nos dois casos o inbound morre silenciosamente — foi
exatamente essa a causa de um outage de 2 dias.

Após configurar, faça um redeploy na Vercel (variáveis novas só valem em builds
novos).

## 11. CI/CD

O `deploy-worker.yml` dispara em push para `main`: builda a imagem do worker,
publica no GHCR e reinicia o serviço no Hetzner por SSH. O app Next.js não entra
nesse fluxo — a Vercel tem a integração git própria.

**Antes do primeiro deploy automático**, corrija o placeholder em
`docker-compose.prod.yml`:

```yaml
image: ghcr.io/OWNER/marko-worker:latest   # troque OWNER por berrnardes (minúsculas)
```

Secrets em Settings → Secrets and variables → Actions:

| Secret | Uso |
|---|---|
| `HETZNER_HOST` | IP ou hostname |
| `HETZNER_USER` | usuário SSH |
| `HETZNER_SSH_KEY` | chave **privada** com acesso ao servidor |
| `HETZNER_SSH_PORT` | opcional; default 22 |
| `GHCR_PULL_TOKEN` | PAT `read:packages`, se o pacote for privado |
| `DATABASE_URL` | só se ligar migrations automáticas |

O job de migrations é opcional e só roda com a variável `RUN_MIGRATIONS=true`.
Aplicar migrations à mão (§5) e conferir o resultado é mais seguro neste
projeto, dado o histórico de falha silenciosa do drizzle-kit.

## 12. Verificação fim a fim

- [ ] `docker compose ps` — seis serviços Up, `postgres` healthy
- [ ] `psql` externo pelo `db.markohome.com.br` responde `select 1`
- [ ] `https://waha.markohome.com.br` com TLS válido
- [ ] Login no CRM com a conta do §6
- [ ] A lista de leads carrega (prova que RLS + escopo por org conversam)
- [ ] Import de um CSV pequeno cria leads e agenda a cadência
- [ ] Uma resposta real de WhatsApp muda o estado do lead — exercita
      `app.resolve_session_org` + HMAC + worker de uma vez
- [ ] `docker compose logs worker` sem `job.org_unresolved`
- [ ] `docker compose run --rm db-backup && docker compose exec db-backup ls -lh /backups`

## 13. Operação

**Logs.** Todos os serviços rotacionam em 5 arquivos de 10 MB.

```bash
docker compose logs -f worker
docker compose logs --tail=200 waha
```

**Backup.** `pg_dump` noturno às 03:00 (America/Sao_Paulo) no volume
`pg-backups`, retenção de 14 dias. A cópia offsite é opcional e configurada só
por variáveis de ambiente (`RCLONE_REMOTE` e afins — ver
`.env.production.example`). **Configure o offsite**: um backup que vive no mesmo
disco do banco não sobrevive à perda do servidor.

Backup manual e restore:

```bash
docker compose run --rm db-backup                  # dump imediato
docker compose exec db-backup ls -lh /backups

docker compose cp <arquivo>.sql.gz postgres:/tmp/restore.sql.gz
docker compose exec postgres bash -c \
  "gunzip -c /tmp/restore.sql.gz | psql -U marko -d marko"
```

**Atualizar o worker à mão** (sem CI):

```bash
cd ~/marko && git pull --ff-only
docker compose --env-file .env.production up -d --build worker
```

**Nunca** rode `docker compose down -v` em produção — o `-v` apaga o volume
`pg-data`, que é o banco inteiro.

## 14. Armadilhas conhecidas

| Sintoma | Causa |
|---|---|
| Inbound parou; 401/500 no webhook | HMAC configurado em só um dos lados (§10) |
| `403 no active organization` após login | falta a linha em `member` (§6b) |
| WAHA responde 401 com a chave certa | `WAHA_API_KEY` ausente → o WAHA sorteia uma no boot |
| Dashboard do WAHA rejeita a senha | mesma causa: credenciais não persistidas no `.env.production` |
| `db:migrate` "passou" mas a coluna não existe | falha silenciosa do drizzle-kit — sempre confira com `\d` (§5) |
| Worker sobe e não consome a fila | worker apontado ao PgBouncer; pg-boss exige conexão direta |
| Envios fora da janela / cap diário dobrado | `TZ` do worker não é `America/Sao_Paulo` |
| Caddy não emite certificado | DNS do `waha.` não resolve, ou porta 80 fechada |
| Query nova devolve dados de outro tenant | `relforcerowsecurity = f` — o RLS não cobre a dona (§7) |
