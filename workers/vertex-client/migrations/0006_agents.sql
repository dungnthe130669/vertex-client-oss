-- Agents mode: named persistent agents live in agent-spike (AgentDO); ownership is by name prefix (`e2e-` = e2e scope).
-- agent_msgs keeps the text we sent (agent-spike inbox rows do not return it). agent_watch is the cron watcher's per-agent state:
-- watermark = epoch ms of the last finished inbox message already handled (push dedupe), seen_at = last time a client looked,
-- cost_usd/session_id = cost delta baseline for the Usage screen (cloud_costs, run_id `agent:<name>`).
CREATE TABLE agent_msgs (
  name TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (name, msg_id)
);
CREATE TABLE agent_watch (
  name TEXT PRIMARY KEY,
  watermark INTEGER NOT NULL DEFAULT 0,
  seen_at INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  session_id TEXT NOT NULL DEFAULT ''
);
