import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const discordTraceContext = new AsyncLocalStorage();

export function currentDiscordTraceId() {
  return discordTraceContext.getStore() ?? randomUUID();
}

export async function recordDiscordTrace(database, event) {
  await database.query(`
    INSERT INTO discord_message_traces
      (trace_id, direction, event_type, interaction_id, command, method, path, status, request_body, response_body, response_text, error, duration_ms)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
  `, [
    event.traceId ?? currentDiscordTraceId(), event.direction, event.eventType,
    event.interactionId ?? null, event.command ?? null, event.method ?? null,
    event.path ?? null, event.status ?? null, event.requestBody ?? null,
    event.responseBody ?? null, event.responseText ?? null, event.error ?? null,
    event.durationMs ?? null,
  ]);
}
