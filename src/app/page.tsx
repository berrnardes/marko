// Landing page da Marko — consultoria de aquisição de patrimônio via
// consórcio. Objetivo da página: levar o visitante qualificado à simulação
// gratuita no WhatsApp (formulário qualificador na seção final) e filtrar o
// anti-ICP. Copy-fonte: marko-landing-copy.md.

import { CountUp } from "./_landing/count-up";
import { Faq, type FaqItem } from "./_landing/faq";
import { LandingHeader } from "./_landing/header";
import { LeadForm } from "./_landing/lead-form";
import { Reveal } from "./_landing/reveal";

/* ---------------------------------- dados --------------------------------- */

const ENEMIES = [
	{
		number: "01",
		title: "O aluguel que nunca vira nada",
		body: "Anos pagando em dia, e no final o imóvel continua sendo de outra pessoa. É o único “investimento” que você faz todo mês com retorno garantido de zero.",
	},
	{
		number: "02",
		title: "O financiamento que assusta",
		body: "Entrada de dezenas de milhares que você não tem. Juros que fazem o imóvel custar duas, três vezes o preço. A parcela que começa sufocando e segue por 30 anos.",
	},
];

const STEPS = [
	{
		step: "Passo 1",
		title: "Você escolhe o crédito",
		body: "Define o valor do imóvel que quer e paga uma parcela mensal que cabe no bolso — sem entrada e sem juros, apenas uma taxa de administração transparente.",
	},
	{
		step: "Passo 2",
		title: "Você é contemplado",
		body: "Por sorteio ou por lance — usando FGTS, reserva ou 13º para antecipar sua vez. É aqui que a estratégia certa muda tudo, e é aqui que a Marko trabalha.",
	},
	{
		step: "Passo 3",
		title: "O imóvel é seu",
		body: "Recebe a carta de crédito e compra à vista, com poder de negociação de quem paga na hora. Continua pagando as parcelas do plano, sem juros até o fim.",
	},
];

type Verdict = "good" | "bad" | "neutral";

const COMPARISON: {
	criterion: string;
	consorcio: { verdict: Verdict; text: string };
	financiamento: { verdict: Verdict; text: string };
}[] = [
	{
		criterion: "Juros",
		consorcio: { verdict: "good", text: "Não tem" },
		financiamento: {
			verdict: "bad",
			text: "9–12% a.a. — o imóvel pode custar 2× o preço",
		},
	},
	{
		criterion: "Entrada",
		consorcio: { verdict: "good", text: "Não exige" },
		financiamento: { verdict: "bad", text: "Normalmente 20% do imóvel" },
	},
	{
		criterion: "Custo total",
		consorcio: { verdict: "good", text: "Menor (taxa de administração)" },
		financiamento: {
			verdict: "bad",
			text: "Maior (juros compostos por décadas)",
		},
	},
	{
		criterion: "Quando você recebe o imóvel",
		consorcio: {
			verdict: "bad",
			text: "Na contemplação — pode levar tempo",
		},
		financiamento: { verdict: "good", text: "Imediatamente" },
	},
	{
		criterion: "Previsibilidade",
		consorcio: {
			verdict: "neutral",
			text: "Sorteio ou lance (estratégia acelera)",
		},
		financiamento: { verdict: "neutral", text: "Data certa" },
	},
	{
		criterion: "Poder de compra",
		consorcio: {
			verdict: "good",
			text: "Carta de crédito = compra à vista",
		},
		financiamento: { verdict: "neutral", text: "Compra parcelada" },
	},
];

const FITS = [
	"Quer o imóvel em 2 a 4 anos — e pode planejar, não precisa correr",
	"Prefere fugir dos juros a pagar pela pressa",
	"Tem renda estável e consegue assumir uma parcela mensal hoje",
	"Tem (ou vai construir) uma reserva, FGTS ou 13º para dar lance e antecipar a contemplação",
	"Gosta de entender onde coloca o seu dinheiro",
];

const MISFITS = [
	"Você precisa morar no imóvel nos próximos 12 meses",
	"A parcela apertaria o orçamento junto com o seu aluguel atual",
	"Você busca crédito rápido para uma emergência",
	"Você não tolera nenhuma incerteza sobre a data da contemplação",
];

