// Compatibility entry point: the lifecycle now lives in one routed graph.
console.warn('Publishing the unified Incident Lifecycle flow.');
require('./rebuild_visual_flows.cjs').main().catch(error => { console.error(error.message); process.exitCode = 1; });
