# Migração do banco: Supabase → Postgres no Hetzner

Runbook para mover o Postgres do Supabase para o próprio servidor Hetzner
(containers `postgres` + `pgbouncer` + `db-backup` do docker-compose). O app
continua na Vercel; só a origem dos dados muda.

## Topologia final

```
app Vercel ──TLS──▶ pgbouncer:5432 (público, transaction mode) ─▶ postgres (interno)
worker     ────────▶ postgres:5432 (rede Docker, direto — pg-boss)
db-backup  ────────▶ postgres:5432 → pg_dump noturno → volume + offsite (rclone)
```

Por que dois caminhos (igual ao split que existia no Supabase):

- **Vercel (serverless)** abre/fecha conexões o tempo todo → precisa de pooling
  em **modo transação** (PgBouncer), senão esgota o `max_connections`.
- **Worker (pg-boss)** precisa de **afinidade de sessão** → conexão direta ao
  Postgres pela rede Docker; o pooler de transação o quebraria.

## IMPORTANTE antes de começar

- A schema `pgboss` carrega **jobs futuros reais** (toques de cadência de até
  15 dias); a migração leva os DADOS dela junto, não recria a fila vazia.
- Melhor janela: fora do horário de envio da cadência (fora de 9h–20h).

## Passo a passo

### 1. Preparação (sem downtime)

1. **DNS** (HostGator, zona `markohome.com.br`): registro `A`
   `db.markohome.com.br` → IP público do Hetzner (mesmo IP do `waha`).
2. **Firewall** do Hetzner: liberar entrada na porta **5432** (o app na Vercel
   não tem IP fixo, então a proteção é senha forte + TLS).
3. **Certificado TLS do PgBouncer** (autoassinado, no diretório do compose):

   ```bash
   mkdir -p certs
   openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
     -keyout certs/db.key -out certs/db.crt -subj "/CN=db.markohome.com.br"
   # O PgBouncer roda como usuário não-root no container e precisa LER a chave:
   chmod 644 certs/db.crt certs/db.key
   ```

   (A chave 644 é aceitável aqui: o diretório fica só no servidor, fora do git
   — `certs/` está no `.gitignore` — e o certificado é exclusivo do PgBouncer.)

4. **Senha**: definir `POSTGRES_PASSWORD` forte no `.env.production`.
5. **Subir o banco vazio**:

   ```bash
   docker compose --env-file .env.production up -d postgres pgbouncer
   ```

6. **Smoke test do caminho público** (de fora do servidor, se possível):

   ```bash
   psql "postgres://marko:SENHA@db.markohome.com.br:5432/marko?sslmode=require" -c "select 1"
   ```

   (Pelo `psql` o `sslmode=require` não verifica CA, então funciona com o
   certificado autoassinado; é o node-postgres que exige `no-verify` na URL.)

### 2. Janela de migração (minutos)

1. **Parar o worker** (congela consumo da fila e envios):

   ```bash
   docker compose stop worker
   ```

   Webhooks inbound do WAHA podem falhar por alguns minutos; o WAHA re-tenta.

2. **Dump do Supabase** (URL do *session pooler*, a mesma do worker antigo):

   ```bash
   pg_dump "postgresql://postgres.SEU_PROJETO:SENHA@aws-1-us-west-1.pooler.supabase.com:5432/postgres" \
     --no-owner --no-privileges --format=custom --file=marko.dump
   ```

   O formato custom dumpa TODAS as schemas: `public` (leads, mensagens,
   Better Auth) e `pgboss` (fila com jobs futuros).

3. **Restore no Postgres local**:

   ```bash
   docker compose cp marko.dump postgres:/tmp/marko.dump
   docker compose exec postgres \
     pg_restore -U marko -d marko --no-owner --no-privileges /tmp/marko.dump
   docker compose exec postgres rm /tmp/marko.dump
   ```

   Avisos sobre `CREATE SCHEMA public` já existir são inofensivos.

4. **Conferência** (comparar com os números do Supabase):

   ```bash
   docker compose exec postgres psql -U marko -d marko -c \
     "select 'leads', count(*) from leads
      union all select 'messages', count(*) from messages
      union all select 'pgboss pendentes', count(*) from pgboss.job where state in ('created','retry','active')"
   ```

### 3. Cutover

1. **Worker** (o compose já injeta a `DATABASE_URL` interna):

   ```bash
   docker compose --env-file .env.production up -d --build worker db-backup
   docker compose logs -f worker   # deve registrar os handlers sem erro
   ```

2. **Vercel**: trocar a env `DATABASE_URL` para

   ```
   postgres://marko:SENHA@db.markohome.com.br:5432/marko?sslmode=no-verify
   ```

   e fazer redeploy. (Fuso horário: NÃO é preciso configurar `TZ` na Vercel —
   ela é uma env reservada e o app já pina `America/Sao_Paulo` em código no
   boot, via `src/instrumentation.ts`.) Verificar: login no CRM (Better Auth),
   lista de leads, import de um CSV pequeno (testa enqueue via pg-boss pelo
   pooler).

3. **Backup**: rodar um backup manual e conferir o dump:

   ```bash
   docker compose run --rm db-backup        # um backup imediato
   docker compose exec db-backup ls -lh /backups
   ```

### 4. Descomissionamento

- **Pausar** (não deletar) o projeto Supabase e manter ~2 semanas como
  fallback. Depois desse período, deletar.
- Conferir que o primeiro backup noturno apareceu no volume e no offsite
  (se `RCLONE_REMOTE` configurado — ver `.env.production.example`).

## Migrações de schema (drizzle) daqui em diante

`npm run db:migrate` na máquina de dev, com a `DATABASE_URL` pública
(`?sslmode=no-verify`). DDL funciona normalmente através do PgBouncer em modo
transação. Alternativa mais segura: rodar do próprio servidor apontando para
`localhost:5432` (que cai no PgBouncer) ou via túnel SSH.

## Endurecimento futuro (opcional)

- **Verificação de CA**: hoje o app usa `sslmode=no-verify` (criptografa, não
  verifica). Para verificação completa: passar `ssl: { ca }` de uma env
  `DATABASE_SSL_CA` para o Pool (`src/db/client.ts`) e para o PgBoss
  (`src/services/runtime.ts`), e distribuir o `certs/db.crt` como CA.
- Restringir `pg_hba`/admin do PgBouncer; fail2ban na 5432 (ruído de scanner).