const METHOD = [
	{
		stage: "Etapa 1 · Diagnóstico",
		title: "Simulação com os seus números",
		body: "Aluguel atual, objetivo, prazo e reserva. Comparamos consórcio × financiamento para o seu caso — e falamos a verdade sobre qual vence.",
	},
	{
		stage: "Etapa 2 · Estratégia",
		title: "Grupo certo, lance certo",
		body: "Escolhemos grupo, prazo e valor de crédito, e montamos a sua estratégia de lance (FGTS, reserva, 13º) para antecipar a contemplação em vez de contar só com a sorte.",
	},
	{
		stage: "Etapa 3 · Acompanhamento",
		title: "Do primeiro boleto à chave",
		body: "Consultoria contínua até a contemplação e a compra: assembleias, lances, carta de crédito e negociação à vista. Você nunca fica sozinho no processo.",
	},
];

const FAQ_ITEMS: FaqItem[] = [
	{
		question: "Consórcio é seguro? E se a administradora quebrar?",
		answer:
			"Consórcios são regulamentados e fiscalizados pelo Banco Central, como os bancos. Trabalhamos apenas com administradora autorizada, e o dinheiro do grupo fica em um fundo separado do caixa da empresa. Na simulação, te mostramos exatamente qual administradora é e o histórico dela.",
	},
	{
		question: "E se eu nunca for sorteado?",
		answer:
			"Todos os participantes são contemplados até o fim do grupo — a pergunta certa é quando. É exatamente por isso que existe a estratégia de lance: com FGTS, reserva ou 13º você compete para antecipar a sua vez em vez de só esperar. Montar essa estratégia é o centro do nosso trabalho.",
	},
	{
		question: "Qual é a pegadinha? Por que “sem juros”?",
		answer:
			"Não tem juros porque não tem banco emprestando dinheiro — o grupo se autofinancia. O custo real é a taxa de administração, que existe, é transparente e está na simulação em reais, não escondida. Somada, ela costuma ficar muito abaixo do que os juros de um financiamento custariam no mesmo período.",
	},
	{
		question: "Posso usar FGTS?",
		answer:
			"Sim — em consórcio de imóvel residencial, o FGTS pode ser usado para dar lance, complementar a carta de crédito ou amortizar parcelas, dentro das regras do fundo. Para muita gente, é o que transforma a espera do sorteio em contemplação planejada.",
	},
	{
		question: "Quanto custa a consultoria da Marko?",
		answer:
			"Nada para você. Somos remunerados pela administradora quando você adere a um plano — e como a nossa remuneração é diluída ao longo das suas parcelas, só ganhamos de verdade se você fica satisfeito e segue no plano. O nosso incentivo é o seu sucesso, não a sua assinatura.",
	},
	{
		question: "Continuo pagando aluguel enquanto espero a contemplação?",
		answer:
			"Sim, e não vamos fingir o contrário — por um período, aluguel e parcela convivem. É por isso que a simulação testa se o seu orçamento aguenta os dois com folga. Se não aguentar, a resposta honesta é que ainda não é a hora, e te dizemos isso.",
	},
];

/* ------------------------------- utilitários ------------------------------ */

function Eyebrow({
	children,
	tone = "dark",
}: {
	children: React.ReactNode;
	tone?: "dark" | "light";
}) {
	return (
		<p
			className={`mb-4 text-xs font-semibold uppercase tracking-[0.2em] ${
				tone === "light" ? "text-surface/70" : "text-accent"
			}`}
		>
			{children}
		</p>
	);
}

function VerdictMark({ verdict }: { verdict: Verdict }) {
	if (verdict === "good") {
		return (
			<span aria-label="vantagem" className="font-bold text-primary">
				✓
			</span>
		);
	}
	if (verdict === "bad") {
		return (
			<span aria-label="desvantagem" className="font-bold text-accent">
				✗
			</span>
		);
	}
	return (
		<span aria-hidden className="text-ink/30">
			•
		</span>
	);
}

/* --------------------------------- seções --------------------------------- */

