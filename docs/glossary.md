# Glossário

Termos do domínio e da integração com o WhatsApp que aparecem no código e nas
ADRs. Cobre o que **não** é dedutível lendo o código — sobretudo as
peculiaridades do WhatsApp/WAHA que já causaram bug em produção.

---

## Domínio

**Lead**
Um contato a ser reativado. Identificado por `phone_e164` dentro de uma
organização — a unicidade é `(organization_id, phone_e164)`, então dois tenants
podem importar o mesmo número e ter leads independentes.

**Cadência**
A sequência fixa de 5 toques em ~15 dias que um lead recebe após ser importado.
Definida em `src/core/cadence.ts`.

**Toque (touch)**
Um envio agendado da cadência: `T1`–`T5`. Cada um vira um job pg-boss atrasado
mais uma linha espelho em `scheduled_jobs`, para que possa ser cancelado por
lead antes de disparar.

**Enrollment**
A entrada do lead na cadência: transição `QUEUED → IN_CADENCE` mais a criação dos
cinco toques. A transição vem **primeiro** e serve de trava de concorrência — só
um chamador ganha a mudança, então um lead nunca recebe dois conjuntos de toques.

**Send guard**
Predicado puro (`src/core/send-guard.ts`) avaliado contra uma leitura **fresca**
do lead imediatamente antes de cada toque. Devolve `skip_and_cancel` se qualquer
condição de parada valer.

**Stop state**
Os estados de ciclo de vida que, observados na hora do envio, param a automação:
`REPLIED`, `WON`, `LOST`, `OPTED_OUT`.
`COMPLETED` está **ausente de propósito** — o worker enfileira o T5 e só então
move o lead para `COMPLETED`, então listá-lo aqui derrubaria o quinto toque
sempre.

**Handoff**
A passagem de um lead que respondeu para um consultor humano: move para
`REPLIED`, grava um evento imutável de handoff, cancela a automação restante e
alerta o consultor. Só dispara a partir de `IN_CADENCE` ou `COMPLETED`
(ADR-003 regra 2) — um lead que já está com o consultor não re-alerta a cada
mensagem.

**Resposta tardia (late reply)**
Um lead que responde depois que os cinco toques se esgotaram. Tratado pela aresta
única `COMPLETED → REPLIED`, e não por um caso especial no webhook.

**Anti-ban**
O conjunto de restrições que protege os números de bloqueio pelo WhatsApp: teto
diário por número, rampa de aquecimento (warm-up), atraso aleatório entre envios
e janela de horário. Ver `src/core/anti-ban.ts`.

**Opt-out**
Pedido de descadastro detectado no texto da resposta. Leva ao estado terminal
`OPTED_OUT` e cancela toda a automação. Curto-circuita o pipeline inbound: um
lead que fez opt-out **não** gera handoff.

---

## WhatsApp / WAHA

**WAHA**
O gateway HTTP que fala WhatsApp por nós. Roda em container próprio; o app e o
worker só o alcançam via HTTP.

**Engine**
A implementação de WhatsApp que o WAHA usa por baixo. Este projeto usa **GOWS**
(Go/whatsmeow, sem browser). O engine é gravado na sessão **no momento da
criação** — trocar a variável de ambiente vale só para sessões novas.
Engines diferentes entregam payloads de webhook com formatos diferentes; ver
ADR-005.

**Session (WAHA)** vs **Number (domínio)**
Uma *session* é a conexão autenticada do WAHA com uma conta de WhatsApp,
identificada por nome (`wa-792eaeeb`). Um *number* é a linha do domínio em
`whatsapp_numbers` que registra essa sessão para uma organização.
`session_name` é globalmente único — é o que permite ao webhook descobrir o
tenant de uma entrega, já que o WAHA só informa a sessão.

**Chat id**
Como o WhatsApp endereça uma conversa: `<digitos>@c.us` para contato individual.
Não é o mesmo que E.164 — precisa de conversão nos dois sentidos.

