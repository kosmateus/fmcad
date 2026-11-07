'use strict';
function clientKind(id) {
  if (typeof id !== 'string') return 'Other';
  if (id.startsWith('mcp-stdio:')) return 'MCP stdio';
  if (id.startsWith('opencode:')) return 'OpenCode';
  if (id.startsWith('cli:')) return 'CLI';
  return 'Other';
}
function presenceText(row, ui) {
  return row.source === 'job-history' ? ui.language === 'pl' ? 'Tylko historia' : 'History only' : ui.statusText(row.presence);
}
function presenceSummary(snapshot, ui) {
  const agents = snapshot.agents || [];
  const observed = snapshot.available === false ? 0 : agents.filter(agent => agent.presence === 'observed').length;
  if (observed) return `${observed} · ${ui.L('clientPresenceConfirmed')}`;
  const tracked = agents.filter(agent => agent.source?.endsWith('process-heartbeat'));
  if (tracked.length) return `0 online · ${tracked.filter(agent => agent.presence === 'offline').length} offline · ${tracked.filter(agent => agent.presence !== 'offline').length} ${ui.L('unconfirmed')}`;
  return ui.L('clientPresenceUnmeasured');
}
module.exports = { clientKind, presenceText, presenceSummary };
