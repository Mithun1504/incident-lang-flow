const icons = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  projects: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  team: '<circle cx="9" cy="8" r="3"/><path d="M2 21v-3a7 7 0 0 1 14 0v3M16 5a3 3 0 0 1 0 6M22 21v-3a6 6 0 0 0-4-5"/>',
  settings: '<path d="m12 3 2 3 4-1 1 4 3 3-3 3-1 4-4-1-2 3-2-3-4 1-1-4-3-3 3-3 1-4 4 1Z"/><circle cx="12" cy="12" r="3"/>',
  alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v4m0 3v1"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>'
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.dashboard}</svg>`; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
const pages = {
  '/dashboard': { label: 'Dashboard', icon: 'dashboard', endpoint: '/api/dashboard', render: dashboard },
  '/my-profile': { label: 'My profile', icon: 'profile', endpoint: '/api/my-profile', render: profile },
  '/projects': { label: 'Projects', icon: 'projects', endpoint: '/api/projects', render: projects },
  '/team': { label: 'Team', icon: 'team', endpoint: '/api/team', render: team },
  '/settings': { label: 'Settings', icon: 'settings', endpoint: '/api/settings', render: settings }
};
const content = document.getElementById('page-content');
const navigation = document.getElementById('navigation');
navigation.innerHTML = Object.entries(pages).map(([path, page]) => `<a href="${path}" data-nav>${icon(page.icon)}<span>${page.label}</span></a>`).join('');
document.getElementById('failure-icon').innerHTML = icon('alert');
document.getElementById('menu-toggle').innerHTML = icon('menu');
let activeController;
let pageData;
let toastTimer;

function toast(message, error = false) {
  const box = document.getElementById('toast');
  clearTimeout(toastTimer); box.textContent = message; box.className = `toast${error ? ' error' : ''}`; box.hidden = false;
  toastTimer = setTimeout(() => { box.hidden = true; }, 6500);
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'This request could not be completed.');
  return data;
}
async function navigate(path, push = false) {
  path = pages[path] ? path : '/dashboard';
  if (push) history.pushState({}, '', path);
  const page = pages[path];
  document.title = `${page.label} · Northstar`;
  document.getElementById('breadcrumb-page').textContent = page.label;
  navigation.querySelectorAll('a').forEach(a => a.href.endsWith(path) ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  closeSidebar();
  activeController?.abort(); activeController = new AbortController();
  content.setAttribute('aria-busy', 'true');
  content.innerHTML = '<div role="status" aria-label="Loading page"><div class="skeleton heading"></div><div class="skeleton" style="width:60%"></div><div class="skeleton block"></div></div>';
  try {
    const data = await api(page.endpoint, { signal: activeController.signal });
    pageData = data; content.innerHTML = page.render(data); bindPage(path);
    content.setAttribute('aria-busy', 'false');
    if (push) { document.getElementById('main').focus(); window.scrollTo(0, 0); }
  } catch (error) {
    if (error.name === 'AbortError') return;
    content.setAttribute('aria-busy', 'false');
    content.innerHTML = `<div class="error-box" role="alert"><h1>We couldn’t load this page</h1><p>${esc(error.message)}</p><button class="button" id="retry-page">Try again</button></div>`;
    document.getElementById('retry-page').onclick = () => navigate(path);
  }
}
function heading(title, description, action = '') { return `<div class="page-heading"><div><h1>${esc(title)}</h1><p class="description">${esc(description)}</p></div>${action}</div>`; }
function tag(status) { return `<span class="tag ${status === 'Completed' || status === 'Active' ? 'green' : status === 'In progress' ? 'blue' : status === 'In review' ? 'amber' : ''}">${esc(status)}</span>`; }
function progress(n) { return `<div class="progress"><div class="progress-track" role="progressbar" aria-label="Project completion" aria-valuenow="${n}" aria-valuemin="0" aria-valuemax="100"><span class="progress-fill" style="--progress:${n}%"></span></div><span>${n}%</span></div>`; }
function projectRows(items, detailed = false) {
  return items.map(p => `<tr><td><div class="project-name">${esc(p.name)}</div><div class="${detailed ? 'subtext' : 'project-id'}">${esc(detailed ? p.description : p.id)}</div></td><td>${tag(p.status)}</td>${detailed ? `<td><span class="person-cell"><span class="avatar avatar-small">${p.initials}</span>${esc(p.owner)}</span></td>` : ''}<td>${progress(p.progress)}</td>${detailed ? `<td>${esc(p.due)}</td>` : ''}</tr>`).join('');
}
function dashboard(d) {
  const metrics = [ ['Active projects', d.stats.activeProjects, 'Across your workspace', 'projects'], ['Tasks completed', d.stats.completedTasks, '<span class="positive">+12</span> this month', 'check'], ['Team members', d.stats.teamMembers, 'Working better together', 'team'], ['Upcoming deadlines', d.stats.upcomingDeadlines, 'In the next 30 days', 'calendar'] ];
  return heading('Good morning, Maya', 'Here’s what’s happening across your workspace.', `<a class="button" href="/projects" data-nav>View projects ${icon('arrow')}</a>`) +
    `<section class="metrics" aria-label="Workspace overview">${metrics.map(([label, number, note, glyph]) => `<div class="metric"><div class="metric-label">${label}${icon(glyph)}</div><div class="metric-value">${number}</div><div class="metric-note">${note}</div></div>`).join('')}</section>
    <div class="content-grid"><section class="panel"><div class="panel-head"><h2>Projects at a glance</h2><a href="/projects" data-nav>View all projects →</a></div><div class="table-wrap"><table><thead><tr><th scope="col">Project</th><th scope="col">Status</th><th scope="col">Progress</th></tr></thead><tbody>${projectRows(d.projects)}</tbody></table></div></section>
    <section class="panel"><div class="panel-head"><h2>Your upcoming work</h2><span class="tag">3 tasks</span></div>${d.tasks.map(t => `<div class="task"><span class="task-icon" aria-hidden="true">${icon('calendar')}</span><div><h3>${esc(t.title)}</h3><div class="subtext">${esc(t.project)}</div><div class="task-meta"><span class="${t.due === 'Today' ? 'due-today' : ''}">${esc(t.due)}</span><span>·</span><span>${t.status}</span></div></div></div>`).join('')}</section></div>
    <section class="panel activity-panel"><div class="panel-head"><h2>Recent activity</h2><span class="result-count">Across your team</span></div>${d.activity.map(a => `<div class="activity-item"><span class="avatar">${a.initials}</span><div class="activity-copy"><strong>${esc(a.name)}</strong> ${esc(a.action)}<div class="subtext">${esc(a.project)}</div></div><time class="activity-time">${a.time}</time></div>`).join('')}</section>`;
}
function field(label, key, value, options = '') { return `<label class="field"><span>${label}</span><input name="${key}" value="${esc(value)}" ${options}></label>`; }
function profile(d) {
  const p = d.profile;
  return heading('My profile', 'Your personal details and workspace information.') + `<div class="profile-grid"><section class="panel profile-summary"><span class="avatar large">ML</span><h2>${esc(p.name)}</h2><p>${esc(p.title)}</p><span class="tag blue">${esc(p.department)}</span><div class="profile-meta"><div>Location<strong>${esc(p.location)}</strong></div><div>Member since<strong>${esc(p.joined)}</strong></div><div>Workspace<strong>Northstar</strong></div></div></section>
    <form class="panel" id="profile-form"><div class="panel-head"><div><h2>Personal information</h2><p class="panel-description">Keep your teammates up to date.</p></div></div><div class="form-body"><div class="field-grid">${field('Full name', 'name', p.name, 'required maxlength="80"')}${field('Job title', 'title', p.title, 'maxlength="100"')}${field('Email address', 'email', p.email, 'type="email" readonly')}${field('Phone number', 'phone', p.phone, 'type="tel" maxlength="40"')}${field('Location', 'location', p.location, 'maxlength="100"')}${field('Department', 'department', p.department, 'readonly')}<label class="field full"><span>About you</span><textarea name="bio" rows="4" maxlength="300">${esc(p.bio)}</textarea><small>A short introduction for your team.</small></label></div></div><div class="form-actions"><span class="saved-note">Edits apply to this demo session.</span><button class="button primary" type="submit">Save changes</button></div></form></div>`;
}
function projects(d) {
  return heading('Projects', 'A shared view of the work moving your team forward.') + `<section class="panel"><div class="toolbar"><input class="search" id="project-search" aria-label="Search projects" placeholder="Search projects or owners…" type="search"><span class="result-count" id="project-count">${d.projects.length} projects</span></div><div class="table-wrap"><table><thead><tr><th scope="col">Project</th><th scope="col">Status</th><th scope="col">Owner</th><th scope="col">Progress</th><th scope="col">Due date</th></tr></thead><tbody id="project-rows">${projectRows(d.projects, true)}</tbody></table></div></section>`;
}
function teamRows(items) { return items.map(m => `<tr><td><div class="person-cell"><span class="avatar">${m.initials}</span><div class="project-name">${esc(m.name)}<div class="subtext">${esc(m.email)}</div></div></div></td><td>${esc(m.role)}</td><td>${esc(m.department)}</td><td>${esc(m.location)}</td><td>${tag(m.status)}</td></tr>`).join(''); }
function team(d) {
  return heading('Team', 'Good work starts with knowing the people behind it.') + `<section class="panel"><div class="toolbar"><input class="search" id="team-search" aria-label="Search team" placeholder="Search names, roles, or departments…" type="search"><span class="result-count" id="team-count">${d.members.length} members</span></div><div class="table-wrap"><table><thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Department</th><th scope="col">Location</th><th scope="col">Status</th></tr></thead><tbody id="team-rows">${teamRows(d.members)}</tbody></table></div></section>`;
}
function settings(d) {
  const s = d.settings;
  const prefs = [['weeklyDigest', 'Weekly digest', 'A weekly summary of progress across your projects.'], ['projectUpdates', 'Project updates', 'Stay informed when a project you follow changes.'], ['taskReminders', 'Task reminders', 'A friendly reminder before your work is due.']];
  return heading('Settings', 'Make this workspace work for you.') + `<div class="settings-section settings-layout"><div class="settings-intro"><h2>Workspace details</h2><p>Your team’s shared home.<br>These details are managed by your workspace administrator.</p></div><section class="panel"><div class="form-body"><div class="field-grid">${field('Workspace name', 'workspace', s.workspace, 'readonly')}${field('Time zone', 'timezone', s.timezone, 'readonly')}</div></div></section></div><div class="settings-section settings-layout"><div class="settings-intro"><h2>Notifications</h2><p>Choose the updates you want to receive.</p></div><form class="panel" id="settings-form">${prefs.map(([key, label, desc]) => `<label class="preference"><span><strong>${label}</strong><p>${desc}</p></span><input type="checkbox" name="${key}" ${s[key] ? 'checked' : ''}></label>`).join('')}<div class="form-actions"><span class="saved-note">Preferences apply to this session.</span><button class="button primary" type="submit">Save preferences</button></div></form></div>`;
}
function bindPage(path) {
  if (path === '/projects') document.getElementById('project-search').oninput = event => {
    const q = event.target.value.toLowerCase(); const rows = pageData.projects.filter(p => `${p.name} ${p.owner}`.toLowerCase().includes(q));
    document.getElementById('project-rows').innerHTML = projectRows(rows, true) || '<tr><td colspan="5" class="empty">No projects match your search.</td></tr>';
    document.getElementById('project-count').textContent = `${rows.length} projects`;
  };
  if (path === '/team') document.getElementById('team-search').oninput = event => {
    const q = event.target.value.toLowerCase(); const rows = pageData.members.filter(m => `${m.name} ${m.role} ${m.department}`.toLowerCase().includes(q));
    document.getElementById('team-rows').innerHTML = teamRows(rows) || '<tr><td colspan="5" class="empty">No team members match your search.</td></tr>';
    document.getElementById('team-count').textContent = `${rows.length} members`;
  };
  for (const [id, url, method] of [['profile-form', '/api/my-profile', 'PATCH'], ['settings-form', '/api/settings', 'PUT']]) {
    const form = document.getElementById(id); if (!form) continue;
    form.onsubmit = async event => {
      event.preventDefault(); const button = form.querySelector('button[type=submit]'); const label = button.textContent;
      button.disabled = true; button.textContent = 'Saving…';
      const body = id === 'settings-form' ? Object.fromEntries([...form.querySelectorAll('input[type=checkbox]')].map(el => [el.name, el.checked])) : Object.fromEntries(new FormData(form));
      try { const result = await api(url, { method, body: JSON.stringify(body) }); toast(result.message); }
      catch (error) { toast(error.message, true); }
      finally { button.disabled = false; button.textContent = label; }
    };
  }
}
document.addEventListener('click', event => {
  const link = event.target.closest('a[data-nav]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault(); navigate(new URL(link.href).pathname, true);
});
window.addEventListener('popstate', () => navigate(location.pathname));
const mobile = window.matchMedia('(max-width:760px)');
function syncSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.inert = mobile.matches && !sidebar.classList.contains('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('menu-toggle').setAttribute('aria-expanded', 'false');
  // Called only after initialization, including on page navigation.
  if (typeof mobile !== 'undefined') syncSidebar();
}
mobile.addEventListener('change', syncSidebar);
document.getElementById('menu-toggle').onclick = () => {
  const open = document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('menu-toggle').setAttribute('aria-expanded', String(open));
  syncSidebar();
  if (open) document.getElementById('close-menu').focus();
};
document.getElementById('close-menu').onclick = () => { closeSidebar(); document.getElementById('menu-toggle').focus(); };
document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeSidebar(); document.getElementById('menu-toggle').focus(); } });
document.addEventListener('click', event => {
  if (!document.getElementById('sidebar').contains(event.target) && !document.getElementById('menu-toggle').contains(event.target)) closeSidebar();
});
syncSidebar();
document.getElementById('simulate-failure').onclick = async event => {
  const button = event.currentTarget; button.disabled = true;
  try { await api('/api/simulate-failure', { method: 'POST' }); toast('The service request completed.'); }
  catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
};
navigate(location.pathname);
