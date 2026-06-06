# Marko — Guia da Plataforma

> Documentação funcional, operacional e de negócio do Marko.
> Voltada para fundadores, time de operação, time de vendas, novos colaboradores, parceiros e apresentações de produto.
> **Este guia não documenta código, banco de dados ou detalhes técnicos** — descreve o que a plataforma faz, como ela opera e por quê.

---

## 1. O que é o Marko

O **Marko** é um agente de reativação de leads via WhatsApp com um **CRM integrado**, criado para uma operação de vendas de **consórcio** (crédito de compra programada em grupo) no Brasil.

Em uma frase: o Marko pega uma lista de contatos que um dia demonstraram interesse mas esfriaram, **reaquece esses contatos sozinho pelo WhatsApp**, e no momento em que a pessoa responde, **assume a conversa como um especialista virtual** que qualifica o lead, mede o quão quente ele está e **entrega os melhores leads, prontos, para um consultor humano**.

Tudo isso roda de forma contínua, com **custo marginal próximo de zero por lead**, dentro das regras da **LGPD**, e com proteções para que os números de WhatsApp usados não sejam banidos.

### Para quem é cada parte deste guia

| Público                   | Onde focar                                                           |
| ------------------------- | -------------------------------------------------------------------- |
| Fundadores / stakeholders | Seções 1, 2, 3 e 12 (valor, jornada, números do negócio)             |
| Operação                  | Seções 4 a 9 (cadência, qualificação, scoring, compliance, anti-ban) |
| Vendas / consultores      | Seções 3, 6, 7 e 10 (qualificação, handoff, uso do CRM)              |
| Novos colaboradores       | Todo o guia, na ordem                                                |
| Parceiros / demos         | Seções 1, 2, 3 e 10                                                  |

---

## 2. O problema que o Marko resolve

Operações de consórcio acumulam, ao longo do tempo, **milhares de leads "mornos e frios"**: pessoas que pediram uma simulação, responderam um anúncio ou deixaram contato, mas não fecharam. Esse acervo costuma ser:

- **Grande demais** para a equipe ligar um a um.
- **Caro demais** para reativar com mídia paga novamente.
- **Perecível** — quanto mais tempo passa, mais frio o lead fica.

A reativação manual depende de vendedor disponível, disposição para insistir e disciplina de follow-up — coisas que não escalam.

O Marko transforma esse acervo parado em um **fluxo automático e contínuo de reengajamento**, que só consome tempo de gente quando o lead já está aquecido e vale a pena.

### Princípios de operação

- **Custo marginal quase zero.** A plataforma roda continuamente sem custo de infraestrutura por mensagem.
- **Conformidade com a LGPD.** Pedidos de descadastro são respeitados imediatamente e de forma definitiva; o consentimento (opt-in/opt-out) fica registrado.
- **Proteção anti-banimento.** Como o canal usa números de WhatsApp não oficiais, todo envio passa por um único ponto de controle que regula volume, ritmo e horário.
- **Fonte de leads agnóstica.** Hoje a entrada é por planilha (CSV); amanhã pode ser Meta Ads ou landing page, **sem mudar o resto da operação**.

---

## 3. A jornada do lead (visão de ponta a ponta)

Esta é a história completa de um lead dentro do Marko, do upload da lista até virar (ou não) um cliente atendido por um humano.

```
   [Lista CSV de leads frios]
              │
              ▼
        Importação ──────────────► Lead criado (FRIO / na fila)
              │
              ▼
     Entra na CADÊNCIA de reativação (5 toques em 15 dias)
              │
   ┌──────────┼───────────────────────────────┐
   │          │                                │
 (responde)   (não responde até o fim)      (pede descadastro)
   │          │                                │
   ▼          ▼                                ▼
QUALIFICAÇÃO  NUTRIÇÃO mensal              DESCADASTRADO
 (o Marko     (1 msg/mês,                  (nunca mais
 conversa)    porta aberta)                 recebe nada)
   │
   ▼
 SCORE de 0 a 100 + classificação
   │
   ├── 70+  ► QUENTE ► HANDOFF para consultor humano
   ├── 40–69 ► MORNO
   ├── 1–39  ► frio (dentro da qualificação)
   └── 0     ► DESQUALIFICADO
```

