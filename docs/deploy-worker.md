# Deploy do worker (e do WAHA) na Hetzner Cloud

Guia passo a passo para subir o **worker** e o **WAHA** numa máquina da Hetzner
Cloud, com o app Next.js na Vercel e o Postgres no Supabase.

```
┌──────────────────────┐        ┌──────────────────────────────────┐
│  App Next.js          │        │  Servidor Hetzner (Docker)       │
│  Vercel               │        │  ┌────────────┐  ┌────────────┐  │
│  (CRM, API, webhook)  │        │  │   WAHA     │  │   worker   │  │
└──────────┬───────────┘        │  └─────┬──────┘  └─────┬──────┘  │
           │                     └────────┼──────────────┼─────────┘
           │                              │              │
           └──────────────┬───────────────┘──────────────┘
                          │  todos apontam para o mesmo Postgres
                 ┌────────▼─────────┐
                 │  Postgres        │
                 │  Supabase        │
                 └──────────────────┘
```

Os arquivos de deploy já estão no repositório:

- `Dockerfile.worker` — imagem do worker (roda `tsx src/worker/index.ts`).
- `docker-compose.yml` — sobe WAHA + worker juntos.
- `.dockerignore` — mantém o contexto de build enxuto.
- `.env.production.example` — modelo das variáveis de produção.

---

## Pré-requisitos

1. Uma máquina na Hetzner Cloud (um CX22 já é suficiente para começar).
2. **Docker** e **Docker Compose** instalados nela.
3. Projeto no **Supabase** com o Postgres criado.
4. App já implantado (ou prestes a ser) na **Vercel**, com um domínio público.

---

## Passo 1 — Pegar a connection string DIRETA do Supabase

No painel do Supabase: **Project Settings → Database → Connection string**.

> ⚠️ **Use a conexão DIRETA (porta `5432`), não o pooler de transação (`6543`).**
> O worker é um processo único e de longa duração, e o pg-boss precisa de
> afinidade de sessão. O pooler de transação (Supavisor/PgBouncer) quebraria o
> pg-boss. O pooler é para o app na Vercel (serverless), que abre muitas
> conexões curtas — não para o worker.

Anote algo como:

```
postgres://postgres:SUA_SENHA@db.SEU_PROJETO.supabase.co:5432/postgres?sslmode=require
```

---

## Passo 2 — Aplicar as migrations no Supabase

As migrations precisam rodar uma vez contra o Supabase antes do primeiro start.
O `drizzle-kit` é uma dependência de desenvolvimento, então o jeito mais simples
é rodar da sua máquina local apontando o `DATABASE_URL` para o Supabase:

```bash
DATABASE_URL="postgres://postgres:SUA_SENHA@db.SEU_PROJETO.supabase.co:5432/postgres?sslmode=require" \
  npm run db:migrate
```

O pg-boss cria as próprias tabelas (no schema `pgboss`) automaticamente no
primeiro boot do worker — não precisa migrar isso manualmente.

---

## Passo 3 — Levar o código para o servidor

Clone o repositório na máquina da Hetzner (ou use seu fluxo de CI):

```bash
git clone <seu-repo> marko && cd marko
```

---

## Passo 4 — Criar o `.env.production`

Copie o modelo e preencha com os valores reais:

```bash
cp .env.production.example .env.production
```

Preencha:

| Variável                   | Valor                                                   |
| -------------------------- | ------------------------------------------------------- |
| `DATABASE_URL`             | A connection string DIRETA do Supabase (Passo 1).       |
| `WAHA_API_KEY`             | Uma chave forte; a mesma é usada pelo serviço `waha`.   |
| `WAHA_WEBHOOK_HMAC_SECRET` | O mesmo segredo configurado no WAHA e no app da Vercel. |
| `WAHA_SESSION`             | `default` (ou o nome da sua sessão).                    |
| `WAHA_WEBHOOK_URL`         | `https://SEU-APP.vercel.app/api/waha/webhook`.          |

