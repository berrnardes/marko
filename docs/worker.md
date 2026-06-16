# O Worker — o que é, por que existe e como funciona

Este documento explica o conceito de **worker** no Marko: por que ele existe,
o que ele faz, como se relaciona com o app Next.js e o que muda em produção
(incluindo o deploy na Vercel).

---

## 1. O conceito em uma frase

O **worker** é um processo de longa duração que **executa, em segundo plano, o
trabalho que foi agendado para acontecer depois**. O app web só _enfileira_
tarefas; o worker é quem _consome e executa_ essas tarefas.

```
┌──────────────┐   enfileira    ┌────────────┐   consome    ┌──────────────┐
│  App Next.js │ ─────────────► │  Postgres  │ ───────────► │    Worker    │
│ (CRM/API/    │   (pg-boss)    │  (fila)    │  (pg-boss)   │ (executa os  │
│  webhook)    │                │            │              │  jobs)       │
└──────────────┘                └────────────┘              └──────────────┘
```

Os dois processos **compartilham o mesmo banco de dados e os mesmos módulos de
domínio** (`src/core`, `src/services`, `src/db`). A única diferença é o ponto de
entrada: o app web atende HTTP, o worker processa a fila.

---

## 2. Por que precisamos de um worker?

Muita coisa no Marko **não pode acontecer na hora**. A cadência de reativação,
por exemplo, é de **5 toques ao longo de 15 dias**. O nurture é **mensal**. Os
envios respeitam **janela de horário** e **limites diários por número**.

Um servidor web não serve para isso porque:

- Uma requisição HTTP precisa **responder rápido** e então terminar. Ela não
  pode ficar "segurando a linha" por horas ou dias esperando a hora de enviar
  o toque T2.
- O trabalho precisa rodar **mesmo quando ninguém está acessando o site**. Se a
  cadência só avançasse quando alguém abrisse o CRM, leads ficariam parados.

A solução clássica é separar as responsabilidades:

| Processo    | Papel                                                      |
| ----------- | ---------------------------------------------------------- |
| **App web** | Responde a requisições HTTP. **Enfileira** jobs e termina. |
| **Worker**  | Roda continuamente. **Consome** a fila e executa os jobs.  |

---

## 3. A fila: pg-boss sobre PostgreSQL

