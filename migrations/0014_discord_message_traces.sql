CREATE TABLE discord_message_traces (
  id BIGSERIAL PRIMARY KEY,
  trace_id UUID NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  event_type TEXT NOT NULL,
  interaction_id TEXT,
  command TEXT,
  method TEXT,
  path TEXT,
  status INTEGER,
  request_body JSONB,
  response_body JSONB,
  response_text TEXT,
  error TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX discord_message_traces_trace_id_idx ON discord_message_traces (trace_id, created_at);
CREATE INDEX discord_message_traces_created_at_idx ON discord_message_traces (created_at DESC);
