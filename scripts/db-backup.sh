#!/usr/bin/env bash
# Backup noturno do Postgres (roda dentro do container db-backup).
#
# Modo `loop` (default no container): dorme até as 03:00 locais, faz o dump e
# repete. Rodar sem argumento executa UM backup imediato — útil para testar:
#   docker compose run --rm db-backup            # um backup agora
#   docker compose exec db-backup db-backup.sh   # idem, no container de pé
#
# O que cada execução faz:
#   1. pg_dump -Fc de TODAS as schemas (public + pgboss) para
#      /backups/marko-YYYYMMDD-HHMMSS.dump
#   2. Remove dumps locais com mais de BACKUP_KEEP_DAYS dias (default 14).
#   3. Se RCLONE_REMOTE estiver definido (ex.: "storagebox:marko-backups"),
#      copia o dump novo para o remoto. O remoto é configurado só por
#      variáveis de ambiente RCLONE_CONFIG_* (sem arquivo de config):
#        RCLONE_CONFIG_STORAGEBOX_TYPE=sftp
#        RCLONE_CONFIG_STORAGEBOX_HOST=uXXXXXX.your-storagebox.de
#        RCLONE_CONFIG_STORAGEBOX_USER=uXXXXXX
#        RCLONE_CONFIG_STORAGEBOX_PASS=$(rclone obscure 'senha')
#
# Conexão: usa as PG* padrão (PGHOST/PGUSER/PGPASSWORD/PGDATABASE) já
# injetadas pelo docker-compose.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
BACKUP_HOUR="${BACKUP_HOUR:-3}"

log() {
	echo "[db-backup] $(date -Iseconds) $*"
}

run_backup() {
	local stamp file
	stamp="$(date +%Y%m%d-%H%M%S)"
	file="${BACKUP_DIR}/marko-${stamp}.dump"

	log "iniciando pg_dump -> ${file}"
	pg_dump --format=custom --no-owner --no-privileges --file="${file}"
	log "dump ok ($(du -h "${file}" | cut -f1))"

	# Retenção local: remove dumps mais antigos que KEEP_DAYS.
	find "${BACKUP_DIR}" -name 'marko-*.dump' -mtime "+${KEEP_DAYS}" -delete
	log "retencao local aplicada (${KEEP_DAYS} dias)"

	# Cópia offsite opcional.
	if [[ -n "${RCLONE_REMOTE:-}" ]]; then
		log "enviando para ${RCLONE_REMOTE}"
		if rclone copy "${file}" "${RCLONE_REMOTE}" --no-traverse; then
			log "offsite ok"
		else
			# Não derruba o loop: o dump local existe; o próximo ciclo tenta de novo.
			log "ERRO: rclone falhou; dump mantido apenas localmente"
		fi
	else
		log "RCLONE_REMOTE nao configurado; backup apenas local"
	fi
}

seconds_until_next_run() {
	local now target
	now="$(date +%s)"
	target="$(date -d "today ${BACKUP_HOUR}:00" +%s)"
	if (( target <= now )); then
		target="$(date -d "tomorrow ${BACKUP_HOUR}:00" +%s)"
	fi
	echo $(( target - now ))
}

mkdir -p "${BACKUP_DIR}"

if [[ "${1:-}" == "loop" ]]; then
	log "agendador iniciado (diario as ${BACKUP_HOUR}:00, TZ=${TZ:-UTC})"
	while true; do
		sleep "$(seconds_until_next_run)"
		run_backup || log "ERRO: backup falhou; tentando novamente no proximo ciclo"
	done
else
	run_backup
fi