function Hero() {
	return (
		<section className="relative overflow-hidden bg-primary text-surface">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(240,238,233,0.08),transparent_55%)]"
			/>
			{/* Céu estrelado: pontos em deriva diagonal, bem sutis atrás do conteúdo. */}
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0 overflow-hidden opacity-10"
			>
				<div
					className="absolute animate-diagonal-drift motion-reduce:animate-none"
					style={{
						width: "200%",
						height: "200%",
						top: "-50%",
						left: "-50%",
						backgroundImage:
							"radial-gradient(circle at 1px 1px, white 1.2px, transparent 0)",
						backgroundSize: "40px 40px",
					}}
				/>
			</div>
			<div className="relative mx-auto grid max-w-6xl gap-14 px-5 pb-20 pt-32 sm:px-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:pb-28 lg:pt-40">
				<div>
					<Reveal>
						<Eyebrow tone="light">
							Consultoria de aquisição de patrimônio
						</Eyebrow>
						<h1 className="text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
							Todo mês você paga por um imóvel.{" "}
							<em className="font-display font-medium italic text-accent">
								Só que ele não é seu.
							</em>
						</h1>
					</Reveal>
					<Reveal delay={120}>
						<p className="mt-6 max-w-xl text-lg leading-relaxed text-surface/80">
							A Marko monta seu plano para trocar o aluguel por patrimônio
							usando consórcio — sem juros de banco, sem entrada impossível. E
							se o consórcio não for o certo para você, a gente te fala. De
							graça, na simulação.
						</p>
					</Reveal>
					<Reveal delay={220}>
						<div className="mt-9">
							<a
								href="#simulacao"
								className="inline-block rounded-full bg-accent px-8 py-4 text-base font-semibold text-white shadow-lg shadow-black/20 transition-transform duration-200 hover:-translate-y-0.5 motion-reduce:transform-none"
							>
								Fazer minha simulação gratuita
							</a>
							<p className="mt-3 text-sm text-surface/60">
								2 minutos · pelo WhatsApp · sem compromisso
							</p>
						</div>
						<p className="mt-8 flex items-center gap-2 text-sm text-surface/70">
							<svg
								aria-hidden
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								className="size-4 shrink-0"
							>
								<path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
								<path d="M9 12l2 2 4-4" />
							</svg>
							Operamos com administradora autorizada pelo Banco Central
						</p>
					</Reveal>
				</div>

				{/* Elemento-assinatura: "A conta que ninguém te mostra" */}
				<Reveal delay={300}>
					<div className="rounded-3xl bg-surface-card p-7 text-ink shadow-2xl shadow-black/25 sm:p-9">
						<p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">
							A conta que ninguém te mostra
						</p>
						<dl className="mt-6 space-y-5">
							<div className="flex items-baseline justify-between gap-4 border-b border-ink/10 pb-5">
								<dt className="text-sm text-ink/70">
									Aluguel R$ 2.000 × 120 meses
								</dt>
								<dd className="text-xl font-bold text-accent sm:text-2xl">
									<CountUp target={240_000} prefix="− R$ " />
								</dd>
							</div>
							<div className="flex items-baseline justify-between gap-4 border-b border-ink/10 pb-5">
								<dt className="text-sm text-ink/70">Patrimônio construído</dt>
								<dd className="text-xl font-bold tabular-nums text-ink/50 sm:text-2xl">
									R$ 0
								</dd>
							</div>
							<div className="flex items-baseline justify-between gap-4 rounded-xl bg-primary px-4 py-4 text-surface">
								<dt className="text-sm font-medium">
									Mesmo valor em consórcio
								</dt>
								<dd className="text-right font-display text-lg font-semibold italic sm:text-xl">
									imóvel no seu nome
								</dd>
							</div>
						</dl>
						<p className="mt-5 text-xs leading-relaxed text-ink/50">
							Valores ilustrativos. Na sua simulação, fazemos essa conta com os
							seus números reais — aluguel, prazo e objetivo.
						</p>
					</div>
				</Reveal>
			</div>
		</section>
	);
}

function Enemies() {
	return (
		<section id="problema" className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
			<Reveal>
				<Eyebrow>O problema</Eyebrow>
				<h2 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
					Você está preso entre{" "}
					<em className="font-display font-medium italic text-primary">
						dois inimigos
					</em>
				</h2>
			</Reveal>
			<div className="mt-12 grid gap-6 md:grid-cols-2">
				{ENEMIES.map((enemy, index) => (
					<Reveal key={enemy.number} delay={index * 120}>
						<article className="h-full rounded-2xl border border-ink/10 bg-surface-card p-8">
							<p className="font-display text-5xl font-semibold italic text-accent/30">
								{enemy.number}
							</p>
							<h3 className="mt-4 text-xl font-bold">{enemy.title}</h3>
							<p className="mt-3 leading-relaxed text-ink/70">{enemy.body}</p>
						</article>
					</Reveal>
				))}
			</div>
		</section>
	);
}