> `WAHA_BASE_URL` do worker **não** vai no `.env.production` — o
> `docker-compose.yml` já o define como `http://waha:3000` (rede interna).
>
> **Não** defina `CADENCE_TEST_MODE` (deixe ausente). Em produção a cadência
> precisa rodar nos 5 toques / 15 dias reais.

---

## Passo 5 — Subir os containers

```bash
docker compose --env-file .env.production up -d --build
```

Isso builda a imagem do worker, baixa o WAHA e sobe os dois com
`restart: unless-stopped` (voltam sozinhos após reboot da máquina).

Verifique:

```bash
docker compose ps           # ambos devem estar "running"
docker compose logs -f worker
```

Você deve ver:

```
[worker] starting…
[worker] ready — cadence, nurture, and outbound handlers registered.
```

> Se aparecer o aviso `⚠️ CADENCE_TEST_MODE is ON` ou
> `⚠️ ANTIBAN_TEST_MODE is ON`, remova essa variável do `.env.production` e suba
> de novo — não é para estar ligada em produção.

---

## Passo 6 — Autenticar a sessão do WAHA

Acesse o dashboard do WAHA (`http://IP_DA_HETZNER:3000`, idealmente atrás de um
proxy com TLS), inicie a sessão e leia o QR code com o WhatsApp do número de
saída. O volume `waha-sessions` mantém essa autenticação entre reinícios.

Configure o webhook da sessão apontando para `WAHA_WEBHOOK_URL` com o evento
`message` e o **HMAC** igual a `WAHA_WEBHOOK_HMAC_SECRET`.

---

## Passo 7 — Configurar a Vercel (o app)

No projeto da Vercel, configure as variáveis de ambiente:

- `DATABASE_URL` → aqui sim use a conexão **POOLED** do Supabase (porta `6543`,
  modo transação), porque o app é serverless e abre muitas conexões curtas.
- `WAHA_BASE_URL` → a URL pública do seu WAHA na Hetzner.
- `WAHA_API_KEY`, `WAHA_WEBHOOK_HMAC_SECRET`, `WAHA_SESSION`.
- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_BETTER_AUTH_URL` →
  apontando para o domínio de produção.

---

## Operação do dia a dia

```bash
# Ver logs do worker
docker compose logs -f worker

# Reiniciar só o worker (ex.: após mudança de env)
docker compose --env-file .env.production up -d worker

# Atualizar após um git pull (rebuilda a imagem do worker)
git pull && docker compose --env-file .env.production up -d --build worker

# Parar tudo
docker compose down
```

---

## Por que `npm ci` e npm 11 no Dockerfile?

A imagem usa `npm ci --omit=dev` para um build reproduzível e enxuto: como o
`tsx` foi movido para `dependencies`, ele (e o esbuild) entram mesmo sem as
devDependencies. O Dockerfile também faz `npm install -g npm@11` porque o
lockfile é escrito pelo npm 11 (dev), e o npm 10 que vem na imagem base
recusaria esse lockfile no `npm ci`.

---

## Checklist rápido

- [ ] Migrations aplicadas no Supabase (`npm run db:migrate`).
- [ ] `.env.production` preenchido com a conexão **DIRETA** (5432) no worker.
- [ ] `CADENCE_TEST_MODE` **ausente** em produção.
- [ ] `ANTIBAN_TEST_MODE` **ausente** em produção (e `CADENCE_TEST_MODE` também, pois ele o ativa).
- [ ] `docker compose ... up -d --build` rodando; worker em `running`.
- [ ] Sessão do WAHA autenticada (QR) e webhook apontando para a Vercel.
- [ ] Vercel com a conexão **POOLED** (6543) e demais env vars.

---

## CI/CD com GitHub Actions

O deploy manual (`git pull && docker compose ... up -d --build`) continua
funcionando, mas o repositório agora traz dois workflows que automatizam tudo:

| Workflow                              | Quando roda                  | O que faz                                                                  |
| ------------------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`            | todo push e pull request     | `npm run lint`, `typecheck` e `test`.                                      |
| `.github/workflows/deploy-worker.yml` | push para `main` (ou manual) | builda a imagem do worker, publica no GHCR e reinicia o worker na Hetzner. |