### Resumo da jornada em palavras

1. **Importação.** A operação sobe uma planilha de leads frios. Cada linha vira um lead com telefone padronizado.
2. **Cadência.** Cada lead entra em uma sequência fixa de **5 mensagens ao longo de 15 dias**, enviadas automaticamente.
3. **Resposta.** No instante em que o lead responde, a cadência para e o Marko inicia uma **conversa de qualificação**.
4. **Qualificação.** O agente conversa de forma natural, coleta os dados que precisa e **calcula um score de 0 a 100**.
5. **Classificação e handoff.** Leads que atingem **70 ou mais** são marcados como **QUENTES** e entregues imediatamente a um consultor humano.
6. **Nutrição.** Leads que não responderam à cadência inteira entram em um fluxo de **nutrição mensal** — uma mensagem leve por mês.
7. **Descadastro.** A qualquer momento, se o lead pedir para parar, ele é **descadastrado de forma definitiva** e nunca mais recebe mensagens.

---

## 4. A cadência de reativação (5 toques / 15 dias)

A cadência é o coração da reativação automática. Assim que um lead é importado, ele é **inscrito automaticamente** numa sequência fixa de cinco mensagens, cada uma com um propósito diferente — a ideia é **construir reengajamento**, não repetir o mesmo discurso.

### Calendário dos toques

| Toque  | Quando (a partir da entrada) | Propósito               | Espírito da mensagem                                                                                                         |
| ------ | ---------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **T1** | Dia 0 (imediato)             | Reabertura de contexto  | "Oi, aqui é o Marko. Da última vez você buscava X. Ainda faz sentido continuarmos?" — **personalizada com os dados do lead** |
| **T2** | Dia 3                        | Conteúdo de valor       | Traz um dado de mercado sobre consórcio                                                                                      |
| **T3** | Dia 7                        | Prova social            | Cita a contemplação recente de um perfil parecido                                                                            |
| **T4** | Dia 11                       | Oferta / utilidade      | Oferece uma simulação nova, condição atualizada ou guia gratuito                                                             |
| **T5** | Dia 14–15                    | Mensagem de "despedida" | Pergunta, com franqueza, se o lead quer sair da lista ou se ainda faz sentido seguir                                         |

### Comportamentos importantes

- **O T1 é personalizado lead a lead.** Quanto mais o sistema sabe sobre o lead (segmento de interesse, valor de crédito desejado, objetivo, reserva para lance, renda), mais específica e relevante fica a mensagem de reabertura. Dois leads com dados diferentes recebem textos diferentes.
- **Todas as mensagens assinam como "Marko".** A persona é um especialista em consórcios, atencioso e direto.
- **A mensagem de despedida (T5) sempre acontece** para quem chegou até lá sem responder, sem descadastrar e sem bloquear o número. Ela respeita o lead e abre espaço para encerrar com elegância.

### A trava de segurança antes de cada envio

Antes de disparar **qualquer toque**, o sistema **reconfere o estado atual do lead**. Se naquele intervalo o lead já:

- **respondeu**, ou já está em qualificação / quente / morno / desqualificado,
- **pediu descadastro**, ou
- o número de envio foi **bloqueado**,

…então o toque é **cancelado** e os toques restantes daquele lead também são cancelados. Isso garante que **o sistema nunca "fala por cima"** de alguém que já reagiu.

---

## 5. Nutrição mensal (mantendo a porta aberta)

Nem todo lead responde à cadência — e tudo bem. Quem passa pelos cinco toques **sem responder** não é descartado: entra em **nutrição mensal**.

- Recebe **uma mensagem leve por mês**, no espírito de "estou por aqui quando fizer sentido".
- O objetivo é **reter o lead para o futuro** sem incomodar com contato frequente.
- **Se o lead responder a qualquer mensagem de nutrição**, o fluxo mensal é interrompido na hora e ele entra direto em **qualificação** — exatamente como na cadência.

Assim, um lead frio nunca é perdido para sempre; ele fica "no radar" a um custo baixíssimo.