function HowItWorks() {
	return (
		<section id="como-funciona" className="bg-surface-card">
			<div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
				<Reveal>
					<Eyebrow>A alternativa</Eyebrow>
					<h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
						Consórcio, explicado{" "}
						<em className="font-display font-medium italic text-primary">
							sem enrolação
						</em>
					</h2>
					<p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink/70">
						Um grupo de pessoas se junta para comprar sem banco. Todo mês, o
						dinheiro do grupo compra imóveis para alguns participantes — até
						chegar a vez de todos.
					</p>
				</Reveal>
				<ol className="mt-14 grid gap-6 md:grid-cols-3">
					{STEPS.map((step, index) => (
						<Reveal key={step.step} delay={index * 140}>
							<li className="relative h-full rounded-2xl bg-surface p-8">
								<p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">
									{step.step}
								</p>
								<h3 className="mt-3 text-xl font-bold">{step.title}</h3>
								<p className="mt-3 leading-relaxed text-ink/70">{step.body}</p>
							</li>
						</Reveal>
					))}
				</ol>
			</div>
		</section>
	);
}

function Comparison() {
	return (
		<section id="comparativo" className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
			<Reveal>
				<Eyebrow>A conta aberta</Eyebrow>
				<h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
					Consórcio × Financiamento, lado a lado
				</h2>
				<p className="mt-4 max-w-2xl text-lg text-ink/70">
					Sem esconder as diferenças — inclusive as que não nos favorecem.
				</p>
			</Reveal>
			<Reveal delay={140}>
				<div className="mt-12 overflow-x-auto rounded-2xl border border-ink/10 bg-surface-card">
					<table className="w-full min-w-[640px] text-left text-sm sm:text-base">
						<thead>
							<tr className="border-b border-ink/10 text-xs uppercase tracking-wider text-ink/50">
								<th scope="col" className="px-6 py-4 font-semibold">
									Critério
								</th>
								<th scope="col" className="px-6 py-4 font-semibold text-primary">
									Consórcio
								</th>
								<th scope="col" className="px-6 py-4 font-semibold">
									Financiamento
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-ink/10">
							{COMPARISON.map((row) => (
								<tr key={row.criterion}>
									<th
										scope="row"
										className="px-6 py-5 align-top font-semibold text-ink"
									>
										{row.criterion}
									</th>
									<td className="px-6 py-5 align-top text-ink/75">
										<span className="flex items-start gap-2">
											<VerdictMark verdict={row.consorcio.verdict} />
											{row.consorcio.text}
										</span>
									</td>
									<td className="px-6 py-5 align-top text-ink/75">
										<span className="flex items-start gap-2">
											<VerdictMark verdict={row.financiamento.verdict} />
											{row.financiamento.text}
										</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</Reveal>
			<Reveal delay={220}>
				<blockquote className="mt-8 rounded-2xl border-l-4 border-accent bg-surface-card p-7 sm:p-8">
					<p className="text-lg leading-relaxed text-ink/85">
						<strong className="font-display italic text-primary">
							Sendo honestos:
						</strong>{" "}
						se você precisa do imóvel nos próximos meses, o financiamento
						provavelmente é a escolha certa — e a nossa simulação vai te dizer
						isso. O consórcio vence quando você tem prazo e disciplina: paga
						menos, sem juros, e compra à vista.
					</p>
				</blockquote>
			</Reveal>
		</section>
	);
}

function Qualification() {
	return (
		<section id="para-quem" className="bg-primary text-surface">
			<div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
				<Reveal>
					<Eyebrow tone="light">Transparência primeiro</Eyebrow>
					<h2 className="max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl">
						O consórcio{" "}
						<em className="font-display font-medium italic text-accent">
							não é para todo mundo.
						</em>{" "}
						E a gente prefere te dizer agora.
					</h2>
				</Reveal>
				<div className="mt-12 grid gap-6 md:grid-cols-2">
					<Reveal delay={120}>
						<div className="h-full rounded-2xl bg-surface/10 p-8 ring-1 ring-surface/15">
							<h3 className="text-lg font-bold">Faz sentido para você se…</h3>
							<ul className="mt-5 space-y-4">
								{FITS.map((item) => (
									<li key={item} className="flex gap-3 text-surface/85">
										<span aria-hidden className="mt-0.5 font-bold text-accent">
											✓
										</span>
										{item}
									</li>
								))}
							</ul>
						</div>
					</Reveal>
					<Reveal delay={240}>
						<div className="h-full rounded-2xl bg-surface/5 p-8 ring-1 ring-surface/10">
							<h3 className="text-lg font-bold text-surface/80">
								Não faz sentido se…
							</h3>
							<ul className="mt-5 space-y-4">
								{MISFITS.map((item) => (
									<li key={item} className="flex gap-3 text-surface/65">
										<span aria-hidden className="mt-0.5 font-bold">
											✗
										</span>
										{item}
									</li>
								))}
							</ul>
						</div>
					</Reveal>
				</div>
				<Reveal delay={320}>
					<p className="mt-10 max-w-3xl text-lg leading-relaxed text-surface/80">
						Se o seu caso está na coluna da direita, a simulação vai te mostrar
						isso — e te indicar o caminho melhor.{" "}
						<strong className="text-surface">
							A gente só fecha com quem o consórcio realmente serve.
						</strong>{" "}
						É assim que os nossos clientes ficam até o fim.
					</p>
				</Reveal>
			</div>
		</section>
	);
}

function Method() {
	return (
		<section id="metodo" className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28">
			<div className="grid gap-14 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
				{/* Placeholder de imagem: consultor / atendimento Marko */}
				<Reveal>
					<div className="grid aspect-[4/5] w-full place-items-center rounded-3xl border-2 border-dashed border-primary/25 bg-primary/5 text-center">
						<p className="max-w-[14rem] text-sm text-primary/50">
							[ Imagem — consultor Marko em atendimento / cliente recebendo a
							chave ]
						</p>
					</div>
				</Reveal>
				<div>
					<Reveal>
						<Eyebrow>O método Marko</Eyebrow>
						<h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
							Você não compra uma cota. Você sai com{" "}
							<em className="font-display font-medium italic text-primary">
								um plano.
							</em>
						</h2>
						<p className="mt-4 text-lg text-ink/70">
							Qualquer um te vende um consórcio. O nosso trabalho é a
							estratégia em volta dele.
						</p>
					</Reveal>
					<ol className="mt-10 space-y-8">
						{METHOD.map((stage, index) => (
							<Reveal key={stage.stage} delay={index * 140}>
								<li className="border-l-2 border-accent/40 pl-6">
									<p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">
										{stage.stage}
									</p>
									<h3 className="mt-2 text-xl font-bold">{stage.title}</h3>
									<p className="mt-2 leading-relaxed text-ink/70">
										{stage.body}
									</p>
								</li>
							</Reveal>
						))}
					</ol>
				</div>
			</div>
		</section>
	);
}

function FaqSection() {
	return (
		<section id="faq" className="bg-surface-card">
			<div className="mx-auto max-w-4xl px-5 py-20 sm:px-8 lg:py-28">
				<Reveal>
					<Eyebrow>Perguntas diretas, respostas diretas</Eyebrow>
					<h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
						O que todo mundo pergunta
					</h2>
				</Reveal>
				<Reveal delay={140}>
					<div className="mt-12">
						<Faq items={FAQ_ITEMS} />
					</div>
				</Reveal>
			</div>
		</section>
	);
}

function FinalCta() {
	return (
		<section id="simulacao" className="relative overflow-hidden bg-primary">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,rgba(194,96,57,0.18),transparent_55%)]"
			/>
			<div className="relative mx-auto max-w-4xl px-5 py-20 sm:px-8 lg:py-28">
				<Reveal>
					<div className="text-center text-surface">
						<Eyebrow tone="light">Simulação gratuita</Eyebrow>
						<h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
							Descubra em 2 minutos se o consórcio é o caminho{" "}
							<em className="font-display font-medium italic text-accent">
								para o seu caso
							</em>
						</h2>
						<p className="mx-auto mt-4 max-w-2xl text-lg text-surface/75">
							Responda 4 perguntas e receba no WhatsApp a comparação com os
							seus números — incluindo a resposta honesta se o financiamento
							for melhor para você.
						</p>
					</div>
				</Reveal>
				<Reveal delay={160}>
					<div className="mt-12">
						<LeadForm />
					</div>
				</Reveal>
			</div>
		</section>
	);
}

function Footer() {
	return (
		<footer className="bg-ink text-surface/60">
			<div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-5 py-10 text-center text-sm sm:flex-row sm:justify-between sm:px-8 sm:text-left">
				<p>
					© 2026{" "}
					<span className="font-display text-base text-surface">
						Marko<span className="text-accent">.</span>
					</span>{" "}
					— Consultoria de aquisição de patrimônio
				</p>
				<p>
					Operamos com administradora autorizada pelo Banco Central ·{" "}
					<a href="#" className="underline underline-offset-2 hover:text-surface">
						Política de privacidade
					</a>
				</p>
			</div>
		</footer>
	);
}

/* --------------------------------- página --------------------------------- */

export default function Home() {
	return (
		<main className="flex-1">
			<LandingHeader />
			<Hero />
			<Enemies />
			<HowItWorks />
			<Comparison />
			<Qualification />
			<Method />
			<FaqSection />
			<FinalCta />
			<Footer />
		</main>
	);
}
