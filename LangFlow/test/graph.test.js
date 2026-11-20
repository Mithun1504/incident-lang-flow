const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFlow } = require('../scripts/rebuild_visual_flows.cjs');
const webhook = { template: { data: { value: '' } }, outputs: [{ name: 'output_data', method: 'build_data', types: ['JSON'] }] };

test('one webhook dispatches to isolated ticket, PR, and ignored branches', () => {
  const flow = buildFlow(webhook, { trigger: 'Completed', prefix: 'fix/', raised: '' });
  assert.equal(flow.data.nodes.filter(n => n.data.type === 'Webhook').length, 1);
  assert.equal(flow.data.nodes.filter(n => n.type === 'genericNode').length, 14);
  const router = flow.data.nodes.find(n => n.id === 'Route-lifecycle');
  assert.deepEqual(router.data.node.outputs.map(o => o.name), ['incident', 'jira', 'ignored']);
  assert.ok(router.data.node.outputs.every(o => o.group_outputs));
  assert.equal(new Set(flow.data.edges.map(e => e.id)).size, 13);
  assert.equal(flow.data.edges.filter(e => e.source === 'Route-lifecycle').length, 3);
  assert.ok(!flow.data.edges.some(e => e.source === 'Handoff-incident'));
  assert.ok(flow.data.nodes.every(n => !/RunFlow/.test(n.data.type)));
});
test('server-only helpers and non-secret configuration survive export', () => {
  const flow = buildFlow(webhook, { trigger: 'Completed', prefix: 'feature/', raised: '' });
  const verify = flow.data.nodes.find(n => n.id === 'Verify-resolution');
  assert.ok(verify.data.node.template.code.value.includes('class LifecycleAPI:'));
  assert.ok(!verify.data.node.template.code.value.includes('from lifecycle_api import'));
  const handoff = flow.data.nodes.find(n => n.id === 'Handoff-incident');
  assert.equal(handoff.data.node.template.trigger_status.value, 'Completed');
  assert.equal(handoff.data.node.template.branch_prefix.value, 'feature/');
  for (const node of flow.data.nodes.filter(n => n.type === 'noteNode')) {
    assert.ok(node.measured.width && node.measured.height);
    assert.equal(node.data.node.template.backgroundColor, '#edf3ff');
  }
});
test('every connection uses a declared node and input field', () => {
  const flow = buildFlow(webhook);
  const nodes = new Map(flow.data.nodes.map(n => [n.id, n]));
  for (const edge of flow.data.edges) {
    assert.ok(nodes.has(edge.source)); assert.ok(nodes.has(edge.target));
    assert.ok(nodes.get(edge.target).data.node.template[edge.data.targetHandle.fieldName]);
    assert.ok(nodes.get(edge.source).data.node.outputs.some(o => o.name === edge.data.sourceHandle.name));
  }
});
test('Jira watcher sends its typed event to the same webhook as log forwarding', async t => {
  const target = 'http://localhost:9876/api/v1/webhook/incident_to_jira';
  const saved = process.env.LANGFLOW_WEBHOOK_URL;
  process.env.LANGFLOW_WEBHOOK_URL = target;
  delete require.cache[require.resolve('../scripts/jira_pr_poller.cjs')];
  const { runFlow } = require('../scripts/jira_pr_poller.cjs');
  let captured;
  t.mock.method(global, 'fetch', async (url, options) => { captured = { url, body: JSON.parse(options.body) }; return { ok: true, status: 202 }; });
  await runFlow({ key: 'SUP-123' });
  assert.equal(captured.url, target);
  assert.deepEqual(captured.body, { event_type: 'jira.status_changed', issue: { key: 'SUP-123' } });
  if (saved === undefined) delete process.env.LANGFLOW_WEBHOOK_URL; else process.env.LANGFLOW_WEBHOOK_URL = saved;
});