---

## 6. Qualificação conversacional (o agente "Marko")

Quando um lead responde, o Marko **assume a conversa**. Esta é a parte mais inteligente da plataforma.

### Como o Marko conversa

- Ele se comporta como **"Marko", um especialista em consórcio atencioso e direto**.
- Começa com **uma única pergunta de reengajamento** — nada de despejar um formulário de qualificação de uma vez.
- Faz **no máximo uma pergunta por mensagem**, para a conversa fluir natural.
- Vai **coletando dados aos poucos**, ao longo de várias mensagens, e **só pergunta o que ainda falta**.

### As regras de honestidade (proteção da marca)

O Marko é projetado para **nunca expor a operação a desinformação ou risco reputacional**:

- **Se o lead perguntar se está falando com uma IA, o Marko confirma que é uma IA.** Sem enganação.
- **O Marko nunca inventa** taxas de consórcio, detalhes de grupos ou resultados de contemplação que não estejam nos dados disponíveis.
- **Se o lead pedir uma informação que o Marko não tem**, ele diz que vai verificar e **aciona um consultor humano**.
- **Se o Marko perceber frustração ou irritação** na mensagem do lead, ele **transfere imediatamente para um consultor humano**.

Essas regras valem tanto pela forma como o agente é instruído quanto por uma **verificação adicional** que revisa cada resposta antes de enviá-la — uma resposta que tente afirmar fatos não comprovados ou que contenha mais de uma pergunta é corrigida ou bloqueada antes de sair.

### Dados que o Marko coleta na qualificação

| Campo                  | O que representa                                         |
| ---------------------- | -------------------------------------------------------- |
| **Segmento**           | Tipo de consórcio de interesse (imóvel, veículo etc.)    |
| **Valor de crédito**   | Quanto de crédito o lead deseja                          |
| **Objetivo**           | Conquistar um imóvel (moradia) ou usar como investimento |
| **Reserva para lance** | Se o lead tem caixa para dar um lance                    |
| **Renda**              | Faixa de renda do lead                                   |

Esses campos são preenchidos **progressivamente** — cada resposta do lead pode preencher um ou mais deles, e o que já foi capturado não se perde.

---

## 7. Pontuação (score) e classificação dos leads

Cada lead recebe um **score de 0 a 100** que indica o quão promissor ele é. O score começa a ser calculado durante a qualificação e **se atualiza a cada nova mensagem** do lead.

### Score base (a partir do que o lead informou)

| Sinal de qualificação                        | Pontos |
| -------------------------------------------- | ------ |
| Respondeu todas as perguntas de qualificação | +20    |
| Renda compatível com o valor desejado        | +25    |
| Tem reserva para dar de lance                | +20    |
| Objetivo claro (moradia ou investimento)     | +15    |
| Respondeu em até 10 minutos                  | +10    |
| Respondeu dentro do horário comercial        | +5     |
| Número de celular (não VoIP)                 | +5     |

Os pesos somam **100** no máximo. **Atenção:** se a renda for incompatível com o valor desejado **ou** o lead não demonstrar interesse real, o score é **zerado**, independentemente de qualquer outro sinal.

### Bônus comportamental (sinais de compra em tempo real)

Durante a conversa, certos comportamentos **aumentam** o score:

| Comportamento na conversa                   | Pontos |
| ------------------------------------------- | ------ |
| Respondeu em menos de 2 minutos             | +10    |
| Perguntou sobre grupos disponíveis ou lance | +10    |
| Mencionou um prazo urgente                  | +15    |

O total final é **limitado a 100**.

### Faixas de classificação

| Score        | Classificação      | O que acontece                                   |
| ------------ | ------------------ | ------------------------------------------------ |
| **70 a 100** | **QUENTE** 🔥      | Transferido **na hora** para um consultor humano |
| **40 a 69**  | **MORNO**          | Continua em acompanhamento                       |
| **1 a 39**   | **frio**           | Permanece em qualificação                        |
| **0**        | **DESQUALIFICADO** | Não avança no funil                              |

---

## 8. Handoff: entrega de leads quentes para o consultor