A "fila" entre os dois processos é o [**pg-boss**](https://github.com/timgit/pg-boss),
uma fila de jobs **respaldada pelo próprio PostgreSQL** (sem Redis, sem
infraestrutura extra). Isso foi uma decisão de design para manter o **custo
marginal próximo de zero**.

Como funciona na prática:

- **Enfileirar (app web):** `boss.send(fila, dados, { startAfter })` grava um job
  numa tabela do Postgres, opcionalmente com uma hora futura para disparar.
- **Consumir (worker):** `boss.work(fila, handler)` fica fazendo _polling_ nessa
  tabela e, quando um job vence, chama o handler para executá-lo.

> É por isso que o worker precisa ser um **processo vivo e contínuo**: ele
> mantém uma conexão com o Postgres e fica perguntando "tem job pronto pra
> rodar?" o tempo todo.

---

## 4. O que o worker do Marko faz

O ponto de entrada é `src/worker/index.ts`. Ao subir, ele monta o runtime
compartilhado (`getRuntime()`) e registra os handlers (`registerWorkers()`).
São **três filas**:

### 4.1. Cadência (`cadence-touch`)

Dispara cada toque T1–T5 da sequência de reativação. Quando um toque vence, o
worker:

1. **Relê o estado atual do lead** (o _State Guard_). Como o job foi agendado
   dias antes, o lead pode ter respondido, dado opt-out, sido bloqueado ou já
   ter ido para um consultor.
2. Se alguma dessas condições de parada for verdadeira → **pula o toque e
   cancela os toques restantes** da cadência.
3. Caso contrário → **renderiza o texto do toque** e **enfileira um envio** na
   fila `outbound-send`.
4. No **T5** (último toque), além de enviar a mensagem de "despedida", **esgota a
   cadência** (`CADENCE_EXHAUSTED`) e **inicia o nurture mensal**.

### 4.2. Nurture (`monthly-nurture`)

Dispara a mensagem mensal de acompanhamento para leads não convertidos, e se
reagenda para o mês seguinte.

### 4.3. Envio / Outbound (`outbound-send`) — o "choke point" anti-ban

**Toda** mensagem que sai para o WhatsApp passa por aqui — é o ponto único de
saída. O worker:

- escolhe um número disponível e **não bloqueado**;
- aplica as regras **anti-ban**: cap diário por número, janela de envio, rampa de
  aquecimento, pacing aleatório;
- se **nada pode enviar agora** (fora da janela, ou cap atingido), **reagenda**
  para a próxima janela/dia em vez de descartar;
- finalmente, chama o **WAHA** para enviar de fato.

---

## 5. Por que dois processos e não um só?

Porque eles têm **perfis de execução opostos**:

- O **app web** é _event-driven_ e efêmero: sobe para responder uma requisição
  e some. Perfeito para serverless.
- O **worker** é _always-on_: precisa estar sempre ligado, com estado de conexão
  e fazendo polling. Perfeito para um container/VPS de longa duração.

Mas eles **não duplicam lógica**: ambos importam exatamente os mesmos módulos de
`src/core`, `src/services` e `src/db`. O que muda é só _quem chama o quê_:

```
src/app/...        → entry point web    → ENFILEIRA jobs
src/worker/index.ts → entry point worker → CONSOME e EXECUTA jobs
        │                                         │
        └──────────── compartilham ──────────────┘
              src/core · src/services · src/db
```

---

## 6. Rodando localmente

A cadência só funciona de ponta a ponta com **os dois processos rodando ao mesmo
tempo**:

```bash
npm run dev      # app Next.js — enfileira jobs (CRM, webhook, import)
npm run worker   # worker — executa os jobs (cadência, nurture, envio)
```

Sem o worker, os leads são importados e os jobs são agendados, mas **nada é
enviado** — os jobs ficam parados na fila no estado `created`.

> **Dica de debug:** se um toque parece "preso", compare o `planned_for` com o
> relógio do banco, não com o seu relógio local. Os timestamps são gravados em
> **UTC** (sufixo `+00`), enquanto seu relógio está em horário de Brasília
> (UTC−3). Um `until_fire` negativo significa que o job já passou da hora de
> disparar:
>
> ```sql
> SELECT touch, status, planned_for, now() AS db_now,
>        planned_for - now() AS until_fire
> FROM scheduled_jobs ORDER BY planned_for DESC LIMIT 6;
> ```

---

## 7. O que muda em produção (e na Vercel)

Este é o ponto mais importante para o deploy.

### O worker **não roda na Vercel**

A Vercel é **serverless**: ela executa funções de curta duração que sobem,
respondem e morrem. Ela **não mantém processos de longa duração** vivos. O
worker é exatamente um processo contínuo, com conexão persistente ao Postgres e
polling do pg-boss — então ele **não tem como rodar na Vercel**. Não é
configuração; é incompatibilidade de modelo de execução.

Sem o worker, em produção acontece o mesmo do local: o app enfileira, mas nada é
processado.

### Arranjo recomendado

```
┌───────────────────────┐         ┌──────────────────────────┐
│  App Next.js           │         │  Worker (always-on)      │
│  na Vercel             │         │  Railway / Render / Fly  │
│  (CRM, API, webhook)   │         │  / VPS                   │
└───────────┬───────────┘         └───────────┬──────────────┘
            │                                  │
            └────────── mesmo DATABASE_URL ────┘
                                │
                   ┌────────────▼────────────┐
                   │  PostgreSQL gerenciado   │
                   │  (Neon / Supabase / RDS) │
                   └──────────────────────────┘
```

- **App na Vercel**, **worker num serviço que aceita processo contínuo**
  (Railway, Render, Fly.io ou uma VPS), ambos apontando para o **mesmo
  `DATABASE_URL`**. Isso casa com a arquitetura atual e **não exige reescrever
  código** — é só infraestrutura.
- Alternativa: rodar **app + worker juntos** num provedor always-on (sem
  Vercel), simplificando para um lugar só.

### Outros pontos de produção (independentes do worker)

- **WAHA precisa de URL pública.** `WAHA_BASE_URL=http://localhost:3000` não
  funciona em produção. O WAHA é self-hosted e também precisa morar num servidor
  de verdade (não roda na Vercel); o webhook precisa apontar para o domínio
  público do app.
- **Postgres gerenciado com pooling.** Nada de `localhost`. Em serverless, cada
  invocação abre conexão — use um pooler (PgBouncer / connection string "pooled"
  do Neon) para não estourar o limite. O worker, por ser um processo só, usa
  conexão direta tranquilamente.
- **Variáveis de ambiente** precisam ser configuradas **tanto na Vercel quanto
  no serviço do worker** (`DATABASE_URL`, `WAHA_*`, `BETTER_AUTH_SECRET`,
  `BETTER_AUTH_URL`, etc.). `BETTER_AUTH_URL` / `NEXT_PUBLIC_BETTER_AUTH_URL`
  devem ser o domínio de produção.
- **`CADENCE_TEST_MODE` desligado em produção.** Caso contrário a cadência roda
  em segundos com apenas 3 toques, em vez dos 5 toques / 15 dias reais. Ele
  também ativa o **`ANTIBAN_TEST_MODE`** (que desliga janela de envio, cap diário
  e pacing do anti-ban) — ambos devem ficar desligados em produção.

---

## 8. Resumo

- O **worker** executa o trabalho agendado em segundo plano: cadência, nurture e
  envios anti-ban.
- Ele existe porque esse trabalho é **demorado, agendado e contínuo** — coisa que
  um servidor web (que responde e morre) não consegue fazer.
- A fila entre app e worker é o **pg-boss sobre PostgreSQL**, sem Redis.
- Localmente, rode **`npm run dev` e `npm run worker` juntos**.
- Em produção, o **app vai bem na Vercel, mas o worker (e o WAHA) precisam de um
  ambiente always-on** apontando para o mesmo Postgres gerenciado.