**LID (Linked ID)** — `<digitos>@lid`
Um identificador **opaco** que o WhatsApp passou a usar no lugar do número de
telefone, por privacidade. **Não contém os dígitos do telefone**: `164789...@lid`
não tem relação aritmética com `+554799701415`. Precisa ser resolvido via
`GET /api/{session}/lids/{digitos}`, que devolve `{"lid":…, "pn":"…@c.us"}`.
O webhook resolve isso **antes** de abrir qualquer transação, porque é uma
chamada de rede e a transação RLS segura uma conexão do pool.

**Eco outbound (outbound echo)** — `fromMe: true`
Uma entrega em que o remetente é a própria sessão. Cobre tanto nossos envios
automatizados quanto as respostas que o consultor digita num **WhatsApp Web
pareado** ao mesmo número. Ingeri-las é o que faz o lado do consultor aparecer no
histórico do CRM e contar no teto anti-ban.
**Hoje isso não acontece**: `WHATSAPP_HOOK_EVENTS=message` não entrega ecos. Ver
a pendência ao final da ADR-005.

**Ambiguidade do 9º dígito**
Celulares brasileiros ganharam um `9` inicial no assinante em 2012. O mesmo
contato pode aparecer como `+5547996334573` (moderno, 11 dígitos nacionais) ou
`+554796334573` (legado, 10). Um CSV pode trazer uma forma e o WAHA entregar a
outra. Comparação exata duplicaria o lead, então a atribuição casa contra
**todas** as formas equivalentes — `brazilianPhoneVariants` em
`src/core/phone.ts`, usada por `findByPhone`.

**`X-Webhook-Hmac`**
Assinatura HMAC SHA-512 sobre os **bytes crus** do corpo, com segredo
compartilhado. Verificada antes de qualquer parse. O segredo precisa ser idêntico
dos dois lados: `WHATSAPP_HOOK_HMAC_KEY` no container do WAHA e
`WAHA_WEBHOOK_HMAC_SECRET` no app.

**`WebhookSender`**
O componente do WAHA que entrega os webhooks. Trata **qualquer não-2xx como
retentável**: 15 tentativas a cada ~2s e então **descarta o evento
permanentemente**. Sem dead-letter, sem replay. É esse comportamento que torna um
`4xx` uma perda de mensagem, e não um sinal — a razão da ADR-005.

**`wa_message_id`**
O id de mensagem do WAHA, usado como chave de idempotência at-least-once. O
webhook consulta por ele antes de persistir, então um redelivery devolve
`"duplicate"` sem gravar nem enfileirar duas vezes.

---

## Infraestrutura

**Tenant scope**
A organização a que toda linha pertence. Fixada na **construção** do repositório,
não passada por chamada: um `DrizzleLeadRepository` é construído para exatamente
uma organização e fisicamente não alcança as linhas de outra.

**`withOrg`**
Abre a transação que carrega o contexto de tenant para o RLS
(`set_config('app.org_id', …, true)`, escopo de transação — seguro sob o pooling
por transação do PgBouncer). Usado pelas rotas web.

**RLS como rede de segurança**
As policies do Postgres duplicam o filtro que a aplicação já aplica, para que uma
query que esqueça o escopo devolva **zero** linhas em vez de todas. Ver ADR-004 e
`docs/ops/rls-policies.sql`.

**`marko_worker`**
O papel de banco do worker, com `BYPASSRLS` — ele legitimamente não consegue
segurar uma transação durante o trabalho (o choke point outbound dorme 30–120s
por pacing anti-ban e faz chamadas HTTP no meio). O escopo dele vem da camada de
aplicação.

**Choke point outbound**
A fila única por onde **todo** envio passa (`outbound-send`), onde o número
remetente é atribuído e as regras anti-ban são aplicadas. É o único caminho que
chama `WahaClient.sendText`.