O objetivo final da operação é colocar **leads quentes na frente de um vendedor humano** enquanto o interesse está fresco.

- **Assim que o score cruza 70**, o lead é transferido **imediatamente** para um consultor — não importa em que ponto da conversa ele esteja.
- O handoff também é disparado quando o agente detecta **frustração** do lead ou um **pedido de informação que ele não tem**.
- No momento da transferência:
  - O evento de handoff e o **motivo** são registrados no lead.
  - **Todo o histórico da conversa e os dados de qualificação** ficam disponíveis para o consultor no CRM.
  - O agente automático **para de enviar mensagens** para aquele lead — quem assume é o humano.

Na prática, o consultor recebe um lead **já aquecido, já qualificado e com contexto completo**, em vez de começar do zero.

---

## 9. Conformidade (LGPD) e proteção anti-banimento

Duas salvaguardas operacionais sustentam a operação no longo prazo.

### 9.1 LGPD — respeito ao opt-out

- Quando uma mensagem do lead expressa um **pedido de descadastro** (por exemplo "pare", "não quero mais", "me remova da lista", "cancelar"), o sistema reconhece automaticamente e marca o lead como **descadastrado (opt-out)**.
- Um lead descadastrado é movido para o estado **DESCADASTRADO** e **toda a comunicação agendada é cancelada**.
- **Enquanto estiver descadastrado, o lead nunca recebe nenhuma mensagem** — esse é um estado terminal.
- Cada mudança de consentimento (opt-in/opt-out) fica **registrada com data e hora**, formando o registro de base legal exigido pela LGPD.

> A detecção entende variações comuns em português, com ou sem acento, maiúsculas/minúsculas, e é cuidadosa para não confundir palavras (ex.: "pare" não dispara dentro de "parente").

### 9.2 Anti-banimento — protegendo os números de WhatsApp

Como o canal usa números de WhatsApp por protocolo não oficial, **todo envio passa por um único ponto de controle** que aplica:

- **Limite diário por número.** Cada número tem um teto de mensagens por dia (padrão: **40**). Ao atingir o teto, os envios daquele número são adiados para o dia seguinte.
- **Aquecimento gradual (warm-up).** Números novos começam com um teto baixo (padrão: **10/dia**) que **sobe gradualmente** ao longo de um período de ramp-up (padrão: **14 dias**) até o teto cheio. Isso evita o padrão de "muito volume cedo demais" que dispara banimentos.
- **Ritmo humanizado.** Entre um envio e outro há um **atraso aleatório** dentro de uma faixa configurável (padrão: entre **30 e 120 segundos**), para não parecer robô.
- **Janela de envio.** Mensagens só saem dentro do **horário comercial** configurado (padrão: das **9h às 20h**, horário local). Fora disso, o envio é adiado para a próxima abertura da janela.
- **Presença humana.** Antes de enviar, o sistema simula "digitando…"; ao receber mensagens, marca como lidas.
- **Detecção de bloqueio.** Se um número é detectado como bloqueado, ele **para de enviar imediatamente** e nenhum novo envio é agendado por ele — protegendo os números restantes.

Esses parâmetros são **configuráveis por ambiente**, então a operação pode ajustá-los sem mexer no produto.

---

## 10. O CRM (interface interna)

O Marko inclui um **CRM enxuto** para a operação monitorar e controlar os leads. O acesso é **restrito a usuários autenticados** — dados pessoais de leads nunca ficam expostos a quem não está logado.

### Seções do CRM

| Seção               | Para que serve                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Leads**           | Lista todos os leads com **estado atual** e **score**. Cada linha leva ao detalhe do lead.                                                   |
| **Detalhe do lead** | Mostra os **campos de qualificação** coletados e todo o **histórico de mensagens** (entrada e saída).                                        |
| **Importação**      | Onde a operação **sobe a planilha CSV** e vê o **relatório de importação** (quantos leads criados, atualizados e quantas linhas rejeitadas). |
| **Handoffs**        | Lista os leads que foram **transferidos para consultores**.                                                                                  |

### Login e segurança de acesso

