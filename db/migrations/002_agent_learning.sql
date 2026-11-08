-- Agent prompt registry, orchestration strategies, evaluations, plan decisions with later outcomes, and traces.
-- Additive only. Scores come from validators and snapshot facts; nothing here stores or reads the answer key.
CREATE TABLE IF NOT EXISTS agent_prompt_versions (role text NOT NULL, version integer NOT NULL, status text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (role, version));
CREATE UNIQUE INDEX IF NOT EXISTS agent_prompt_one_champion ON agent_prompt_versions (role) WHERE status = 'champion';
CREATE TABLE IF NOT EXISTS agent_strategies (version integer PRIMARY KEY, status text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS agent_evals (id text PRIMARY KEY, cycle text NOT NULL, split text NOT NULL, role text NOT NULL, version integer NOT NULL, score double precision NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS agent_evals_role_idx ON agent_evals (role, version, split);
CREATE TABLE IF NOT EXISTS agent_decisions (id text PRIMARY KEY, cycle text NOT NULL, incident_id text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS agent_runs (id text PRIMARY KEY, run_id text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS agent_runs_run_idx ON agent_runs (run_id, created_at);