### Como o deploy funciona

1. **Build + push** — o Actions builda `Dockerfile.worker` e publica em
   `ghcr.io/OWNER/marko-worker` com as tags `latest` e o SHA do commit (cache de
   build via GitHub Actions cache, então builds repetidos são rápidos).
2. **Migrations (opcional)** — se a variável de repositório `RUN_MIGRATIONS`
   estiver `true`, roda `npm run db:migrate` contra o `DATABASE_URL` (use a
   conexão **DIRETA** do Supabase aqui também).
3. **Deploy** — o Actions faz SSH na Hetzner, `git pull` (para atualizar os
   arquivos de compose), puxa a imagem nova do GHCR e recria **só** o serviço
   `worker` com `docker-compose.prod.yml`. O WAHA não é reiniciado.

O app Next.js **não** entra nesse fluxo — ele é deployado pela Vercel via a
integração git dela.

### O que configurar uma vez

**1. Secrets do repositório** (Settings → Secrets and variables → Actions → _Secrets_):

| Secret             | Para quê                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `HETZNER_HOST`     | IP/hostname do servidor.                                                                            |
| `HETZNER_USER`     | usuário SSH (ex.: `root` ou `deploy`).                                                              |
| `HETZNER_SSH_KEY`  | chave **privada** SSH com acesso ao servidor.                                                       |
| `HETZNER_SSH_PORT` | (opcional) porta SSH; default `22`.                                                                 |
| `GHCR_PULL_TOKEN`  | (opcional) PAT com `read:packages` para o servidor puxar a imagem se o pacote GHCR for **privado**. |
| `DATABASE_URL`     | (opcional) conexão DIRETA do Supabase, se for rodar migrations no CI.                               |

> O push para o GHCR usa o `GITHUB_TOKEN` automático (com `packages: write`) —
> não precisa de secret para isso. O `GHCR_PULL_TOKEN` só é necessário do lado
> do servidor; se você tornar o pacote GHCR público, pode dispensá-lo.

**2. Variável** (aba _Variables_, não Secrets): `RUN_MIGRATIONS=true` se quiser
que o CI aplique migrations no deploy. Caso prefira controlar isso na mão,
deixe ausente e remova/ignore o job `migrate`.

**3. Chave SSH** — gere um par dedicado ao deploy e autorize a pública no
servidor:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f deploy_key
# copie deploy_key.pub para ~/.ssh/authorized_keys no servidor
# cole o conteúdo de deploy_key (a privada) no secret HETZNER_SSH_KEY
```

**4. Imagem no compose** — edite `docker-compose.prod.yml` e troque `OWNER` pelo
dono do repositório no GitHub (em minúsculas), ex.: `ghcr.io/bernardes/marko-worker:latest`.

**5. Servidor** — o servidor precisa ter o repositório clonado em `~/marko`
(como no Passo 3) e o `.env.production` preenchido (Passo 4). O CI não cria
esses arquivos; ele só atualiza o código e reinicia o container.

> `docker-compose.prod.yml` usa a tag de merge `!reset` para remover o `build:`
> local — requer Docker Compose **v2.24+**. Confira com `docker compose version`.

### Primeiro deploy

Faça o setup dos Passos 1–6 manualmente uma vez (migrations, `.env.production`,
sessão WAHA autenticada). A partir daí, todo push para `main` que passar no CI
reconstrói e reinicia o worker sozinho. Também dá para disparar pela aba
**Actions → Deploy worker (Hetzner) → Run workflow**.