- Usuários não autenticados são **redirecionados para o login** ao tentar acessar qualquer página ou dado do CRM.
- Sessões expiradas perdem o acesso aos dados de leads.
- Cada operador vê seu **e-mail** no topo e pode **sair** a qualquer momento.

---

## 11. Importação de leads e fontes de entrada

### Como funciona a importação por CSV

1. A operação envia uma planilha CSV de leads frios pelo CRM.
2. Cada linha é lida e o **telefone é padronizado** para o formato internacional (E.164, ex.: `+5511987654321`).
3. **Linhas com telefone inválido são rejeitadas** e aparecem no relatório, com o número da linha e o motivo.
4. **Telefones que já existem** atualizam o lead existente em vez de criar duplicado.
5. Ao final, a operação recebe um **relatório**: total de leads criados, atualizados e linhas rejeitadas.
6. Cada lead novo é **automaticamente inscrito na cadência**.

### Fontes futuras (sem retrabalho)

A entrada de leads é **agnóstica à fonte**. Hoje é CSV, mas amanhã pode ser **Meta Ads, uma landing page** ou outra origem em tempo real — todos passam pelas **mesmas regras** de padronização, deduplicação, ciclo de vida e inscrição na cadência. A **origem de cada lead é registrada**, então a operação sempre sabe de onde ele veio.

---

## 12. Estados do lead (referência rápida)

Cada lead está **sempre em exatamente um estado**. A tabela abaixo serve de referência para a operação interpretar o que vê no CRM.

| Estado                                      | O que significa                                  |
| ------------------------------------------- | ------------------------------------------------ |
| **FRIO / na fila** (`COLD_QUEUED`)          | Importado, ainda não inscrito na cadência        |
| **EM CADÊNCIA** (`IN_CADENCE`)              | Recebendo a sequência de 5 toques                |
| **RESPONDEU** (`REPLIED`)                   | Respondeu; cadência interrompida                 |
| **EM QUALIFICAÇÃO** (`QUALIFYING`)          | Em conversa com o agente Marko                   |
| **QUENTE** (`HOT`)                          | Score 70+; transferido para consultor            |
| **MORNO** (`WARM`)                          | Score 40–69                                      |
| **DESQUALIFICADO** (`DISQUALIFIED`)         | Score 0                                          |
| **CADÊNCIA ESGOTADA** (`CADENCE_EXHAUSTED`) | Passou pelos 5 toques sem responder              |
| **NUTRIÇÃO MENSAL** (`MONTHLY_NURTURE`)     | Recebe uma mensagem por mês                      |
| **DESCADASTRADO** (`OPTED_OUT`)             | Pediu para sair; **nunca mais recebe mensagens** |

> Regras de integridade: o lead só transita por caminhos válidos; o descadastro pode acontecer a partir de **qualquer** estado e é **definitivo** (não há volta a partir dele).

---

## 13. Por que o Marko é diferente (resumo para apresentações)

- **Reativa um acervo parado** de leads frios sem esforço manual e sem nova mídia paga.
- **Conversa de verdade** — qualificação natural, uma pergunta por vez, persona consistente.
- **Prioriza sozinho** — score de 0 a 100 e classificação automática colocam os melhores leads no topo.
- **Entrega leads prontos** — o consultor humano só entra quando o lead está quente, com contexto completo.
- **Roda a custo quase zero** — operação contínua sem custo por mensagem.
- **Seguro e sustentável** — conformidade com LGPD por padrão e proteções anti-banimento que preservam os números no longo prazo.
- **Pronto para crescer** — novas fontes de leads entram sem redesenhar a operação.

---

### Vocabulário do domínio

- **Toque** — uma mensagem agendada da cadência (T1 a T5).
- **Cadência** — a sequência de 5 toques de reativação. **Nutrição** — o follow-up mensal.
- **Reserva de lance** — caixa que o lead tem para dar um lance; um sinal de qualificação.
- **Janela de envio** — o horário comercial em que os envios são permitidos.
- **Handoff** — a transferência de um lead quente para um consultor humano.
- **Opt-out / descadastro** — pedido do lead para parar de receber mensagens; respeitado de forma definitiva.
