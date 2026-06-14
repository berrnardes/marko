# Guia de Arquitetura Completo — Marko

> Documentação educacional profunda do projeto **Marko**: um agente de
> reativação de leads no WhatsApp com CRM integrado, construído para uma
> operação brasileira de vendas de **consórcio**.
>
> Este guia foi escrito para te ensinar a **entender, manter e evoluir** o
> sistema sozinho. Ele explica não só "o que o código faz", mas principalmente
> **por que** foi construído desta forma, **quais princípios de engenharia**
> estão em jogo e **como um arquiteto pensa** ao projetar um sistema assim.

---

## Sumário

1. [O problema e o produto](#1-o-problema-e-o-produto)
2. [Arquitetura geral: camadas por fronteira de efeito colateral](#2-arquitetura-geral-camadas-por-fronteira-de-efeito-colateral)
3. [Os dois processos e a raiz de composição](#3-os-dois-processos-e-a-raiz-de-composição)
4. [O fluxo de execução de ponta a ponta](#4-o-fluxo-de-execução-de-ponta-a-ponta)
5. [Camada `core` — o núcleo puro](#5-camada-core--o-núcleo-puro)
6. [Camada `services` — orquestração e I/O](#6-camada-services--orquestração-e-io)
7. [Camada `db` — persistência](#7-camada-db--persistência)
8. [Camada `app` / `worker` — pontos de entrada](#8-camada-app--worker--pontos-de-entrada)
9. [O choke point de saída, anti-ban e compliance](#9-o-choke-point-de-saída-anti-ban-e-compliance)
10. [Design patterns utilizados](#10-design-patterns-utilizados)
11. [Decisões arquiteturais e seus porquês](#11-decisões-arquiteturais-e-seus-porquês)
12. [Testes: por que property-based testing](#12-testes-por-que-property-based-testing)
13. [Como evoluir o sistema com segurança](#13-como-evoluir-o-sistema-com-segurança)
14. [Guia de Evolução](#14-guia-de-evolução)
    - [14.1 Gargalos futuros](#141-gargalos-futuros)
    - [14.2 Débitos técnicos](#142-débitos-técnicos)
    - [14.3 Pontos de atenção](#143-pontos-de-atenção)
    - [14.4 Melhorias recomendadas](#144-melhorias-recomendadas)
    - [14.5 Estratégias de escalabilidade](#145-estratégias-de-escalabilidade)
15. [Aula para o desenvolvedor júnior](#15-aula-para-o-desenvolvedor-júnior)
16. [Conclusão e melhorias futuras](#16-conclusão-e-melhorias-futuras)

---

## 1. O problema e o produto

Antes de olhar para qualquer linha de código, é preciso entender **que problema
o sistema resolve**. Arquitetura boa é sempre uma resposta a um problema
concreto, não uma coleção de padrões aplicados por moda.

### O que o Marko faz

O Marko é um operário digital que cuida do ciclo de vida de **leads frios** de
consórcio:

- **Ingere leads frios** de uma fonte agnóstica (hoje CSV; amanhã Meta Ads,
  landing pages) num único ciclo de vida de `Lead`.
- **Reativa** leads com uma **cadência fixa de 5 toques em 15 dias** de
  mensagens no WhatsApp.
- **Qualifica conversacionalmente** assim que o lead responde, entregando a
  conversa a um agente de IA que extrai campos de qualificação ao longo de
  vários turnos.
- **Pontua leads continuamente** (Score 0–100) a partir de sinais de
  qualificação e comportamento, classificando-os em bandas (HOT / WARM / cold /
  DISQUALIFIED).
- **Entrega leads quentes** (handoff) a um consultor humano.
- **Nutre** leads não convertidos com uma mensagem mensal.

### As três restrições que moldam tudo

A arquitetura inteira é consequência de três restrições operacionais. Guarde-as,
porque elas explicam praticamente toda decisão técnica do projeto:

1. **Custo marginal quase zero.** O sistema roda continuamente sem custo de
   infraestrutura por mensagem. Daí a escolha de uma **fila baseada em
   PostgreSQL (pg-boss), sem Redis** — uma peça de infraestrutura a menos para
   pagar e operar.

2. **Conformidade com a LGPD.** O opt-out é um **estado terminal**. A base legal
   (opt-in/opt-out) é gravada num **log append-only**. Um lead `OPTED_OUT`
   **nunca** recebe mensagem. Isso aparece no código como múltiplas barreiras
   redundantes (o _send guard_ puro, o estado de ciclo de vida, o flag
   denormalizado), porque violar isso tem consequência jurídica.

3. **Proteção anti-ban.** O tráfego de saída usa números **não-oficiais** de
   WhatsApp (via WAHA self-hosted). Se o WhatsApp detectar comportamento de bot,
   bane o número. Por isso **todo** envio passa por um único ponto de
   estrangulamento (_choke point_) que impõe limite diário por número, rampa de
   aquecimento, ritmo aleatorizado, janela de envio e presença "humana".

### Vocabulário do domínio

| Termo                             | Significado                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| **Touch (Toque)**                 | Uma mensagem agendada da cadência (T1–T5).                                                   |
| **Cadence (Cadência)**            | A sequência de 5 toques de reativação.                                                       |
| **Nurture (Nutrição)**            | O follow-up mensal de baixa frequência.                                                      |
| **Lance reserve**                 | Dinheiro que o lead tem para dar de lance — sinal de qualificação.                           |
| **Send window (Janela de envio)** | Horário comercial local em que envios são permitidos.                                        |
| **Send guard**                    | O predicado puro que interrompe a saída em opt-out, bloqueio ou estados engajados/terminais. |

> **Lição de arquiteto nº 1:** comece sempre pelas restrições do negócio, não
> pela tecnologia. "Sem Redis", "opt-out é sagrado" e "não pode tomar ban" são
> as forças que esculpem o desenho. A pilha tecnológica é consequência, não
> ponto de partida.

---

## 2. Arquitetura geral: camadas por fronteira de efeito colateral

A ideia central — e a mais importante de todo o projeto — é que **o código é
deliberadamente dividido em camadas pela fronteira de efeito colateral (I/O)**.
Não é uma divisão por "tipo de arquivo" ou por "feature", mas por **quanto cada
pedaço de código toca o mundo externo**.

```
src/
  core/       Lógica de domínio PURA (SEM I/O) — onde vivem as provas de correção
  services/   I/O + orquestração; interfaces de repositório (a fronteira de persistência)
  db/         Schema Drizzle, migrações, cliente e implementações de repositório
  worker/     Ponto de entrada do processo worker pg-boss (long-running)
  app/        Ponto de entrada Next.js — UI do CRM, API interna, webhook WAHA
tests/        Testes transversais / smoke
.kiro/        Specs e steering
```

### As quatro camadas

1. **`src/core` — núcleo puro.** Funções determinísticas, **sem efeitos
   colaterais**, sobre valores simples: normalização de telefone, scoring,
   classificação, a tabela de transições do ciclo de vida, o send guard,
   detecção de opt-out, a matemática anti-ban, o timing de cadência/nutrição,
   templates de mensagem. **É aqui que moram as propriedades de correção
   testáveis.**

2. **`src/services` — serviços.** Conectam o núcleo puro ao mundo externo
   (cliente WAHA, managers de ciclo de vida/compliance/handoff, importador,
   workers, o agente LangGraph, handler de inbound). Dependem de **interfaces**
   de repositório, nunca de código de banco concreto.

3. **`src/db` — camada de dados.** Schema Drizzle + migrações + implementações
   concretas dos repositórios. Better Auth e pg-boss possuem seus próprios
   schemas ao lado destas tabelas.

4. **`src/app` e `src/worker` — pontos de entrada.** Compartilham os mesmos
   módulos de domínio; só o ponto de entrada difere.

### A regra de ouro: a dependência flui para dentro

```
app / worker  ──►  services  ──►  core
   (I/O máximo)     (I/O + orq.)    (zero I/O)
```

O `core` **não depende de nada** além de si mesmo. Os `services` dependem do
`core` e de **interfaces**. Os pontos de entrada (`app`/`worker`) dependem dos
`services` e do `db`. Nunca o contrário.

Você consegue verificar isso lendo os imports. Veja o cabeçalho de qualquer
arquivo do `core` — por exemplo `src/core/scoring.ts`:

```ts
import type { BehavioralSignals, ScoringSignals } from "./types";
```

Ele só importa **tipos do próprio core**. Nenhum `import` de `@/db`, de `pg`, de
`fetch`. Compare com um serviço, `src/services/lifecycle-manager.ts`:

```ts
import { transition, type TransitionResult } from "@/core/lifecycle";
import type { LifecycleState } from "@/core/types";
import type { LeadRepository } from "@/services/repositories";
```

Ele importa a **função pura** `transition` do core e a **interface**
`LeadRepository` — nunca a classe concreta `DrizzleLeadRepository`.

### Por que isso importa de verdade

Essa separação não é estética. Ela compra três coisas concretas:

- **Testabilidade.** O `core` é testável com `fast-check` (property-based
  testing) rodando milhares de iterações em milissegundos, porque não tem banco
  nem rede para esperar. As regras mais importantes do negócio (scoring,
  transições, anti-ban) são justamente as mais fáceis de testar exaustivamente.

- **Determinismo.** O núcleo nunca chama `Date.now()` nem `Math.random()`
  diretamente. O tempo entra por um parâmetro (`Clock`) e a aleatoriedade por um
  _seam_ injetável (`Rng`). Mesma entrada, mesma saída, sempre.

- **Substituibilidade.** Como os serviços dependem de interfaces, você pode
  trocar PostgreSQL por outro banco, ou o WAHA por outro provedor de WhatsApp,
  mexendo só na camada `db`/no adaptador, sem tocar na lógica de negócio.

> **Lição de arquiteto nº 2:** separe o código pela fronteira de efeito
> colateral. Empurre toda a lógica decisória para funções puras e deixe o I/O
> numa casca fina ao redor. Isso é a essência da _Functional Core, Imperative
> Shell_ — e é o padrão arquitetural-mãe deste projeto.

---

## 3. Os dois processos e a raiz de composição

O Marko roda como **dois processos do sistema operacional** que compartilham o
**mesmo banco de dados** e os **mesmos módulos de domínio**. A única diferença
real entre eles é o ponto de entrada.

```
┌─────────────────────────────┐     ┌─────────────────────────────┐
│   Processo Next.js (web)     │     │   Processo Worker (long-run) │
│   `npm run dev` / `start`    │     │   `npm run worker`           │
├─────────────────────────────┤     ├─────────────────────────────┤
│ • UI do CRM (React)          │     │ • Consome a fila pg-boss:    │
│ • API interna /api/crm/*     │     │   - cadence-touch            │
│ • Webhook /api/waha/webhook  │     │   - monthly-nurture          │
│ • ENFILEIRA jobs             │     │   - outbound-send            │
│ • Importa leads (enroll)     │     │ • PROCESSA jobs              │
└──────────────┬──────────────┘     └──────────────┬──────────────┘
               │                                    │
               └──────────────┬─────────────────────┘
                              ▼
                  ┌───────────────────────┐
                  │   PostgreSQL           │
                  │   • tabelas de domínio │
                  │   • fila pg-boss       │
                  │   • tabelas Better Auth│
                  └───────────────────────┘
```

- O **processo web** _enfileira_ trabalho (jobs de cadência ao importar leads,
  jobs de processamento ao receber webhooks) mas **nunca consome** a fila.
- O **processo worker** _consome_ a fila e executa a lógica de domínio pesada
  (envios, qualificação por LLM, recorrência mensal).

Essa separação é o que permite o webhook responder **rápido** (apenas persiste +
enfileira) sem deixar o WhatsApp esperar — o trabalho pesado vai para o worker.

### A raiz de composição: `src/services/runtime.ts`

Onde as interfaces finalmente ganham implementações concretas? Num único lugar:
o **composition root** (`getRuntime()`). Esse é o ponto onde:

- a instância pg-boss é iniciada (uma vez, como singleton por processo);
- as filas duráveis são criadas;
- os repositórios concretos Drizzle são instanciados;
- os managers, schedulers e workers são montados, injetando-se uns nos outros.

Veja o coração da montagem (resumido de `runtime.ts`):

```ts
// Repositórios concretos (camada de dados)
const leads = new DrizzleLeadRepository();
const messages = new DrizzleMessageRepository();
const numbers = new DrizzleNumberRepository();
const scheduledJobs = new DrizzleScheduledJobRepository();

// Managers/controllers apoiados no core puro
const lifecycle = createLifecycleManager({ leads });
const antiBan = createAntiBanController({
	numbers,
	config: antiBanConfig,
	clock,
});
const waha = createWahaClient({
	/* ... */
});

// Schedulers sobre as filas duráveis
const cadenceScheduler = createCadenceScheduler({
	lifecycle,
	scheduledJobs,
	queue: cadenceJobQueue(boss),
});
const nurtureScheduler = createNurtureScheduler({
	lifecycle,
	scheduledJobs,
	queue: nurtureJobQueue(boss),
	clock,
});

// Workers (a lógica dos handlers pg-boss)
const cadenceWorker = createCadenceWorker({
	leads,
	cadence: cadenceScheduler,
	outbound: outboundQueue,
	lifecycle,
	nurture: nurtureScheduler,
	scheduledJobs,
});
// ...
```

Repare que **nenhum** desses serviços faz `new DrizzleLeadRepository()` por
conta própria. Eles recebem suas dependências prontas pelo construtor. Esse é o
padrão **Injeção de Dependência manual**, e o `runtime.ts` é o único lugar que
conhece tanto as interfaces quanto suas implementações concretas.

Detalhe importante de design no comentário do próprio arquivo:

> _It is intentionally NOT re-exported from the `@/services` barrel: importing
> it opens a database pool and a pg-boss connection._

Ou seja, o `runtime.ts` é mantido **fora** do barrel `@/services` de propósito.
Quem precisa do runtime vivo importa `@/services/runtime` explicitamente. Isso
evita que um simples `import { algumTipo } from "@/services"` abra conexões de
banco sem querer. É uma decisão sutil mas muito consciente sobre efeitos
colaterais em tempo de import.

### Por que um singleton de pg-boss?

```ts
const globalForBoss = globalThis as unknown as {
	__markoBoss?: Promise<PgBoss>;
};
```

Em desenvolvimento, o Next.js faz _hot reload_ e reimporta módulos
constantemente. Sem o singleton ancorado em `globalThis`, cada reload abriria
uma nova conexão pg-boss, vazando conexões. Guardar a _Promise_ (não o valor
resolvido) no `globalThis` garante que múltiplos imports concorrentes
compartilhem **uma** inicialização.

> **Lição de arquiteto nº 3:** centralize a montagem do sistema num único
> _composition root_. O resto do código não deve saber **como** suas
> dependências são construídas — só **que** elas satisfazem uma interface. Isso
> mantém o grafo de dependências unidirecional e o teste trivial (basta passar
> um fake no construtor).

---

## 4. O fluxo de execução de ponta a ponta

Esta é a seção mais importante para "pensar sobre o sistema". Vamos seguir um
lead da entrada até a saída, citando os arquivos reais em cada passo.

### 4.1 O ciclo de vida de um Lead (a máquina de estados)

Todo o sistema gira em torno de **uma** máquina de estados, definida em
`src/core/lifecycle.ts`. Um Lead está sempre em exatamente **um** estado:

```
COLD_QUEUED → IN_CADENCE → REPLIED → QUALIFYING → {HOT, WARM, DISQUALIFIED}
                  │                                       ▲
                  └─► CADENCE_EXHAUSTED → MONTHLY_NURTURE ─┘ (ao responder, re-qualifica)

  • Qualquer estado não-terminal ──► OPTED_OUT   (opt-out, terminal — Req 14.3/14.4)
  • Qualquer estado não-terminal ──► HOT          (handoff imediato — Req 13.1)
```

A tabela de transições é construída em código, não escrita à mão por inteiro. As
transições do funil são declaradas, e duas **arestas universais** são derivadas
programaticamente:

```ts
const FUNNEL_TRANSITIONS = {
	COLD_QUEUED: ["IN_CADENCE"],
	IN_CADENCE: ["REPLIED", "CADENCE_EXHAUSTED"],
	REPLIED: ["QUALIFYING"],
	QUALIFYING: ["HOT", "WARM", "DISQUALIFIED"],
	WARM: ["HOT"],
	CADENCE_EXHAUSTED: ["MONTHLY_NURTURE"],
	MONTHLY_NURTURE: ["REPLIED"],
};
```

E na construção da tabela, toda essa lógica:

```ts
// Aresta universal de opt-out: de qualquer estado não-terminal para OPTED_OUT
for (const state of LIFECYCLE_STATES) {
	if (state !== TERMINAL_STATE) table.get(state)!.add(TERMINAL_STATE);
}
// Aresta universal de handoff: para HOT de qualquer estado não-terminal
for (const state of LIFECYCLE_STATES) {
	if (state !== TERMINAL_STATE && state !== HANDOFF_STATE)
		table.get(state)!.add(HANDOFF_STATE);
}
```

A função `transition(from, to)` é **pura**: ela só consulta a tabela e retorna
`{ ok: true }` ou `{ ok: false, state }`. Ela **não persiste nada**. Quem
persiste é o `LifecycleManager` (serviço), que só escreve quando a checagem pura
aceita. Essa divisão — _pura decide, serviço persiste_ — se repete em todo o
projeto.

### 4.2 Importação e enrollment

Caminho: upload de CSV no CRM → `POST /api/crm/import` → `LeadImporter`.

`src/services/lead-importer.ts` faz, por linha do CSV:

1. **Normaliza** o telefone via `normalizePhone(raw, "BR")` (puro, `core/phone.ts`).
2. Se falhar → linha **rejeitada** com motivo, e segue.
3. **Deduplica**: procura por número normalizado; se existe → conta como
   **atualizada** (sem duplicar).
4. Se é novo → cria o Lead em `COLD_QUEUED` gravando a `source`, e **matricula**
   (enroll) na cadência.

O ponto-chave: o importador é **agnóstico à fonte**. O pipeline `normalizar →
deduplicar → criar-ou-atualizar → matricular` independe de onde o candidato
veio. O leitor de CSV é a única parte específica de CSV. Amanhã, uma fonte Meta
Ads alimenta o **mesmo** pipeline com um único candidato.

O enrollment (`CadenceScheduler.enroll`) faz duas coisas, nesta ordem:

```ts
// 1. Transição COLD_QUEUED → IN_CADENCE primeiro (funciona como guarda de concorrência!)
const result = await this.lifecycle.apply(leadId, "IN_CADENCE");
if (!result.ok) throw new CadenceEnrollmentError(leadId, result.state);

// 2. Cria 5 jobs duráveis T1–T5 nos horários planejados
for (const touch of CADENCE_TOUCHES) {
	const fireAt = plannedFireTime(touch, enrolledAt); // puro, core/cadence.ts
	const pgbossJobId = await this.queue.enqueueTouch({ leadId, touch }, fireAt);
	await this.scheduledJobs.create({
		leadId,
		jobKind: "cadence",
		touch,
		pgbossJobId,
		plannedFor: fireAt,
	});
}
```

Note o truque elegante: **fazer a transição de estado primeiro** serve como
guarda de concorrência. Como `updateLifecycleState` é um _compare-and-set_, se
dois processos tentarem matricular o mesmo lead ao mesmo tempo, só um vence o
`COLD_QUEUED → IN_CADENCE`. O perdedor é rejeitado **antes** de criar qualquer
job — então o lead nunca recebe toques duplicados.

Os horários dos toques vêm do core puro (`CADENCE_OFFSET_DAYS`): T1=dia 0,
T2=dia 3, T3=dia 7, T4=dia 11, T5=dia 14. Estritamente crescentes — uma
propriedade testada.

### 4.3 Um toque de cadência dispara (o Send Guard em ação)

Dias depois, o pg-boss acorda um `CadenceTouchJob`. O worker
(`src/services/cadence-worker.ts`) executa, **nesta ordem**:

```ts
// 1. RELÊ o estado fresco do lead — NADA do payload do job é confiado
const lead = await this.leads.findById(leadId);
if (!lead) throw new UnknownLeadError(leadId);

// 2. Send Guard PURO sobre o snapshot fresco
if (evaluateSendGuard(lead) === "skip_and_cancel") {
	await this.markTouch(leadId, touch, "skipped");
	const cancelledJobs = await this.cadence.cancelAll(leadId); // cancela os toques restantes
	return { status: "skipped", leadId, touch, cancelledJobs };
}

// 3. Renderiza o texto (PURO) e ENFILEIRA no choke point — nunca envia inline
const content = this.messages.renderTouch(touch, view);
const jobId = await this.outbound.enqueueSend({
	leadId,
	content,
	kind: "cadence",
});

// 4. Caso especial T5: exaure a cadência e inicia a nutrição mensal
if (touch === "T5") {
	const result = await this.lifecycle.apply(leadId, "CADENCE_EXHAUSTED");
	if (result.ok) {
		await this.nurture.startMonthly(leadId); /* ... */
	}
}
```

**Por que reler o estado fresco?** Porque o job foi agendado _dias atrás_. Nesse
meio-tempo o lead pode ter respondido, dado opt-out, sido bloqueado ou
promovido. O payload do job carrega só `{ leadId, touch }` — nada
time-sensitive. A verdade é sempre relida do banco no momento de agir.

O `evaluateSendGuard` (`core/send-guard.ts`) é puro e para o envio se **qualquer**
condição valer: estado em `STOP_STATES` (REPLIED, QUALIFYING, HOT, WARM,
DISQUALIFIED, OPTED_OUT), flag `blocked`, ou `optInStatus === "opt_out"`.

### 4.4 O lead responde (o pipeline de inbound)

Caminho: WhatsApp → WAHA → `POST /api/waha/webhook` → fila inbound → worker →
`InboundHandler`.

O **webhook** (`src/services/inbound-webhook.ts`) é deliberadamente fino e
rápido. Sua ordem importa muito:

1. **Verifica o HMAC** (SHA-512 sobre o corpo cru, comparação _timing-safe_) →
   assinatura inválida = `401`, e nada é processado.
2. **Valida** o corpo (zod) → malformado = `400`.
3. **Idempotência** por `wa_message_id` → mensagem já persistida = `200`
   "duplicate", sem reprocessar (o WAHA reenvia entregas).
4. **Atribui** o remetente (normaliza E.164, encontra-ou-cria o Lead) e
   **persiste** a mensagem crua.
5. **Enfileira** na fila inbound durável e retorna `200` rápido.

O pipeline pesado roda no **worker**, em `src/services/inbound-handler.ts`,
nesta ordem precisa:

```ts
// 1. Atribui por E.164 (cria lead em remetente desconhecido)
// 2. Persiste a mensagem inbound no histórico
// 3. Marca como lida (sendSeen) — best-effort, nunca bloqueia
await this.markSeen(msg);
// 4. Opt-out tem prioridade absoluta: detecta → aplica → PARA (sem qualificação)
if (detectOptOut(msg.text)) {
	await this.compliance.applyOptOut(lead.id, msg.receivedAt);
	return;
}
// 5. Cancela cadência + nutrição pendentes (a resposta silencia a outreach)
await this.cadence.cancelAll(lead.id);
await this.nurture.cancel(lead.id);
// 6. Avança IN_CADENCE/MONTHLY_NURTURE → REPLIED → QUALIFYING
// 7. Recalcula o Score no sinal inbound
await this.scoring.recompute(lead.id);
// 8. Roda UM turno de qualificação conversacional
await this.agent.nextTurn(lead.id, msg);
```

A ordem é uma decisão de design, não acaso. O opt-out vem **antes** de tudo
porque um lead que pediu para sair não deve ser qualificado nem responder. O
`detectOptOut` é puro (`core/opt-out.ts`) e usa uma lista de frases PT-BR
normalizadas (sem acento, minúsculas) com casamento por palavra inteira — então
`"pare"` casa em "quero que pare" mas **não** em "parente".

### 4.5 A qualificação conversacional (LangGraph)

`src/services/qualification-agent.ts` modela um turno de qualificação como um
**grafo de estados compilado** (LangGraph), não uma única chamada de LLM. Os nós:

```
extract_fields → persist_fields → select_next_question → score_and_classify
   → generate_reply → detect_triggers ─┬─► handoff            (gatilho disparou)
                                       └─► guard → enqueue_reply (continua)
```

- `extract_fields`: chamada com _structured output_ (zod) extrai só os campos que
  o lead **voluntariou** neste turno.
- `persist_fields`: grava progressivamente — campo omitido **nunca** apaga valor
  já conhecido (Req 9.4).
- `select_next_question`: escolha **determinística** (sem LLM) do próximo campo
  faltante, em ordem fixa.
- `score_and_classify`: recalcula Score e banda.
- `generate_reply`: produz a resposta da persona "Marko" + flags de honestidade.
- `detect_triggers`: decide handoff por frustração, pedido fora dos dados, ou
  `score >= 70`.
- `guard`: repara/rejeita respostas que violem "no máximo uma pergunta" ou que
  afirmem fatos não suportados.

O modelo de chat é **injetável** (`BaseChatModel`), então os testes compilam o
mesmo grafo contra um LLM falso, sem chamar API nenhuma.

### 4.6 O envio (o choke point)

Tudo que sai — toque, nutrição, resposta de qualificação — é **enfileirado** como
um _outbound send job_ e processado por **um único** lugar:
`src/services/outbound-worker.ts`. Esse é o coração do anti-ban e merece sua
própria seção (ver [seção 9](#9-o-choke-point-de-saída-anti-ban-e-compliance)).

---

## 5. Camada `core` — o núcleo puro

Cada arquivo do `core` segue a mesma disciplina: **funções totais, puras,
determinísticas** sobre valores simples, com um comentário de cabeçalho que
declara explicitamente sua fronteira de efeito colateral ("pure, no I/O").
Vamos ver o papel de cada módulo.

| Arquivo         | Papel                                                            | Invariante-chave                                               |
| --------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `types.ts`      | Tipos, enums (uniões de literais), e os _seams_ `Clock`/`Rng`.   | Fonte única da verdade dos tipos de domínio.                   |
| `phone.ts`      | `normalizePhone(raw, "BR")` → E.164.                             | **Idempotente**: `f(f(x)) === f(x)`.                           |
| `scoring.ts`    | `computeBaseScore` + `applyBehavioral`.                          | Resultado sempre em 0–100.                                     |
| `classify.ts`   | `classify(score)` → banda.                                       | Particiona 0–100 sem buracos nem sobreposição.                 |
| `lifecycle.ts`  | `transition(from, to)` + tabela.                                 | Transição válida ⟺ definida na tabela; `OPTED_OUT` é terminal. |
| `send-guard.ts` | `evaluateSendGuard(lead)`.                                       | Para a saída exatamente nas condições definidas.               |
| `opt-out.ts`    | `detectOptOut(text)`.                                            | Casamento por palavra inteira, sem acento/caixa.               |
| `anti-ban.ts`   | `currentDailyCap`, `withinSendWindow`, `canSend`, `nextDelayMs`. | Cap nunca excede a base; rampa monotônica.                     |
| `cadence.ts`    | `plannedFireTime`, `nextNurtureDate`.                            | Horários estritamente crescentes; mês-calendário correto.      |
| `messages.ts`   | `renderTouch`, `renderNurture`.                                  | Templates distintos; T1 personalizado por lead.                |

### Os _seams_ `Clock` e `Rng`: como manter pureza com tempo e acaso

Um problema clássico: como uma função que decide "este número pode enviar
agora?" pode ser pura, se "agora" muda a cada milissegundo? A resposta é
**injetar** o tempo e a aleatoriedade como parâmetros.

```ts
export interface Clock {
	now(): Date;
} // seam de tempo
export type Rng = () => number; // seam de acaso (como Math.random)
```

Veja `nextDelayMs` em `anti-ban.ts`:

```ts
export function nextDelayMs(cfg: AntiBanConfig, rng: Rng): number {
	if (cfg.delayMaxMs <= cfg.delayMinMs) return cfg.delayMinMs;
	const span = cfg.delayMaxMs - cfg.delayMinMs + 1;
	return cfg.delayMinMs + Math.floor(rng() * span); // rng() injetado, não Math.random()
}
```

No teste, você passa `rng = () => 0` ou `() => 0.999...` e verifica os limites
exatos do intervalo. Em produção, o `runtime.ts` injeta o `Math.random` real e
o `Clock` real (`{ now: () => new Date() }`). A lógica é a mesma; só a fonte de
tempo/acaso muda.

### Exemplo de raciocínio puro: a tabela de capas anti-ban

A rampa de aquecimento sobe de `warmupInitialCap` até `baseDailyCap` ao longo de
`warmupRampDays`. O comentário no código explica **por que** o desenho preserva
as invariantes:

- **Dia 0 é exato:** retorna `warmupInitialCap` direto, sem interpolar nem
  arredondar.
- **Monotônico não-decrescente:** interpolação linear + `Math.round` (que é
  monotônico) preservam a ordem.
- **Nunca excede a base:** abaixo do fim da rampa o valor é estritamente menor
  que a base; no fim, é fixado exatamente em `baseDailyCap`.

Esse nível de comentário — explicando o _porquê_ matemático de cada ramo — é uma
marca registrada do projeto. Não documenta o óbvio ("incrementa x"); documenta a
**decisão** ("retornamos `delayMinMs` num intervalo invertido para nunca
devolver valor abaixo do mínimo").

### O contrato pura-decide / serviço-persiste

Note como `transition` (puro) e `LifecycleManager.apply` (I/O) se dividem:

```ts
// core/lifecycle.ts (PURO) — só decide
export function transition(from, to): TransitionResult {
	const allowed = TRANSITION_TABLE.get(from);
	return allowed?.has(to) ? { ok: true, from, to } : { ok: false, reason: "invalid_transition", state: from };
}

// services/lifecycle-manager.ts (I/O) — persiste só se aceito
async apply(leadId, to): Promise<TransitionResult> {
	const snapshot = await this.leads.findById(leadId);
	const result = transition(snapshot.lifecycleState, to);    // decisão pura
	if (!result.ok) return result;                              // rejeitado: não escreve nada
	const updated = await this.leads.updateLifecycleState(leadId, snapshot.lifecycleState, to);  // compare-and-set
	if (updated) return result;
	// compare-and-set falhou (corrida): relê e rejeita, em vez de sobrescrever
	const fresh = await this.leads.findById(leadId);
	return { ok: false, reason: "invalid_transition", state: fresh.lifecycleState };
}
```

Esse é o padrão mais importante para entender o projeto: **a regra mora no core,
o efeito mora no serviço**. Você nunca encontra uma regra de negócio escondida
dentro de uma query SQL.

---

## 6. Camada `services` — orquestração e I/O

Os serviços são onde o núcleo puro encontra o mundo real. Cada serviço:

- depende de **interfaces** (`LeadRepository`, `WahaClient`, etc.), nunca de
  classes concretas;
- recebe suas dependências pelo construtor (injeção de dependência);
- expõe uma **interface** própria + uma **factory** (`createX`) + uma **classe**
  concreta. Os consumidores dependem da interface.

### A fronteira de persistência: `repositories.ts`

`src/services/repositories.ts` contém **apenas assinaturas de método** — nenhuma
SQL, nenhuma implementação. É o contrato que a camada `db` precisa cumprir. Por
exemplo:

```ts
export interface LeadRepository {
	findById(leadId: string): Promise<LeadSnapshot | null>;
	findByPhone(phoneE164: string): Promise<LeadSnapshot | null>;
	create(input: NewLeadInput): Promise<LeadSnapshot>;
	updateQualification(
		leadId: string,
		patch: QualificationFieldsPatch,
	): Promise<LeadSnapshot>;
	updateScore(
		leadId: string,
		score: number,
		band: ClassificationBand,
	): Promise<LeadSnapshot>;
	// compare-and-set para concorrência otimista:
	updateLifecycleState(
		leadId: string,
		expectedFrom: LifecycleState,
		to: LifecycleState,
	): Promise<LeadSnapshot | null>;
	setOptInStatus(leadId: string, status: OptInStatus, at: Date): Promise<void>;
	setBlocked(leadId: string, blocked: boolean): Promise<void>;
	assignConsultant(leadId: string, consultantId: string): Promise<void>;
}
```

Isso é o **Repository Pattern** clássico: a lógica de negócio fala em termos de
"encontre o lead pelo telefone", não "rode este SELECT". Trocar o banco é trocar
a implementação, não a interface.

### Os _seams_ de fila: o padrão Adapter aplicado ao pg-boss

Os serviços nunca tocam o pg-boss diretamente. Em vez disso, dependem de
interfaces estreitas como `CadenceJobQueue`, `OutboundSendQueue`,
`InboundProcessingQueue`:

```ts
export interface CadenceJobQueue {
	enqueueTouch(job: CadenceTouchJob, fireAt: Date): Promise<string>;
	cancel(jobId: string): Promise<void>;
}
```

O `runtime.ts` constrói **adaptadores** que ligam essas interfaces ao pg-boss
real:

```ts
function cadenceJobQueue(boss: PgBoss): CadenceJobQueue {
	return {
		async enqueueTouch(job, fireAt) {
			const jobId = await boss.send(QUEUE_NAMES.cadence, job, {
				startAfter: fireAt,
			});
			return requireJobId(jobId, QUEUE_NAMES.cadence);
		},
		async cancel(jobId) {
			await boss.cancel(QUEUE_NAMES.cadence, jobId);
		},
	};
}
```

Resultado: o `CadenceScheduler` é testável com uma fila em memória, e o pg-boss
poderia ser trocado por outra fila sem tocar no scheduler.

### O catálogo dos serviços

| Serviço               | Responsabilidade                                                        | Depende de                                                                                                    |
| --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `lead-importer`       | CSV → leads → enroll.                                                   | `LeadRepository`, `CadenceScheduler`, `Clock`                                                                 |
| `cadence-scheduler`   | Matricula na cadência; agenda/cancela T1–T5.                            | `LifecycleManager`, `ScheduledJobRepository`, `CadenceJobQueue`                                               |
| `cadence-worker`      | Executa um toque: relê estado, send guard, enfileira saída, T5→exhaust. | `LeadRepository`, `CadenceScheduler`, `OutboundSendQueue`, `LifecycleManager`, `NurtureTrigger`               |
| `nurture-scheduler`   | Inicia/perpetua a corrente mensal; cancela.                             | `LifecycleManager`, `ScheduledJobRepository`, `NurtureJobQueue`, `Clock`                                      |
| `nurture-worker`      | Executa uma nutrição; agenda o próximo mês.                             | `LeadRepository`, `OutboundSendQueue`, `NurtureScheduler`                                                     |
| `outbound-worker`     | **O choke point.** Único caminho que chama `sendText`.                  | `LeadRepository`, `AntiBanController`, `WahaClient`, `OutboundSendCommitter`, `Clock`                         |
| `inbound-webhook`     | Verifica HMAC, valida, idempotência, persiste, enfileira.               | `LeadRepository`, `MessageRepository`, `InboundProcessingQueue`                                               |
| `inbound-handler`     | Pipeline ordenado de resposta inbound.                                  | quase tudo (orquestrador)                                                                                     |
| `qualification-agent` | Turno de qualificação como grafo LangGraph.                             | `BaseChatModel`, `LeadRepository`, `ScoringEngine`, `LifecycleManager`, `HandoffManager`, `OutboundSendQueue` |
| `lifecycle-manager`   | Wrapper de persistência sobre `transition`.                             | `LeadRepository`                                                                                              |
| `compliance-manager`  | Aplica opt-out; log de base legal.                                      | `LeadRepository`, `ComplianceRepository`, `ScheduledJobRepository`, `LifecycleManager`                        |
| `handoff-manager`     | Transfere lead para consultor humano.                                   | `LifecycleManager`, `HandoffRepository`, `ScheduledJobRepository`                                             |
| `waha-client`         | Transporte WhatsApp (sendText/typing/seen/resolução).                   | seam de `fetch` + `NumberSessionResolver`                                                                     |
| `anti-ban-controller` | Estado por número + decisão `canSend` + pacing.                         | `NumberRepository`, `AntiBanConfig`, `Clock`                                                                  |
| `auth`                | Composition root do Better Auth.                                        | `db/client` (concreto, legítimo)                                                                              |

### A ordem de operações como contrato de correção

Repare que vários serviços têm comentários explicando **por que** os passos
estão nessa ordem. O `ComplianceManager.applyOptOut` é o exemplo mais didático:

```ts
// 1. Grava opt_out (sinal de silenciamento primário: o choke point dropa o envio)
await this.recordLawfulBasis(leadId, "opt_out", at);
// 2. Transiciona para OPTED_OUT (segundo sinal: o send guard para neste estado)
await this.lifecycle.apply(leadId, "OPTED_OUT");
// 3. Cancela os jobs pendentes (defesa em profundidade)
await this.scheduledJobs.cancelAllForLead(leadId);
```

O comentário explica a corrida que a ordem fecha: definir os sinais de
silenciamento (1 e 2) **antes** de cancelar (3) garante que qualquer job que um
worker tenha pego _no exato momento_ do opt-out, ao reler o estado fresco, seja
parado pelo guard. Isso é **defesa em profundidade**: múltiplas barreiras
independentes para a mesma garantia ("nenhum envio após opt-out").

---

## 7. Camada `db` — persistência

`src/db/schema.ts` é a fonte única da verdade do modelo relacional. Três
decisões merecem destaque.

### 7.1 Os tipos de domínio dirigem o schema (anti-drift)

Cada enum do banco é uma tupla `as const satisfies readonly T[]`, onde `T` é o
tipo do `core`. Isso faz qualquer divergência **falhar na compilação**:

```ts
export const lifecycleStates = [
	"COLD_QUEUED",
	"IN_CADENCE",
	/* ... */ "OPTED_OUT",
] as const satisfies readonly LifecycleState[]; // se faltar/sobrar um estado, não compila
```

A mesma tupla alimenta a CHECK constraint no PostgreSQL (`enumCheck`). Ou seja:
o tipo TypeScript, a constraint SQL e a lógica do core **não podem divergir** —
se você adicionar um estado ao tipo e esquecer da tupla, o compilador reclama.

> **Lição de arquiteto nº 4:** sempre que possível, transforme erros de
> consistência em erros de compilação. "Drift que não compila" vale mais que
> qualquer teste de integração, porque é impossível de ignorar.

### 7.2 O que o schema **não** declara

O comentário de cabeçalho é explícito: Better Auth possui suas tabelas (`user`,
`session`, `account`, `verification`) e pg-boss possui suas filas (no schema
`pgboss`). A tabela `scheduled_jobs` **não é** a fila do pg-boss — é apenas um
**espelho** dos ids de job, para que se possa listar/cancelar os jobs pendentes
de um lead **por `lead_id`** (algo que o pg-boss não oferece nativamente).

Esse espelho é uma decisão arquitetural importante: ele resolve a limitação de
"cancelar todos os jobs de um lead" sem acoplar a lógica de domínio à API do
pg-boss.

### 7.3 Tabelas append-only

`compliance_records` e `handoff_events` são **append-only** (logs de auditoria).
O valor "atual" do opt-in é denormalizado em `leads.opt_in_status` para leitura
rápida, mas a história imutável vive no log. Isso é exigência de LGPD (provar a
base legal num ponto no tempo) e também um bom padrão geral: \*\*eventos imutáveis

- projeção denormalizada para leitura\*\*.

---

## 8. Camada `app` / `worker` — pontos de entrada

### 8.1 Autenticação em duas camadas

A proteção do CRM tem **dois níveis**, por desenho:

1. **Edge proxy** (`src/proxy.ts`): roda no runtime edge do Next.js, **sem
   acesso ao banco**. Faz uma checagem _otimista_ da presença do cookie de
   sessão e redireciona/nega antes da requisição chegar a qualquer página.

2. **Guard server-side** (`src/app/api/crm/_lib/guard.ts` + `getServerSession`):
   a validação **autoritativa**, incluindo expiração, onde o banco está
   disponível.

```ts
// proxy.ts (edge, rápido, otimista)
const sessionCookie = getSessionCookie(request);
if (sessionCookie) return NextResponse.next();
// sem cookie: API → 401; página → redirect para /login

// guard.ts (server, autoritativo)
const session = await getServerSession();
if (!session)
	return NextResponse.json({ error: "unauthorized" }, { status: 401 });
```

O webhook do WAHA é explicitamente **excluído** do proxy (é público por
desenho) e protegido por **HMAC** em vez de sessão. Essa é a decisão de
segurança certa: cada superfície tem o mecanismo de autenticação apropriado ao
seu chamador (humano com cookie vs. máquina com assinatura).

### 8.2 Rotas finas, lógica nos serviços

A rota `POST /api/waha/webhook` é um adaptador de ~10 linhas úteis: lê o corpo
cru, pega o header HMAC, chama `processWahaWebhook(deps, rawBody, signature)` e
mapeia o resultado para uma `Response`. **Toda** a lógica testável está no
serviço. O mesmo vale para `/api/crm/import`. Essa fina camada de adaptação é
proposital: pontos de entrada não devem conter regras.

### 8.3 O ponto de entrada do worker

`src/worker/index.ts` é minúsculo: chama `getRuntime()`, depois
`registerWorkers(runtime)`, e instala handlers de shutdown gracioso (SIGINT/
SIGTERM param o pg-boss limpo). Ele compartilha **exatamente** os mesmos módulos
de domínio que o web; só o entry difere.

---

## 9. O choke point de saída, anti-ban e compliance

Esta é a peça mais crítica para a sobrevivência operacional do sistema. **Todo**
envio passa por `OutboundWorkerService.process`, na ordem do fluxograma de
desenho:

```
1. Lead opt_out?           → DROP (nunca envia; job terminal, sem retry)   Req 15.3
2. Número bloqueado?       → STOP (não envia de número banido)             Req 18.2/18.3
3. Dentro da janela?       → se não, DEFER para reabertura                 Req 17.4
4. daily_count < cap?      → se não, DEFER para o próximo dia              Req 16.2
5. Espera delay aleatório (dentro do range configurado)                    Req 17.1
6. Simula presença "digitando"                                             Req 17.2
7. WAHA_Client.sendText — O ÚNICO envio                                    Req 17.2
8. Incrementa contador diário + grava a mensagem NA MESMA transação        Req 16.2
```

Os passos 2–4 reusam a decisão pura `canSend` (via `AntiBanController`), e o
passo 5 reusa `nextDelayMs`. **Nada** dessa matemática é reimplementado no
worker — ele é a casca imperativa em volta do núcleo puro.

### A atribuição de número e o deferral (em `runtime.ts`)

Quando um `outbound-send` é desenfileirado, `processOutboundRequest`:

1. Se fora da janela global → re-enfileira para a reabertura.
2. Lista números disponíveis (`listAvailable` — só não-bloqueados).
3. Para cada um, checa `canAssignSend`; tenta enviar pelo primeiro que o choke
   point realmente aceitar.
4. Se **todos** estão bloqueados/no cap → re-enfileira para a próxima meia-noite
   local (o cap nunca é excedido).

Isso implementa um failover de números: um número bloqueado/no cap é pulado em
favor do próximo, e o trabalho nunca é **descartado** — é adiado.

### A garantia transacional do passo 8

O passo 8 (incrementar o contador **e** gravar a mensagem na **mesma**
transação) existe para que um único envio lógico nunca conte o cap em dobro nem
grave mensagem sem contar — mesmo sob retry do pg-boss. Esse acoplamento é
delegado a um `OutboundSendCommitter` injetado, para que a fronteira de
transação viva na camada de dados.

> ⚠️ **Atenção (ver Guia de Evolução):** na montagem atual do `runtime.ts`, o
> committer usado em produção é o `createSequentialOutboundSendCommitter`, que o
> próprio comentário do código declara **NÃO atômico** e destinado a testes.
> Esse é um débito técnico real, detalhado na [seção 14](#14-guia-de-evolução).

---

## 10. Design patterns utilizados

O projeto é um catálogo vivo de padrões clássicos, aplicados com propósito (não
por enfeite):

| Padrão                                | Onde                                                           | Para quê                                            |
| ------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| **Functional Core, Imperative Shell** | `core` vs. `services`                                          | Lógica pura testável; I/O na borda.                 |
| **Dependency Injection (manual)**     | construtores `createX(deps)`                                   | Acoplamento por interface, testabilidade.           |
| **Composition Root**                  | `runtime.ts`                                                   | Único lugar que conhece as concretas.               |
| **Repository**                        | `repositories.ts` ↔ `db/*-repository.ts`                       | Abstrair persistência.                              |
| **Adapter**                           | `cadenceJobQueue(boss)`, `numberSessionResolverFromRepository` | Ligar interface estreita a lib concreta.            |
| **State Machine**                     | `core/lifecycle.ts`                                            | Transições válidas como dado, não `if`s espalhados. |
| **Strategy / Seam**                   | `Clock`, `Rng`, `FetchLike`, `BaseChatModel`                   | Trocar tempo/acaso/rede/LLM em teste.               |
| **Guard / Predicate**                 | `evaluateSendGuard`, `detectOptOut`                            | Decisão pura isolada do efeito.                     |
| **Choke Point**                       | `outbound-worker`                                              | Invariante global num único caminho.                |
| **Pipeline**                          | `inbound-handler`, grafo LangGraph                             | Passos ordenados com contrato de ordem.             |
| **Outbox/Mirror**                     | `scheduled_jobs`                                               | Cancelar jobs por `lead_id`.                        |
| **Event Log + Projection**            | `compliance_records`/`handoff_events` + flags denormalizados   | Auditoria imutável + leitura rápida.                |
| **Idempotent Receiver**               | webhook por `wa_message_id`                                    | Entrega _at-least-once_ segura.                     |
| **Optimistic Concurrency**            | `updateLifecycleState` (compare-and-set)                       | Sem locks, sem dupla matrícula.                     |

### Defesa em profundidade (não é só um padrão, é uma filosofia)

A garantia "não envie a quem deu opt-out" é imposta por **quatro** barreiras
independentes: (1) o flag `opt_out` denormalizado que o choke point checa; (2) o
estado `OPTED_OUT` que o send guard barra; (3) o cancelamento dos jobs
pendentes; (4) a re-leitura de estado fresco em cada worker. Se uma falhar, as
outras seguram. Em sistemas com consequência jurídica ou de reputação (ban),
redundância é virtude.

---

## 11. Decisões arquiteturais e seus porquês

| Decisão                                      | Por quê                                              | Trade-off aceito                                                  |
| -------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| **pg-boss (sem Redis)**                      | Custo marginal zero; uma peça de infra a menos.      | PostgreSQL-como-fila tem teto de throughput.                      |
| **Núcleo puro sem `Date.now`/`Math.random`** | Determinismo e PBT.                                  | Um pouco mais de cerimônia (passar `clock`/`rng`).                |
| **Dois processos, mesmo domínio**            | Webhook responde rápido; trabalho pesado isolado.    | Precisa rodar e operar dois processos.                            |
| **Espelho `scheduled_jobs`**                 | Cancelar por lead, que o pg-boss não faz.            | Dois lugares a manter em sincronia.                               |
| **LangGraph em vez de 1 chamada LLM**        | Passos auditáveis; guard de honestidade.             | Mais latência/custo (várias chamadas).                            |
| **Tipos dirigem schema**                     | Drift não compila.                                   | Acoplamento intencional core↔schema.                              |
| **Offsets de cadência em ms fixos**          | Imune a DST; horários estritamente crescentes.       | Não acompanha calendário (só nutrição acompanha).                 |
| **Handoff não atribui consultor**            | Não há id de consultor nessa camada; escolha no CRM. | `assignConsultant` existe mas não é chamado (feature incompleta). |

> **Lição de arquiteto nº 5:** toda decisão é um trade-off. Documentar o
> _porquê_ e o _preço_ de cada escolha é mais valioso que documentar o _como_ —
> porque quem evoluir o sistema precisa saber quais premissas pode quebrar.

---

## 12. Testes: por que property-based testing

A pilha de teste é **Vitest** + **fast-check** (PBT), com mínimo de **100
iterações** por teste de propriedade (default global em `vitest.setup.ts`).

A ideia do PBT: em vez de escrever exemplos (`expect(f(2,3)).toBe(5)`), você
declara uma **propriedade** que deve valer para _qualquer_ entrada, e o
fast-check gera centenas de casos (incluindo os adversariais) tentando
quebrá-la. As propriedades do projeto mapeiam 1:1 com as invariantes do core:

- **Scoring** sempre em 0–100 (e exatamente 0 quando `disqualifying`).
- **Classificação** particiona 0–100 sem buracos nem sobreposição.
- **Transições** válidas ⟺ definidas na tabela; `OPTED_OUT` é terminal.
- **Cadência** com horários estritamente crescentes.
- **Cap anti-ban** nunca excede a base; rampa monotônica.
- **Normalização de telefone** idempotente.

É por isso que o core é puro: PBT só é barato e rápido sobre funções
determinísticas sem I/O. Os testes co-localizados (`*.test.ts`) ficam ao lado do
código; os transversais em `tests/`.

Para verificar mudanças, use sempre:

```bash
npm run test        # roda tudo uma vez (vitest run)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
```

> Evite `test:watch`/`worker:dev`/`dev` em automação — são processos que
> bloqueiam.

---

## 13. Como evoluir o sistema com segurança

Antes do guia de evolução propriamente dito, internalize o **mapa mental** de
onde mexer para cada tipo de mudança. Ele decorre direto da arquitetura em
camadas:

### Regras de ouro para mudanças

1. **Regra de negócio nova ou alterada → comece pelo `core`.** Se é uma decisão
   determinística (uma nova condição de scoring, um novo estado, uma nova frase
   de opt-out), ela é uma função pura. Escreva-a + a propriedade fast-check
   **antes** de tocar em qualquer serviço.

2. **Novo efeito colateral (gravar algo, chamar uma API) → vá ao `services`,
   contra uma interface.** Se a interface de repositório ainda não tem o método,
   adicione-o em `repositories.ts` primeiro, implemente o fake no teste, e só
   então a versão Drizzle em `db/`.

3. **Novo estado de ciclo de vida → quatro lugares, nesta ordem:**
   `core/types.ts` (a união) → `core/lifecycle.ts` (a tabela
   `FUNNEL_TRANSITIONS`) → `db/schema.ts` (a tupla + CHECK) → gerar migração
   (`npm run db:generate`). O compilador te força a não esquecer nenhum
   (`_AllStatesCovered` quebra a build).

4. **Nunca chame `Math.random()`/`Date.now()` no `core`.** Injete via `Rng`/
   `Clock`. Se você sentir necessidade de tempo no core, o parâmetro está
   faltando.

5. **Nunca envie WhatsApp fora do `outbound-worker`.** Todo envio é um job
   enfileirado. Burlar o choke point é burlar o anti-ban — e queima um número.

6. **Toda nova rota que lê dados de lead → `denyIfUnauthenticated()` primeiro.**
   O proxy edge é otimista; a barreira autoritativa é server-side.

### Um exemplo concreto: adicionar um 6º toque (T6)

1. `core/types.ts`: adicione `"T6"` ao tipo `Touch`.
2. `core/cadence.ts`: adicione `T6` em `CADENCE_OFFSET_DAYS` (ex.: dia 20). O
   compilador exige cobertura total do mapa.
3. `core/messages.ts`: adicione `renderT6` e a entrada em `TOUCH_RENDERERS`
   (de novo, mapa total — não compila sem).
4. `cadence-scheduler.ts`: a lista `CADENCE_TOUCHES` já deriva de `["T1".."T5"]`
   — estenda para incluir `T6`.
5. `db/schema.ts`: adicione `"T6"` à tupla `touches` e gere a migração.
6. Escreva/ajuste a propriedade de "horários estritamente crescentes".

Repare como o **sistema de tipos te guia**: cada esquecimento vira erro de
compilação, não bug em produção. Essa é a maior rede de proteção do projeto.

### Um exemplo de armadilha: adicionar um campo de qualificação

Se você adicionar um campo em `QualificationFields` (ex.: `region`), precisa
tocar em: o tipo (`core/types.ts`), o schema zod do extractor
(`ExtractedFieldsSchema`), `buildQualificationPatch`, `QUALIFICATION_FIELD_ORDER`
(senão o campo nunca é perguntado), a coluna no `db/schema.ts`, e
`describeCollectedData` em `messages.ts` (senão T1 não personaliza com ele).
Nem todos esses são checados pelo compilador — `QUALIFICATION_FIELD_ORDER` e
`describeCollectedData` são listas/funções que o TS não força a cobrir. **Esse é
um ponto onde testes de propriedade valem ouro.**

---

## 14. Guia de Evolução

Esta seção é o "manual do próximo engenheiro". Tudo aqui é ancorado em
observações concretas do código atual — não em suposições genéricas. Cada item
indica **o arquivo**, **o risco** e **o caminho de correção**.

### 14.1 Gargalos futuros

Gargalos são pontos que funcionam hoje mas vão doer conforme o volume cresce.

1. **PostgreSQL-como-fila (pg-boss) tem teto de throughput.**
   - _Onde:_ `runtime.ts` (`QUEUE_NAMES`, `boss.work/send`).
   - _Por quê:_ a restrição "sem Redis" é deliberada e ótima para custo zero, mas
     pg-boss faz _polling_ e usa locks de linha. Em escala de **dezenas de
     milhares de jobs/min**, a contenção de lock e o I/O de polling no Postgres
     viram o gargalo dominante.
   - _Sintoma de que chegou a hora:_ latência de pickup de job subindo, CPU do
     Postgres alta em queries da fila, `archive`/`maintenance` do pg-boss
     atrasado.
   - _Limiar prático:_ para uma operação de consórcio (milhares de leads, 5
     toques em 15 dias), o volume é baixo e o pg-boss aguenta com folga. O
     gargalo só aparece se o produto escalar para múltiplos clientes/tenants no
     mesmo banco.

2. **Custo e latência de LLM por turno de inbound.**
   - _Onde:_ `qualification-agent.ts` — cada turno faz **duas** chamadas de
     modelo (`extract_fields` + `generate_reply`), ambas com _structured
     output_.
   - _Por quê:_ a cada mensagem do lead, 2 round-trips ao provedor de LLM. Em
     pico de conversas simultâneas, isso é o **maior** custo variável e a maior
     fonte de latência do sistema.
   - _Mitigações:_ fundir os dois nós num só prompt quando possível; usar um
     modelo menor/mais barato para `extract_fields`; cache de extrações triviais;
     limitar turnos por lead.

3. **Atribuição de número é O(números) por envio, e serializa sob concorrência.**
   - _Onde:_ `processOutboundRequest` em `runtime.ts` — itera `listAvailable()` e
     testa `canAssignSend` número a número.
   - _Por quê:_ com um pool grande de números e muitos envios, essa varredura
     repetida e o incremento de contador por número criam contenção. Ver também
     a corrida descrita em 14.3.

4. **Loops N+1 nos repositórios de jobs.**
   - _Onde:_ `cancelAll` (cadence/nurture) e `markTouch` — fazem
     `listByLead` + um `updateStatus`/`cancel` por job em laço.
   - _Por quê:_ aceitável para poucos jobs por lead (≤ 6), mas se a modelagem de
     jobs crescer (mais toques, mais tipos), vira muitas idas ao banco. Um
     `UPDATE ... WHERE lead_id = $1 AND status = 'pending'` em lote resolve.

### 14.2 Débitos técnicos

Débitos são coisas conscientemente deixadas incompletas — vários estão marcados
no próprio código. **Os dois primeiros são os mais sérios e devem ser priorizados.**

1. **🔴 O committer de saída em produção NÃO é atômico.**
   - _Onde:_ `runtime.ts` usa `createSequentialOutboundSendCommitter`, cujo
     próprio JSDoc diz: _"It does NOT provide the single-transaction atomicity
     the design requires for production (Req 16.2)... Production wiring (task
     23.1) supplies a transaction-backed committer."_
   - _Risco:_ um crash **entre** incrementar o contador diário e gravar a
     mensagem pode contar um envio sem registrar a mensagem (ou vice-versa).
     Sob retry do pg-boss, o cap diário pode ser **excedido** — exatamente o que
     o anti-ban tenta evitar.
   - _Correção:_ implementar um `OutboundSendCommitter` que faça os dois writes
     (incremento do contador + `messages.append`) dentro de **uma** transação
     Drizzle, e injetá-lo no `outboundWorker` no lugar do sequencial.

2. **🔴 A fila inbound não tem handler registrado.**
   - _Onde:_ `registerWorkers` em `runtime.ts` registra apenas `cadence`,
     `nurture` e `outbound`. O comentário admite: _"The inbound queue is
     intentionally left without a handler here: its heavy pipeline is wired
     separately."_ Mas não há outro lugar wireando.
   - _Risco:_ o webhook persiste e enfileira a mensagem (`enqueueInbound`), mas
     **nada consome** a fila `inbound-process`. Na prática, opt-out, qualificação
     e scoring por resposta podem não estar rodando fim-a-fim em produção.
   - _Correção:_ compor o `InboundHandler` no `runtime.ts` (ele depende de quase
     todos os serviços, que já estão montados lá) e registrar um
     `boss.work(QUEUE_NAMES.inbound, ...)` que chame `inboundHandler.handle(...)`.

3. **🟠 Risco de dupla-persistência da mensagem inbound.**
   - _Onde:_ `inbound-webhook.ts` tem um `TODO(task 23.1)` explícito: o handler
     do worker deve rodar o pipeline **sem** re-persistir a mensagem, porque o
     webhook **já** gravou o raw inbound. Mas o `InboundHandler.handle` também
     faz `messages.append`.
   - _Correção:_ ao wirear o handler inbound (débito nº 2), pular o `append` para
     um `wa_message_id` já persistido, mantendo a idempotência fim-a-fim.

4. **🟠 Atribuição de consultor no handoff é uma feature incompleta.**
   - _Onde:_ `handoff-manager.ts` documenta que **não** chama
     `LeadRepository.assignConsultant` (não há id de consultor nessa camada). O
     método existe na interface mas nunca é invocado.
   - _Correção:_ quando o fluxo de "consultor pega o lead no CRM" for construído,
     chamar `assignConsultant(leadId, consultantId)` a partir da UI/endpoint.

5. **🟡 O `ScoringEngine` e a derivação de sinais comportamentais.**
   - _Onde:_ `inbound-handler` e o nó `score_and_classify` chamam
     `scoring.recompute(leadId)`, mas a derivação dos `BehavioralSignals`
     (respondeu em 2 min? perguntou sobre grupos/lance? mencionou urgência?) a
     partir da mensagem precisa estar conectada à implementação concreta do
     engine. Verifique se todos os sinais de `Req 11` realmente alimentam o
     recompute.

6. **🟡 Observabilidade é só `console.log`.**
   - _Onde:_ `worker/index.ts`, `runtime.ts`.
   - _Risco:_ sem métricas/tracing estruturados, diagnosticar "por que este lead
     não recebeu o toque" depende de ler logs crus. Ver 14.4.

7. **🟡 O relatório de import pode não ser persistido.**
   - _Onde:_ `lead-importer.ts` **retorna** um `ImportReport`, mas as tabelas
     `import_reports`/`import_rows` existem no schema. Confirme se o
     `crm-importer` persiste o relatório nessas tabelas ou se elas estão órfãs.

### 14.3 Pontos de atenção

Coisas que **não estão quebradas**, mas que você precisa entender antes de mexer
para não introduzir bugs sutis.

1. **Corrida no cap diário entre jobs `outbound` concorrentes.**
   - O pg-boss pode processar vários jobs `outbound` em paralelo. Dois jobs podem
     ler o mesmo número como "abaixo do cap", ambos passar em `canAssignSend`, e
     ambos enviar — estourando o cap em 1. A atomicidade real depende de
     `incrementDailySent` ser um `UPDATE ... RETURNING` atômico **e** de o
     `evaluate`/`commit` checarem o cap dentro da mesma transação. Trate isso
     junto do débito nº 1 (committer atômico).

2. **A janela de envio usa o fuso do _host_, não do lead.**
   - _Onde:_ `withinSendWindow` usa `now.getHours()` (fuso local do processo). O
     Brasil tem múltiplos fusos; um lead no Acre pode receber mensagem fora da
     sua janela local se o servidor estiver em horário de Brasília. Para uma
     operação concentrada num fuso, é aceitável; ao expandir geograficamente,
     vire uma janela **por lead**.

3. **A garantia de honestidade do agente depende do LLM + guard.**
   - _Onde:_ `qualification-agent.ts` — o `generate_reply` é instruído a nunca
     afirmar taxas/grupos/contemplações fora dos dados, e o `guard` repara/rejeita
     `assertedFacts` não suportados. Mas a "available data" passada ao prompt é
     só o JSON dos campos de qualificação. Se você expandir o que o agente pode
     afirmar, **reforce o guard na mesma proporção** — caso contrário abre espaço
     para alucinação com consequência comercial.

4. **O cache de `chatId` é por instância (Map em memória).**
   - _Onde:_ `HttpWahaClient.chatIdCache`. Não é compartilhado entre processos.
     Inofensivo (só evita um round-trip), mas não conte com ele como fonte de
     verdade.

5. **`CADENCE_TEST_MODE` muda o comportamento de timing.**
   - _Onde:_ `core/cadence.ts`. Com a env ligada, offsets viram **segundos** e a
     cadência é truncada a 3 toques. **Nunca** ligue em produção — o
     `runtime.ts` já emite um `console.warn` se detectar. Cuidado em staging
     compartilhado.

6. **Singleton de pg-boss em `globalThis` e deploy serverless.**
   - _Onde:_ `getBoss()`. Funciona perfeitamente para processos long-running (o
     worker) e dev. Mas se o app Next for para um ambiente **serverless**
     (lambdas efêmeras), cada instância abriria sua própria conexão pg-boss — o
     que pode esgotar conexões do Postgres. O modelo pretendido é **processo
     persistente**; mantenha-o assim ou ponha um pooler (PgBouncer) na frente.

### 14.4 Melhorias recomendadas

Em ordem aproximada de retorno sobre esforço:

1. **Fechar os débitos 🔴 (committer atômico + handler inbound).** São pré-
   requisitos para o sistema funcionar corretamente em produção sob carga e
   retry. Prioridade máxima.

2. **Observabilidade estruturada.** Trocar `console.log` por um logger
   estruturado (JSON) com correlação por `leadId`/`jobId`, e expor métricas
   (jobs processados, deferrals, sends por número, erros WAHA, latência de LLM).
   Sem isso, operar o sistema às cegas fica caro.

3. **Idempotência e _dead-letter_ para envios.** Garantir que `sendText` falho
   não duplique mensagem no retry (o WAHA pode ter enviado antes de falhar a
   resposta). Considerar uma chave de idempotência por job e uma fila de
   _dead-letter_ para jobs que esgotam retries.

4. **Janela de envio por lead (fuso).** Carregar/estimar o fuso do lead (pelo
   DDD, por exemplo) e aplicar a janela localmente. Mantém o anti-ban "humano"
   correto ao expandir.

5. **Testes de integração nas costuras.** Há boa cobertura de PBT no core e
   testes de alguns workers/schedulers. Faltam testes ponta-a-ponta do
   `inbound-handler` e do `qualification-agent` (com LLM falso) — exatamente os
   pontos mais frágeis. Cobrir essas costuras paga dividendos.

6. **Painel de saúde de números.** Uma view no CRM mostrando, por número:
   `dailySent`/cap, `blocked`, dia da rampa. Operacionalmente crítico para o
   anti-ban (saber quando adicionar números ao pool).

7. **Backpressure de LLM.** Limitar a concorrência de turnos de qualificação
   (semáforo) para conter custo e respeitar rate limits do provedor.

### 14.5 Estratégias de escalabilidade

Como crescer **sem** quebrar as garantias do sistema. A boa notícia: a
arquitetura já está preparada para a maioria desses passos, porque o domínio é
puro e a comunicação é por fila.

**Escala vertical (primeiro e mais barato):**

- Subir CPU/RAM do Postgres e do processo worker resolve a faixa
  inicial-a-média. A operação de consórcio típica provavelmente nunca sai daqui.

**Escala horizontal de workers (o passo natural):**

- O worker é _stateless_ além de suas dependências e cada job relê o estado
  fresco — então rodar **N workers** consumindo a mesma fila é seguro _desde
  que_ o cap diário seja atômico (débito 🔴 nº 1) e o `incrementDailySent` seja
  atômico. Resolva isso **antes** de paralelizar, ou você estoura caps e queima
  números.
- pg-boss já distribui jobs entre múltiplos consumidores; basta subir mais
  processos worker apontando para o mesmo banco.

**Separar filas por tipo (isolamento de carga):**

- Hoje as filas já são separadas (`cadence`, `nurture`, `outbound`, `inbound`).
  Você pode dedicar **processos worker distintos** por fila — por exemplo, um
  pool só para `outbound` (sensível a pacing) e outro só para `inbound` (sensível
  a latência de LLM) — escalando cada um independentemente.

**Quando o Postgres-fila virar gargalo (escala alta):**

- A troca cirúrgica é substituir os _adapters_ de fila (`cadenceJobQueue`,
  `outboundSendQueue`, etc. em `runtime.ts`) por uma implementação sobre Redis/
  SQS/RabbitMQ. **Nenhum serviço muda** — eles dependem das interfaces
  `CadenceJobQueue`/`OutboundSendQueue`. Esse é o dividendo de ter abstraído a
  fila atrás de um seam.

**Multi-tenant (vários clientes):**

- O modelo atual assume uma operação. Para multi-tenant, a abordagem de menor
  risco é **um banco por tenant** (isolamento total, anti-ban e LGPD
  naturalmente separados) com o mesmo código. Banco compartilhado com `tenant_id`
  exigiria revisar **toda** query e constraint — bem mais arriscado.

**Pool de números (escala de volume de envio):**

- O throughput de saída é limitado por `Σ caps diários dos números`. Escalar
  envio = adicionar números ao pool (`whatsapp_numbers`) e deixá-los aquecer pela
  rampa. O `processOutboundRequest` já faz failover entre números; o limite é
  físico (o anti-ban é o ponto), não de software.

**Postgres read-replicas para o CRM:**

- As leituras do CRM (`db/crm-read.ts`) podem ir para uma réplica de leitura,
  aliviando o primário que serve a fila e os writes do domínio.

> **Lição de arquiteto nº 6:** a melhor preparação para escala não é otimização
> prematura — é manter as **costuras** (interfaces de fila, repositório, clock)
> limpas. Quando o gargalo chegar, você troca a implementação atrás da costura
> sem reescrever o domínio. Foi exatamente isso que este projeto fez ao esconder
> o pg-boss atrás de `CadenceJobQueue`/`OutboundSendQueue`.

---

## 15. Aula para o desenvolvedor júnior

Bem-vindo ao time. Esquece o código por um minuto — vou te ensinar a **pensar**
sobre o Marko. Quando você internalizar o modelo mental, o código vira óbvio.

### 15.1 Como pensar sobre o sistema

Pensa no Marko como uma **linha de montagem com uma esteira (a fila) e uma única
porta de saída (o choke point)**.

- Um lead **entra** pela esteira (importação → matrícula na cadência).
- A esteira tem **temporizadores** (os jobs pg-boss): "daqui a 3 dias, mande o
  toque T2 para o lead X".
- Quando um temporizador dispara, um operário (worker) **olha o estado atual do
  lead** (nunca confia no papelzinho do temporizador, que é antigo) e decide:
  mando ou não? Essa decisão é o **send guard**.
- Se manda, **não envia direto**: coloca o pacote na **única porta de saída**, que
  tem um segurança (anti-ban) controlando ritmo, horário e cota.
- Quando o lead **responde**, a esteira dele para na hora (cancela os toques) e
  ele entra na sala de **qualificação** (o agente de IA), que conversa, anota o
  que ele quer, e dá uma **nota** (score). Nota alta → chama o **vendedor humano**
  (handoff).

Duas frases para gravar:

> **"A regra decide, o serviço faz."** A decisão (pode mandar? qual a nota? qual
> o próximo estado?) é sempre uma função pura no `core`. O efeito (gravar,
> enviar, enfileirar) é sempre um serviço.

> **"Nunca confie no passado, releia o presente."** Todo worker relê o estado
> fresco do lead antes de agir, porque o job foi agendado dias atrás.

### 15.2 Como navegar pelo código

Quando receber uma tarefa, ache o ponto de entrada e siga o fluxo:

- **"Algo errado ao importar leads"** → `app/api/crm/import/route.ts` →
  `services/lead-importer.ts` → `core/phone.ts`.
- **"Lead não recebeu o toque"** → `services/cadence-worker.ts` (o send guard
  pode ter barrado) → `core/send-guard.ts`. Cheque o estado do lead e os flags.
- **"Mensagem do lead não fez nada"** → `app/api/waha/webhook/route.ts` →
  `services/inbound-webhook.ts` (HMAC? idempotência?) → fila inbound →
  `services/inbound-handler.ts`.
- **"O bot respondeu errado / inventou um número"** →
  `services/qualification-agent.ts`, nós `generate_reply` e `guard`.
- **"Mandou fora de hora / demais"** → `services/outbound-worker.ts` +
  `core/anti-ban.ts`.

Atalho de leitura: **todo arquivo começa com um comentário de cabeçalho** que
diz seu papel e sua fronteira de I/O. Leia esse cabeçalho primeiro — ele te
poupa de ler o arquivo inteiro.

### 15.3 Como debugar problemas

Siga a trilha de estado, sempre nesta ordem:

1. **Qual o estado do lead?** (`leads.lifecycle_state`, `opt_in_status`,
   `blocked`, `score`). 90% dos "não enviou" são o send guard fazendo o trabalho
   dele — e isso é **correto**.
2. **Quais jobs o lead tem?** (`scheduled_jobs` por `lead_id`). `pending`?
   `cancelled`? `skipped`? Isso te diz o que a esteira ia fazer.
3. **Qual o histórico de mensagens?** (`messages` por `lead_id`) — o que entrou e
   saiu, com timestamps.
4. **O número está saudável?** (`whatsapp_numbers`: `blocked`, `daily_sent` vs.
   cap, `warmup_start_date`).
5. **Reproduza a decisão no core.** Como as funções do `core` são puras, você
   pode chamar `evaluateSendGuard(snapshot)` ou `classify(score)` num teste e ver
   exatamente o que o sistema decidiria. **Não precisa subir nada** para entender
   uma decisão de negócio.

Regra de bolso: se o comportamento é uma _decisão_ (mandou/não mandou, nota,
estado), o bug está no `core` ou no estado de entrada. Se é um _efeito_ (gravou
errado, chamou API errada, ordem trocada), está no `services`.

### 15.4 Como evoluir com segurança

Releia a [seção 13](#13-como-evoluir-o-sistema-com-segurança). O resumo:

- Comece pela camada mais interna que a mudança alcança (`core` se for regra).
- Deixe o **compilador** trabalhar a seu favor: tipos dirigem schema e mapas
  totais quebram a build se você esquecer um caso.
- Escreva a **propriedade** antes do código quando mexer no core.
- Nunca fure o choke point de saída nem pule o `denyIfUnauthenticated`.
- Rode `npm run typecheck && npm run test && npm run lint` antes de abrir PR.

### 15.5 Como reproduzir essa arquitetura em projetos futuros

A receita do Marko é genérica e vale para muitos sistemas:

1. **Liste as restrições do negócio primeiro.** (custo, compliance, risco). Elas
   ditam a tecnologia.
2. **Separe Functional Core / Imperative Shell.** Toda decisão vira função pura;
   todo efeito vira serviço fino.
3. **Injete tempo, acaso e rede.** `Clock`, `Rng`, `FetchLike` — nunca chame o
   relógio global no núcleo.
4. **Esconda a infraestrutura atrás de interfaces estreitas** (repositório,
   fila). Um composition root liga interface à concreta.
5. **Modele estado como uma máquina de estados explícita** (tabela de
   transições como dado), não `if`s espalhados.
6. **Crie um choke point para cada invariante global** que precisa valer
   "sempre, não importa quem chamou".
7. **Faça inconsistências falharem na compilação** sempre que der.
8. **Teste o núcleo com propriedades, não só exemplos.**

---

## 16. Conclusão e melhorias futuras

O Marko é um exemplo maduro de **Functional Core, Imperative Shell** aplicado a
um domínio com consequências reais (jurídicas, via LGPD, e de reputação, via
ban). Suas maiores qualidades:

- **Núcleo puro, determinístico e exaustivamente testável** — as regras que mais
  importam são as mais protegidas.
- **Dependências unidirecionais** com interfaces nas costuras — fácil de testar,
  fácil de evoluir, fácil de escalar trocando implementações.
- **Defesa em profundidade** nas invariantes críticas (opt-out, anti-ban).
- **Sistema de tipos como rede de proteção** — drift não compila.

E suas frentes de evolução, em ordem de prioridade (detalhadas na
[seção 14](#14-guia-de-evolução)):

1. 🔴 **Fechar os débitos críticos:** committer de saída atômico e handler da
   fila inbound registrado. Sem isso, o sistema não opera correto sob carga/retry.
2. 🟠 **Idempotência fim-a-fim no inbound** e **atribuição de consultor** no
   handoff.
3. 🟡 **Observabilidade estruturada** e **testes de integração** nas costuras
   frágeis (inbound-handler, qualification-agent).
4. **Janela de envio por fuso do lead** e **painel de saúde dos números** ao
   escalar geograficamente e em volume.
5. **Escala horizontal de workers** (após a atomicidade do cap) e, só se o
   volume exigir, **trocar a fila** atrás do seam já existente.

Você agora tem o mapa completo: o **porquê** (restrições), o **como** (camadas e
padrões), o **onde mexer** (guia de evolução) e o **como pensar** (a aula). O
resto é praticar lendo os cabeçalhos dos arquivos e seguindo o fluxo de um lead.

> **Lição final de arquiteto:** um bom sistema não é o que tem o código mais
> esperto — é o que torna a _próxima_ mudança segura e óbvia. Tudo no Marko, da
> pureza do core aos tipos que dirigem o schema, existe para que **você** consiga
> evoluí-lo sem medo.
