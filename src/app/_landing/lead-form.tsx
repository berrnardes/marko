"use client";

// Qualifying form (section 8 of the copy). The four ICP questions are asked
// here and the answers travel inside the pre-filled WhatsApp message, so the
// lead lands in the conversation already qualified. No backend involved yet —
// submission opens wa.me with the composed text.

import { useState } from "react";

// TODO: trocar pelo número comercial real (formato E.164, sem "+").
// Pode ser sobrescrito via env em tempo de build.
const WHATSAPP_NUMBER =
	process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? "5547999999999";

const GOAL_OPTIONS = [
	"Primeiro imóvel para morar",
	"Imóvel maior / trocar de casa",
	"Imóvel para investir",
	"Terreno ou construção",
];

const TIMELINE_OPTIONS = [
	"Menos de 1 ano",
	"1 a 2 anos",
	"2 a 4 anos",
	"Mais de 4 anos / sem pressa",
];

const RESERVE_OPTIONS = [
	"Sim, tenho FGTS",
	"Sim, tenho uma reserva guardada",
	"Ainda não, mas consigo construir",
	"Não",
];

function RadioPills({
	name,
	legend,
	options,
	value,
	onChange,
}: {
	name: string;
	legend: string;
	options: string[];
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<fieldset>
			<legend className="mb-3 text-sm font-semibold text-ink">{legend}</legend>
			<div className="flex flex-wrap gap-2">
				{options.map((option) => (
					<label key={option} className="cursor-pointer">
						<input
							type="radio"
							name={name}
							value={option}
							checked={value === option}
							onChange={() => onChange(option)}
							className="peer sr-only"
						/>
						<span className="inline-block rounded-full border border-ink/20 px-4 py-2 text-sm text-ink/80 transition-colors duration-150 peer-checked:border-primary peer-checked:bg-primary peer-checked:text-surface peer-focus-visible:ring-2 peer-focus-visible:ring-accent hover:border-primary/50">
							{option}
						</span>
					</label>
				))}
			</div>
		</fieldset>
	);
}

export function LeadForm() {
	const [name, setName] = useState("");
	const [phone, setPhone] = useState("");
	const [goal, setGoal] = useState("");
	const [timeline, setTimeline] = useState("");
	const [reserve, setReserve] = useState("");
	const [error, setError] = useState<string | null>(null);

	function handleSubmit(event: React.FormEvent) {
		event.preventDefault();
		if (!name.trim() || !phone.trim() || !goal || !timeline || !reserve) {
			setError("Preencha todos os campos para montarmos a sua simulação.");
			return;
		}
		setError(null);
		const message = [
			"Olá! Quero fazer minha simulação gratuita.",
			`• Nome: ${name.trim()}`,
			`• WhatsApp: ${phone.trim()}`,
			`• Objetivo: ${goal}`,
			`• Prazo para usar o imóvel: ${timeline}`,
			`• FGTS ou reserva para lance: ${reserve}`,
		].join("\n");
		window.open(
			`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`,
			"_blank",
			"noopener,noreferrer",
		);
	}

	return (
		<form
			onSubmit={handleSubmit}
			noValidate
			className="space-y-7 rounded-3xl bg-surface-card p-6 shadow-xl shadow-primary/20 sm:p-10"
		>
			<div className="grid gap-5 sm:grid-cols-2">
				<div>
					<label
						htmlFor="lead-name"
						className="mb-2 block text-sm font-semibold text-ink"
					>
						Seu nome
					</label>
					<input
						id="lead-name"
						type="text"
						autoComplete="name"
						placeholder="Como podemos te chamar?"
						value={name}
						onChange={(event) => setName(event.target.value)}
						className="w-full rounded-xl border border-ink/20 bg-surface/50 px-4 py-3 text-ink placeholder:text-ink/40 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
					/>
				</div>
				<div>
					<label
						htmlFor="lead-phone"
						className="mb-2 block text-sm font-semibold text-ink"
					>
						WhatsApp
					</label>
					<input
						id="lead-phone"
						type="tel"
						autoComplete="tel"
						placeholder="(47) 9 9999-9999"
						value={phone}
						onChange={(event) => setPhone(event.target.value)}
						className="w-full rounded-xl border border-ink/20 bg-surface/50 px-4 py-3 text-ink placeholder:text-ink/40 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
					/>
				</div>
			</div>

			<RadioPills
				name="goal"
				legend="Qual imóvel você quer conquistar?"
				options={GOAL_OPTIONS}
				value={goal}
				onChange={setGoal}
			/>
			<RadioPills
				name="timeline"
				legend="Em quanto tempo você quer usar o imóvel?"
				options={TIMELINE_OPTIONS}
				value={timeline}
				onChange={setTimeline}
			/>
			<RadioPills
				name="reserve"
				legend="Você tem FGTS ou alguma reserva que poderia usar como lance?"
				options={RESERVE_OPTIONS}
				value={reserve}
				onChange={setReserve}
			/>

			{error ? (
				<p role="alert" className="text-sm font-medium text-accent">
					{error}
				</p>
			) : null}

			<div className="space-y-3">
				<button
					type="submit"
					className="flex w-full items-center justify-center gap-2 rounded-full bg-accent px-6 py-4 text-base font-semibold text-white shadow-lg shadow-accent/30 transition-transform duration-200 hover:-translate-y-0.5 motion-reduce:transform-none"
				>
					<svg
						aria-hidden
						viewBox="0 0 24 24"
						fill="currentColor"
						className="size-5"
					>
						<path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.6 0-3.1-.4-4.4-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.6-6.1c-.3-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1-.2.3-.6.8-.8 1-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.4-2.9c-.3-.4 0-.5.1-.7l.4-.5c.1-.2.2-.3.3-.5v-.5c0-.1-.6-1.4-.8-1.9-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.2.3-.9.9-.9 2.1s.9 2.5 1 2.6c.1.2 1.8 2.8 4.4 3.9.6.3 1.1.4 1.5.6.6.2 1.2.2 1.6.1.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2l-.4-.2Z" />
					</svg>
					Receber minha simulação no WhatsApp
				</button>
				<p className="text-center text-xs text-ink/50">
					Sem spam. Seus dados são usados apenas para a simulação.
				</p>
			</div>
		</form>
	);
}
