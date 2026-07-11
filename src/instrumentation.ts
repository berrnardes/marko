// Next.js instrumentation — roda UMA vez por boot do servidor (em cada cold
// start de função na Vercel), ANTES de qualquer route handler.
//
// Por que isto existe: a Vercel roda as funções em UTC e a env `TZ` é
// RESERVADA (o runtime AWS Lambda a define; não dá para configurar no
// dashboard em nenhum plano). Mas a lógica de "hora/dia local" do domínio —
// janela de envio, data de início do warm-up gravada no cadastro de número,
// contagem de dias — usa o fuso do processo Node. Então o fuso é pinado aqui,
// em código, no início do processo.
//
// O WORKER não passa por aqui (entry point próprio, `src/worker/index.ts`);
// ele recebe TZ=America/Sao_Paulo pelo docker-compose. Os dois caminhos
// precisam concordar.
//
// `APP_TZ` (env NÃO reservada) permite trocar o fuso sem deploy, se um dia
// for preciso. Futuro multi-tenant: isto vira configuração por tenant.

export function register(): void {
	// Só no runtime Node: no Edge runtime não há fuso configurável (e o proxy
	// de sessão que roda lá não faz lógica de data).
	if (process.env.NEXT_RUNTIME === "nodejs") {
		// Sobrescreve INCONDICIONALMENTE: a Lambda já define TZ (=UTC), então um
		// `??=` nunca aplicaria o fuso do negócio.
		process.env.TZ = process.env.APP_TZ ?? "America/Sao_Paulo";
	}
}
