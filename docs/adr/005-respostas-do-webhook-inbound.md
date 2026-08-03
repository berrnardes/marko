# ADR-005 — Respostas do webhook inbound: `200` + log, não `4xx`

- **Status:** aceito
- **Data:** 2026-08-02
- **Contexto imediato:** apuração do bug "lead responde e nada acontece"

## Contexto

Uma entrega do WAHA que o sistema não consegue processar precisa de uma resposta
HTTP. Havia duas políticas convivendo no mesmo arquivo
(`src/services/inbound-webhook.ts`), sem que a diferença fosse deliberada:

- **sessão desconhecida** → `200 "ignored"` + `logger.warn`, com o comentário
  explícito *"returning 5xx would make WAHA redeliver it forever"*;
- **payload malformado / `@lid` irresolvível / remetente inválido** → `400`,
  **sem log nenhum**.

Essa inconsistência custou uma interrupção completa do fluxo de resposta.

### O que aconteceu

O engine GOWS (WAHA 2026.7.2) envia `"to": null` em **toda** mensagem inbound —
o campo só carrega destinatário num eco `fromMe`. O schema declarava
`to: z.string().optional()`. Em Zod, `.optional()` aceita `undefined` e
**rejeita um `null` presente**, porque `null` é um valor de tipo errado, não a
ausência do campo. O mesmo vale para `.default("")`, que preenche apenas chave
ausente.

Resultado: `safeParse` falhava em toda resposta de lead, a rota devolvia
`400 invalid_body`, e o `WebhookSender` do WAHA reagia assim:

```
20:53:50.535  400 → Retrying 1/15
   ... 15 tentativas, ~2s de intervalo ...
20:54:20.761  ERROR: POST request failed  {"reason":"invalid_body"}
```

Depois da 15ª tentativa o WAHA **descarta o evento permanentemente**. Não há
dead-letter nem replay.

Como `processWahaWebhook` persiste a mensagem *antes* de enfileirar, a rejeição
acontecia antes de qualquer escrita. Nada era gravado, nada era enfileirado, e o
consumidor `inbound-process` — que estava saudável e corretamente registrado —
simplesmente nunca recebia job. Daí os três sintomas relatados, todos da mesma
causa: resposta ausente do histórico do CRM, lead preso em `IN_CADENCE`, e
cadência continuando a disparar por cima da conversa.

O bug sobreviveu porque o `400` **não logava nada**. O sistema rejeitava todas as
respostas de lead em silêncio.

## Decisão

**Uma entrega bem-formada do WAHA que não conseguimos processar é reconhecida com
`200 { ok: true, status: "ignored", reason }` e registrada em log — nunca
rejeitada com `4xx`.**

Vale para: `invalid_body`, `unresolved_lid`, `invalid_sender` e
`unknown_session` (que já seguia a regra).

Duas exceções, ambas deliberadas:

| Caso | Resposta | Motivo |
|---|---|---|
| `invalid_signature` | `401` | Rejeição de segurança real. Uma assinatura inválida jamais pode ser reconhecida como aceita, e quem a enviou não é uma entrega legítima a preservar. |
| `invalid_json` | `400` | Um corpo que nem sequer é JSON não veio do `WebhookSender` do WAHA. Não há tempestade de retry a evitar nem mensagem a perder, e `400` é a resposta honesta para o cliente mal configurado que estiver postando ali. |

O log é obrigatório em todos os caminhos de descarte — foi a ausência dele, não o
código de status, que tornou a falha invisível.

### Sobre o que se loga

Na falha de schema, apenas os **caminhos dos campos**:

```ts
issues: result.error.issues.map((issue) => issue.path.join("."))
```

Nunca os valores. O payload carrega texto de mensagem do lead e números de
telefone. O nome do campo basta para diagnosticar uma mudança de schema do WAHA e
não carrega dado pessoal.

## Consequências

**A favor**

- Uma entrega impossível de processar custa **uma** requisição em vez de dezesseis.
- O diagnóstico passa a existir: `inbound.invalid_body`, `inbound.unresolved_lid`,
  `inbound.invalid_sender` são greppáveis, com os caminhos dos campos que
  falharam.
- A idempotência por `wa_message_id` (já existente) passa a ser exercitada de
  fato: um redelivery após falha transitória devolve `200 "duplicate"` sem
  duplicar escrita nem job.

**Contra**

- Uma entrega descartada não aparece mais nas métricas de erro do próprio WAHA.
  Monitoramento de inbound precisa observar os logs da aplicação, não o WAHA.
- `200` para um corpo malformado é semanticamente frouxo em HTTP. Aceitamos:
  um `400` que ninguém lê não é "barulhento", é só perdedor de mensagem.

## Nota de implementação

A tolerância a `null` é **estreita e proposital** — só `to` e `body`, os dois
campos que o GOWS envia como `null`:

```ts
to:   z.string().nullish().transform((v) => v ?? undefined),
body: z.string().nullish().transform((v) => v ?? ""),
```

`id`, `from`, `timestamp` e `fromMe` seguem estritos. Uma entrega sem remetente
ou sem id de mensagem é inatribuível e deve falhar cedo e visivelmente, em vez de
escorregar para dentro da atribuição e quebrar mais fundo, onde é mais difícil
diagnosticar.

Os testes de regressão (`src/services/__tests__/inbound-webhook.test.ts`) usam um
payload **copiado de um WAHA real**, não escrito à mão. O bug existiu justamente
porque as fixtures antigas eram idealizadas: sempre preenchiam `to` com um chat
id, codificando uma suposição sobre o WAHA em vez de uma observação dele.

## Pendência conhecida (fora do escopo desta ADR)

`WHATSAPP_HOOK_EVENTS=message` não entrega ecos `fromMe`, então
`handleOutboundEcho` é código inalcançável hoje: as respostas do consultor pelo
WhatsApp Web não entram no histórico do CRM nem contam no teto diário anti-ban.
Trocar para `message.any` **ainda não é seguro**: o GOWS monta ids de mensagem a
partir da forma `@lid` do chat (`false_164789355544698@lid_…`), enquanto
`extractWaMessageId` lê o id da resposta do `sendText`, endereçado por `@c.us`.
Se divergirem, a dedup por `wa_message_id` erra e todo envio automatizado é
gravado e **contado em dobro** no teto diário. Verificar a igualdade dos ids em um
envio real antes de habilitar.
