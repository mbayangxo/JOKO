const API = '/api/admin';
const TOKEN_KEY = 'k21_admin_token';

let challengeToken = null;
let dashboard = null;

function $(id) {
  return document.getElementById(id);
}

function token() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

function show(el, visible) {
  el.classList.toggle('hidden', !visible);
}

function fmtXof(n) {
  return `${Number(n).toLocaleString('fr-FR')} FCFA`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('fr-FR');
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token()) headers.Authorization = `Bearer ${token()}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function tableHtml(columns, rows, rowHtml) {
  if (!rows?.length) return '<p style="padding:14px;color:var(--muted)">None</p>';
  return `<table><thead><tr>${columns.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table>`;
}

function showModal(title, data, actionsHtml = '') {
  $('modal-title').textContent = title;
  $('modal-body').textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  $('modal-actions').innerHTML = actionsHtml;
  show($('modal'), true);
}

function renderStats(d) {
  const k = d.kori;
  $('stats-grid').innerHTML = `
    <div class="stat"><div class="label">Tx today</div><div class="value">${d.transactions.today}</div></div>
    <div class="stat"><div class="label">Tx this week</div><div class="value">${d.transactions.week}</div></div>
    <div class="stat"><div class="label">Tx this month</div><div class="value">${d.transactions.month}</div></div>
    <div class="stat ${k.reserveOk ? '' : 'bad'}"><div class="label">Kori circulation</div><div class="value">${k.circulation}</div></div>
    <div class="stat ${k.reserveOk ? '' : 'warn'}"><div class="label">Reserve XOF</div><div class="value">${fmtXof(k.reserveXof)}</div></div>
    <div class="stat"><div class="label">Signups today</div><div class="value">${d.signupsToday}</div></div>
  `;
}

function renderDashboard(d) {
  dashboard = d;
  renderStats(d);

  const mc = d.morningCheck;
  const alertEl = $('morning-alerts');
  if (mc && !mc.healthy) {
    alertEl.innerHTML = `<strong style="color:var(--r)">Morning check — attention needed</strong><ul style="margin:8px 0 0;padding-left:20px">${mc.alerts.map((a) => `<li>${a}</li>`).join('')}</ul>`;
    show(alertEl, true);
  } else {
    show(alertEl, false);
  }

  $('failed-table').innerHTML = tableHtml(
    ['Ref', 'User', 'Reason', 'When'],
    d.failedTransactionsToday,
    (r) => `<tr>
      <td><button class="btn btn-ghost btn-sm" data-tx="${r.reference}">${r.reference.slice(0, 10)}…</button></td>
      <td>${r.user?.name || r.user?.phone || r.userId}</td>
      <td>${r.failureReason || '—'}</td>
      <td>${fmtDate(r.createdAt)}</td>
    </tr>`,
  );

  $('merchants-table').innerHTML = tableHtml(
    ['Merchant', 'Volume'],
    d.topMerchants,
    (m) => `<tr><td>${m.businessName || m.name || m.handle || m.phone}</td><td>${fmtXof(m.volume)}</td></tr>`,
  );

  $('pending-rails').innerHTML = tableHtml(
    ['Ref', 'User', 'Amount', 'Age', ''],
    d.pendingOlderThan15Min.rails,
    (r) => `<tr>
      <td>${r.reference.slice(0, 12)}…</td>
      <td>${r.user?.phone || r.userId}</td>
      <td>${fmtXof(r.amount)}</td>
      <td>${r.ageMinutes}m</td>
      <td>
        <button class="btn btn-sm btn-primary" data-release="${r.id}" data-action="poll">Poll</button>
        <button class="btn btn-sm btn-ghost" data-release="${r.id}" data-action="complete">Complete</button>
        <button class="btn btn-sm btn-danger" data-release="${r.id}" data-action="failed">Fail</button>
      </td>
    </tr>`,
  );

  $('pending-held').innerHTML = tableHtml(
    ['Ref', 'Type', 'Amount', ''],
    d.pendingOlderThan15Min.held,
    (h) => `<tr>
      <td>${h.reference}</td>
      <td>${h.operationType}</td>
      <td>${fmtXof(h.amountNational)}</td>
      <td>
        <button class="btn btn-sm btn-primary" data-held-approve="${h.id}">Approve</button>
        <button class="btn btn-sm btn-danger" data-held-reject="${h.id}">Reject</button>
      </td>
    </tr>`,
  );

  $('fraud-alerts').innerHTML = tableHtml(
    ['Code', 'User', 'Message', ''],
    d.fraudAlerts,
    (a) => `<tr>
      <td><span class="badge badge-high">${a.code}</span></td>
      <td>${a.user?.phone || a.userId}</td>
      <td>${a.message}</td>
      <td><button class="btn btn-sm btn-ghost" data-ack-fraud="${a.id}">Ack</button></td>
    </tr>`,
  );

  $('support-tickets').innerHTML = tableHtml(
    ['Subject', 'User', 'Status', ''],
    d.supportTickets,
    (t) => `<tr>
      <td>${t.subject}</td>
      <td>${t.user?.phone || t.userId}</td>
      <td><span class="badge badge-open">${t.status}</span></td>
      <td><button class="btn btn-sm btn-ghost" data-ticket="${t.id}">Open</button></td>
    </tr>`,
  );

  $('deliveries-table').innerHTML = tableHtml(
    ['Area', 'Status', 'Driver', 'Fee'],
    d.activeDeliveries,
    (x) => `<tr>
      <td>${x.dropoffArea}</td>
      <td>${x.status}</td>
      <td>${x.driver?.name || x.driver?.phone || '—'}</td>
      <td>${fmtXof(x.deliveryFeeNational)}</td>
    </tr>`,
  );

  $('riders-table').innerHTML = tableHtml(
    ['Rider', 'Completed', 'Avg rating'],
    d.riderPerformance,
    (r) => `<tr>
      <td>${r.name || r.handle || r.phone}</td>
      <td>${r.completedDeliveries}</td>
      <td>${r.averageRating ?? 'N/A'}${r.ratedCount ? ` (${r.ratedCount})` : ''}</td>
    </tr>`,
  );

  renderAgents(d.agents);
}

function renderAgents(agentsBlock) {
  if (!agentsBlock?.summary) {
    $('agents-stats').innerHTML = '';
    $('agents-table').innerHTML = '<p style="padding:14px;color:var(--muted)">No agent data</p>';
    return;
  }
  const s = agentsBlock.summary;
  const pendingCount = (agentsBlock.agents ?? []).filter((a) => a.status === 'pending').length;
  $('agents-stats').innerHTML = `
    <div class="stat"><div class="label">Agents</div><div class="value">${s.agentCount}</div></div>
    <div class="stat"><div class="label">Pending</div><div class="value">${pendingCount}</div></div>
    <div class="stat"><div class="label">Total float</div><div class="value">${fmtXof(s.totalFloatBalanceXof)}</div></div>
    <div class="stat"><div class="label">Confirmed deposits</div><div class="value">${fmtXof(s.totalConfirmedDepositsXof)}</div></div>
    <div class="stat"><div class="label">Implied cash held</div><div class="value">${fmtXof(s.impliedCashHeldXof)}</div></div>
    <div class="stat"><div class="label">Pending QR sessions</div><div class="value">${s.pendingDepositSessions}</div></div>
  `;

  $('agents-table').innerHTML = tableHtml(
    ['Code', 'Name', 'Status', 'Float', 'Limit', 'Deposits', 'Location', 'Actions'],
    agentsBlock.agents,
    (a) => `<tr>
      <td>${a.agentCode}</td>
      <td>${a.displayName}<br><small>${a.user?.phone || a.userId}</small></td>
      <td><span class="pill ${a.status === 'active' ? 'ok' : a.status === 'pending' ? 'warn' : 'bad'}">${a.status}</span></td>
      <td>${fmtXof(a.floatBalance)}</td>
      <td>${fmtXof(a.floatLimit)}</td>
      <td>${a.confirmedDeposits ?? 0}</td>
      <td>${a.locationLabel || '—'}</td>
      <td>
        ${a.status === 'pending' ? `<button type="button" class="link-btn" data-approve-agent="${a.id}">Approve</button>` : ''}
        ${a.status === 'pending' ? `<button type="button" class="link-btn danger" data-reject-agent="${a.id}">Reject</button>` : ''}
      </td>
    </tr>`,
  );

  $('agents-table').querySelectorAll('[data-approve-agent]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/agents/${encodeURIComponent(btn.dataset.approveAgent)}/approve`, { method: 'POST', body: {} });
        alert('Agent approved');
        await loadDashboard();
      } catch (error) {
        alert(error.message);
      }
    });
  });

  $('agents-table').querySelectorAll('[data-reject-agent]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reason = prompt('Reason for rejection?');
      if (!reason || reason.length < 3) return;
      try {
        await api(`/agents/${encodeURIComponent(btn.dataset.rejectAgent)}/reject`, { method: 'POST', body: { reason } });
        alert('Agent rejected');
        await loadDashboard();
      } catch (error) {
        alert(error.message);
      }
    });
  });
}

async function loadFloatRequestsTab() {
  const res = await api('/agent-float-requests?status=pending');
  $('float-requests-table').innerHTML = tableHtml(
    ['Agent', 'Amount', 'Note', 'Requested', 'Actions'],
    res.requests ?? [],
    (r) => `<tr>
      <td>${r.agent?.agentCode ?? r.agentId}<br><small>${r.agentUser?.phone ?? r.agentUser?.handle ?? ''}</small></td>
      <td>${fmtXof(r.amountXof)}</td>
      <td>${r.note ?? '—'}</td>
      <td>${fmtDate(r.createdAt)}</td>
      <td>
        <button type="button" class="link-btn" data-approve-float-request="${r.id}">Approve</button>
        <button type="button" class="link-btn danger" data-reject-float-request="${r.id}">Reject</button>
      </td>
    </tr>`,
  );

  $('float-requests-table').querySelectorAll('[data-approve-float-request]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/agent-float-requests/${encodeURIComponent(btn.dataset.approveFloatRequest)}/approve`, {
          method: 'POST',
          body: {},
        });
        alert('Float request approved');
        await loadFloatRequestsTab();
        await loadDashboard();
      } catch (error) {
        alert(error.message);
      }
    });
  });

  $('float-requests-table').querySelectorAll('[data-reject-float-request]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reason = prompt('Reason for rejection? (optional)') || undefined;
      try {
        await api(`/agent-float-requests/${encodeURIComponent(btn.dataset.rejectFloatRequest)}/reject`, {
          method: 'POST',
          body: { reason },
        });
        alert('Float request rejected');
        await loadFloatRequestsTab();
      } catch (error) {
        alert(error.message);
      }
    });
  });
}

async function loadSupportTab() {
  const [stats, calls, ticketsRes] = await Promise.all([
    api('/support/stats'),
    api('/support/calls'),
    api('/support-tickets'),
  ]);
  $('support-stats').innerHTML = `
    <div class="stat"><div class="label">Open tickets</div><div class="value">${stats.tickets.open}</div></div>
    <div class="stat"><div class="label">Pending</div><div class="value">${stats.tickets.pending}</div></div>
    <div class="stat"><div class="label">Resolved today</div><div class="value">${stats.tickets.resolvedToday}</div></div>
    <div class="stat"><div class="label">Calls today</div><div class="value">${stats.calls.today}</div></div>
    <div class="stat"><div class="label">Avg resolution (h)</div><div class="value">${stats.tickets.avgResolutionHours ?? '—'}</div></div>
  `;
  $('cs-contact-line').textContent = `CS: ${stats.contact.phone} · ${stats.contact.hours}`;
  $('support-tickets').innerHTML = tableHtml(
    ['Subject', 'User', 'Status', ''],
    ticketsRes.tickets ?? [],
    (t) => `<tr>
      <td>${t.subject}</td>
      <td>${t.user?.phone || t.userId}</td>
      <td><span class="badge badge-open">${t.status}</span></td>
      <td><button class="btn btn-sm btn-ghost" data-ticket="${t.id}">Open</button></td>
    </tr>`,
  );
  $('support-calls').innerHTML = tableHtml(
    ['Phone', 'Outcome', 'When'],
    calls.calls,
    (c) => `<tr><td>${c.phone}</td><td>${c.outcome ?? '—'}</td><td>${fmtDate(c.createdAt)}</td></tr>`,
  );
}

async function loadUsersTab() {
  const kyc = await api('/kyc/queue');
  const cniRows = kyc.cniJobs ?? [];
  const addrRows = kyc.addressReviews ?? [];
  $('kyc-queue').innerHTML = `
    <h3 class="section-title">CNI pending (${cniRows.length})</h3>
    ${tableHtml(['User', 'Submitted', ''], cniRows, (j) => `<tr>
      <td>${j.user?.phone ?? j.userId}<br><small>${j.user?.handle ?? ''}</small></td>
      <td>${fmtDate(j.submittedAt)}</td>
      <td>
        <button class="btn btn-sm btn-primary" data-kyc-approve="${j.id}">Approve</button>
        <button class="btn btn-sm btn-danger" data-kyc-reject="${j.id}">Reject</button>
      </td>
    </tr>`)}
    <h3 class="section-title" style="margin-top:20px">Address pending (${addrRows.length})</h3>
    ${tableHtml(['User', 'Area', ''], addrRows, (u) => `<tr>
      <td>${u.phone}<br><small>${u.handle ?? ''}</small></td>
      <td>${u.arrondissement ?? '—'}</td>
      <td><button class="btn btn-sm btn-primary" data-kyc-addr="${u.userId}">Approve Tier 3</button></td>
    </tr>`)}
  `;
}

async function searchUsers() {
  const q = $('user-search-q').value.trim();
  if (q.length < 2) return alert('Enter at least 2 characters');
  const res = await api(`/users?q=${encodeURIComponent(q)}`);
  $('users-table').innerHTML = tableHtml(
    ['User', 'Tier', 'Balance', ''],
    res.users,
    (u) => `<tr>
      <td>${u.phone}<br><small>${u.name ?? ''} ${u.handle ?? ''}</small></td>
      <td>T${u.verificationTier} · ${u.verificationStatus}${u.frozen ? ' · FROZEN' : ''}</td>
      <td>${u.koriFormatted}</td>
      <td><button class="btn btn-sm btn-ghost" data-user-detail="${u.id}">View</button></td>
    </tr>`,
  );
}

async function loadDistributorsTab() {
  const res = await api('/distributors');
  $('distributors-table').innerHTML = tableHtml(
    ['Brand', 'Owner', 'KEBU', 'Receivable', ''],
    res.distributors,
    (d) => `<tr>
      <td>${d.name}${d.pauseOrders ? ' ⏸' : ''}</td>
      <td>${d.owner?.phone ?? d.owner?.handle ?? '—'}</td>
      <td>${d.kebuFormatted}</td>
      <td>${d.totalReceivableFormatted}</td>
      <td>
        <button class="btn btn-sm btn-ghost" data-dist-detail="${d.id}">Detail</button>
        <button class="btn btn-sm btn-danger" data-dist-pause="${d.id}">${d.pauseOrders ? 'Resume' : 'Pause'}</button>
      </td>
    </tr>`,
  );
}

async function loadOpsTab() {
  const [ops, health] = await Promise.all([
    api('/ops/health'),
    fetch('/api/health?deep=1').then((r) => r.json()).catch(() => null),
  ]);
  $('ops-stats').innerHTML = `
    <div class="stat"><div class="label">Users</div><div class="value">${ops.platform.userCount}</div></div>
    <div class="stat"><div class="label">Distributors</div><div class="value">${ops.platform.distributorCount}</div></div>
    <div class="stat"><div class="label">KYC pending</div><div class="value">${ops.platform.pendingKycJobs}</div></div>
    <div class="stat"><div class="label">Fraud unacked</div><div class="value">${ops.platform.unackedFraudAlerts}</div></div>
    <div class="stat"><div class="label">API 5xx (24h)</div><div class="value">${ops.platform.apiErrors24h}</div></div>
    <div class="stat"><div class="label">Calls today</div><div class="value">${ops.support.calls.today}</div></div>
  `;
  $('ops-checklist').innerHTML = `<ul style="line-height:1.8;color:var(--muted)">
    <li>Customer service: <strong style="color:var(--text)">${ops.contact.phone}</strong> · ${ops.contact.hours}</li>
    <li>Email: ${ops.contact.email}</li>
    <li>API health: ${health?.ok ? '✓ ok' : health ? '⚠ check' : '—'} · DB ${health?.db ?? '?'}</li>
    <li>Pending rails: ${health?.pendingRails ?? '—'}</li>
    <li>Sentry: ${ops.platform.sentryConfigured ? '✓ configured' : '✗ set SENTRY_DSN on Vercel'}</li>
    <li>${ops.platform.uptimeMonitorHint}</li>
    <li>Open support tickets: ${ops.support.tickets.open + ops.support.tickets.pending}</li>
  </ul>`;
}

async function loadAuditTab() {
  const res = await api('/audit-logs');
  $('audit-table').innerHTML = tableHtml(
    ['When', 'Admin', 'Action', 'Target'],
    res.logs,
    (r) => `<tr>
      <td>${fmtDate(r.createdAt)}</td>
      <td>${r.admin?.email ?? '—'}</td>
      <td>${r.action}</td>
      <td>${r.targetType ?? ''} ${r.targetId ?? ''}</td>
    </tr>`,
  );
}

/* ── J9 Work & Opportunity ───────────────────────────────────────────────── */
// Everything below renders user-entered text: always escaped.
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function bindWork(rootId, attr, fn) {
  $(rootId).querySelectorAll(`[${attr}]`).forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await fn(btn.getAttribute(attr), btn);
        await loadWorkTab();
      } catch (error) {
        alert(error.message);
      }
    });
  });
}

async function loadWorkTab() {
  const [review, disputes, feedback, approvals] = await Promise.all([
    api('/work/review').catch(() => ({ opportunities: [], qualifications: [] })),
    api('/work/disputes?status=open').catch(() => []),
    api('/work/feedback').catch(() => []),
    api('/approvals').catch(() => ({ items: [] })),
  ]);
  $('work-review-opps').innerHTML = tableHtml(['Posting', 'Flags', 'Created', 'Decision'], review.opportunities ?? [], (o) => `<tr>
    <td><strong>${esc(o.title)}</strong><br><small>${esc(o.description).slice(0, 240)}</small></td>
    <td>${(o.flags ?? []).map(esc).join(', ')}</td>
    <td>${fmtDate(o.createdAt)}</td>
    <td><button type="button" class="link-btn" data-work-opp-approve="${esc(o.id)}">Approve</button>
        <button type="button" class="link-btn danger" data-work-opp-reject="${esc(o.id)}">Reject</button></td></tr>`);
  $('work-review-quals').innerHTML = tableHtml(['Qualification', 'Evidence', 'Decision'], review.qualifications ?? [], (q) => `<tr>
    <td>${esc(q.kind)} · <strong>${esc(q.title)}</strong><br><small>${esc(q.issuer)}</small></td>
    <td><small>${esc(q.evidenceRef)}</small></td>
    <td><button type="button" class="link-btn" data-work-qual-verify="${esc(q.id)}">Verified</button>
        <button type="button" class="link-btn danger" data-work-qual-reject="${esc(q.id)}">Reject</button></td></tr>`);
  $('work-disputes').innerHTML = tableHtml(['Dispute', 'At stake', 'Evidence (roles only)', 'Ruling'], Array.isArray(disputes) ? disputes : [], (d) => `<tr>
    <td>${esc(d.kind)} · opened by ${esc(d.openedByRole)}<br><small>${esc(d.assignment?.reference)} · ${esc(d.assignment?.arrangement)} · ${fmtDate(d.createdAt)}</small></td>
    <td>${d.milestone ? `${esc(d.milestone.amountKori)} ₭ (${esc(d.milestone.status)})` : 'no money (finding only)'}</td>
    <td>${(d.evidence ?? []).map((e) => `<div><small><b>${esc(e.role)}</b>: ${esc(e.content)}</small></div>`).join('')}</td>
    <td><button type="button" class="link-btn" data-work-rule="${esc(d.id)}">Rule…</button></td></tr>`);
  const pending = (approvals.items ?? approvals.approvals ?? []).filter((a) => a.action === 'work_dispute_settle' && a.status === 'requested');
  $('work-settlements').innerHTML = tableHtml(['Approval', 'Requested', 'Execute'], pending, (a) => `<tr>
    <td>${esc(a.caseRef)}<br><small>${esc(a.reason)}</small></td><td>${fmtDate(a.createdAt)}</td>
    <td><button type="button" class="link-btn" data-work-settle="${esc(a.id)}">Approve &amp; execute</button></td></tr>`);
  $('work-feedback').innerHTML = tableHtml(['Feedback', 'Contest', 'Ruling'], Array.isArray(feedback) ? feedback : [], (f) => `<tr>
    <td>${esc(f.rating)}/5 from ${esc(f.fromRole)}<br><small>${esc(f.comment)}</small></td>
    <td><small>${esc(f.contestNote)}</small></td>
    <td><button type="button" class="link-btn" data-work-fb-uphold="${esc(f.id)}">Uphold</button>
        <button type="button" class="link-btn danger" data-work-fb-remove="${esc(f.id)}">Remove</button></td></tr>`);

  const note = (q) => {
    const n = prompt(q);
    if (!n) throw new Error('A reason is required');
    return n;
  };
  bindWork('work-review-opps', 'data-work-opp-approve', (id) => api(`/work/opportunities/${encodeURIComponent(id)}/review`, { method: 'POST', body: { decision: 'approve', note: note('Reason for approving?') } }));
  bindWork('work-review-opps', 'data-work-opp-reject', (id) => api(`/work/opportunities/${encodeURIComponent(id)}/review`, { method: 'POST', body: { decision: 'reject', note: note('Reason for rejecting?') } }));
  bindWork('work-review-quals', 'data-work-qual-verify', (id) => api(`/work/qualifications/${encodeURIComponent(id)}/review`, { method: 'POST', body: { decision: 'verified', note: prompt('Note (optional)') || undefined } }));
  bindWork('work-review-quals', 'data-work-qual-reject', (id) => api(`/work/qualifications/${encodeURIComponent(id)}/review`, { method: 'POST', body: { decision: 'rejected', note: prompt('Note (optional)') || undefined } }));
  bindWork('work-disputes', 'data-work-rule', async (id) => {
    const outcome = prompt('Outcome: worker | business | split | finding_only');
    if (!outcome) return;
    const body = { outcome: outcome.trim(), note: note('Reason (10+ characters, recorded in the audit trail)') };
    if (body.outcome === 'split') body.splitWorkerKori = Number(prompt('Worker share in ₭ (integer)'));
    const r = await api(`/work/disputes/${encodeURIComponent(id)}/resolve`, { method: 'POST', body });
    alert(r.approval ? 'Ruling recorded — a second (finance) operator must execute the settlement.' : 'Ruling recorded.');
  });
  bindWork('work-settlements', 'data-work-settle', (id) => api(`/approvals/${encodeURIComponent(id)}/approve`, { method: 'POST', body: {} }));
  bindWork('work-feedback', 'data-work-fb-uphold', (id) => api(`/work/feedback/${encodeURIComponent(id)}/rule`, { method: 'POST', body: { decision: 'upheld', note: note('Reason (10+ characters)') } }));
  bindWork('work-feedback', 'data-work-fb-remove', (id) => api(`/work/feedback/${encodeURIComponent(id)}/rule`, { method: 'POST', body: { decision: 'removed', note: note('Reason (10+ characters)') } }));
}

async function loadCommunityTab() {
  const [q, ap] = await Promise.all([
    api('/moderation/reports').catch(() => ({ reports: [] })),
    api('/moderation/appeals').catch(() => ({ appeals: [] })),
  ]);
  $('community-reports').innerHTML = tableHtml(['Report', 'Evidence (snapshot)', 'Context', 'Decision'], q.reports ?? [], (r) => `<tr>
    <td>${esc(r.category)}<br><small>${esc(r.reason)} · ${fmtDate(r.createdAt)}</small></td>
    <td><small>${r.evidence ? esc(r.evidence.body) : '—'}</small></td>
    <td><small>${esc(r.reportsAgainstTarget30d)} report(s) in 30 d · ${esc(r.priorActions)} prior action(s)</small></td>
    <td><button type="button" class="link-btn" data-mod-decide="${esc(r.id)}">Decide…</button></td></tr>`);
  $('community-appeals').innerHTML = tableHtml(['Action', 'Appeal', 'Decision'], ap.appeals ?? [], (a) => `<tr>
    <td>${esc(a.kind)}${a.until ? ` until ${fmtDate(a.until)}` : ''}<br><small>${esc(a.note)}</small></td>
    <td><small>${esc(a.appealNote)}</small></td>
    <td><button type="button" class="link-btn" data-mod-lift="${esc(a.id)}">Lift</button>
        <button type="button" class="link-btn danger" data-mod-uphold="${esc(a.id)}">Uphold</button></td></tr>`);
  const bind = (container, attr, fn) => document.querySelectorAll(`#${container} [${attr}]`).forEach((btn) => btn.addEventListener('click', async () => {
    try { await fn(btn.getAttribute(attr)); await loadCommunityTab(); } catch (error) { alert(error.message); }
  }));
  const reason = (q2) => { const n = prompt(q2); if (!n) throw new Error('A reason is required'); return n; };
  bind('community-reports', 'data-mod-decide', async (id) => {
    const outcome = prompt('Outcome: no_violation | warn | restrict_messaging');
    if (!outcome) return;
    const body = { outcome: outcome.trim(), note: reason('Reason (10+ characters, recorded in the audit trail)') };
    if (body.outcome === 'restrict_messaging') body.days = Number(prompt('Days (1–30)'));
    await api(`/moderation/reports/${encodeURIComponent(id)}/resolve`, { method: 'POST', body });
  });
  bind('community-appeals', 'data-mod-lift', (id) => api(`/moderation/actions/${encodeURIComponent(id)}/appeal/resolve`, { method: 'POST', body: { outcome: 'lifted', note: reason('Reason (10+ characters)') } }));
  bind('community-appeals', 'data-mod-uphold', (id) => api(`/moderation/actions/${encodeURIComponent(id)}/appeal/resolve`, { method: 'POST', body: { outcome: 'upheld', note: reason('Reason (10+ characters)') } }));
}

async function loadCollectiveTab() {
  const [d, g, ap] = await Promise.all([
    api('/collective/disputes').catch(() => ({ disputes: [] })),
    api('/collective/groups').catch(() => ({ groups: [] })),
    api('/approvals').catch(() => ({ approvals: [] })),
  ]);
  const MONEY = ['collective_dispute_settle', 'collective_termination_settle', 'protected_release', 'protected_cancel'];
  const pending = (ap.approvals ?? []).filter((a) => MONEY.includes(a.action) && a.status === 'requested');
  $('collective-disputes').innerHTML = tableHtml(['Dispute', 'Group / cycle', 'Ruling'], d.disputes ?? [], (x) => `<tr>
    <td><small>${esc(x.reason)} · ${fmtDate(x.createdAt)}</small></td>
    <td><small>${esc(x.groupId)} · cycle ${esc(x.cycle)}</small></td>
    <td><button type="button" class="link-btn" data-col-rule="${esc(x.id)}">Rule…</button></td></tr>`);
  $('collective-approvals').innerHTML = tableHtml(['Action', 'Case', 'Requested', 'Execute'], pending, (a) => `<tr>
    <td>${esc(a.action)}</td><td><small>${esc(a.caseRef ?? '')} · ${esc(a.reason ?? '')}</small></td><td><small>${fmtDate(a.createdAt)}</small></td>
    <td><button type="button" class="link-btn" data-col-approve="${esc(a.id)}">Approve &amp; execute</button></td></tr>`);
  $('collective-groups').innerHTML = tableHtml(['Group', 'Kind / status', 'Cycle', 'Members', 'Freeze'], g.groups ?? [], (x) => `<tr>
    <td><small>${esc(x.id)}</small></td><td>${esc(x.kind)} · ${esc(x.status)}${x.frozen ? ' · <b>FROZEN</b>' : ''}</td>
    <td>${esc(x.currentCycle)} / ${esc(x.cycleCount ?? '—')}</td><td>${esc(x.members)}</td>
    <td>${x.frozen ? `<button type="button" class="link-btn" data-col-unfreeze="${esc(x.id)}">Unfreeze</button>` : `<button type="button" class="link-btn danger" data-col-freeze="${esc(x.id)}">Freeze</button>`}${x.status === 'settlement_pending' ? ` <button type="button" class="link-btn" data-col-settle="${esc(x.id)}">Request settlement…</button>` : ''}</td></tr>`);
  const bind = (container, attr, fn) => document.querySelectorAll(`#${container} [${attr}]`).forEach((btn) => btn.addEventListener('click', async () => {
    try { await fn(btn.getAttribute(attr)); await loadCollectiveTab(); } catch (error) { alert(error.message); }
  }));
  const reason = (q2) => { const n = prompt(q2); if (!n) throw new Error('A reason is required'); return n; };
  bind('collective-disputes', 'data-col-rule', async (id) => {
    const outcome = prompt('Ruling: continue | release_collected | skip_recipient');
    if (!outcome) return;
    await api(`/collective/disputes/${encodeURIComponent(id)}/rule`, { method: 'POST', body: { outcome: outcome.trim(), note: reason('Reason (10+ characters, recorded in the audit trail)') } });
  });
  bind('collective-approvals', 'data-col-approve', (id) => api(`/approvals/${encodeURIComponent(id)}/approve`, { method: 'POST', body: {} }));
  bind('collective-groups', 'data-col-settle', (id) => api(`/collective/groups/${encodeURIComponent(id)}/settle`, { method: 'POST', body: { reason: reason('Settlement reason (10+ characters)') } }));
  bind('collective-groups', 'data-col-freeze', (id) => api(`/collective/groups/${encodeURIComponent(id)}/freeze`, { method: 'POST', body: { reason: reason('Why freeze (10+ characters)') } }));
  bind('collective-groups', 'data-col-unfreeze', (id) => api(`/collective/groups/${encodeURIComponent(id)}/unfreeze`, { method: 'POST', body: { reason: reason('Why unfreeze (10+ characters)') } }));
}

async function loadDashboard() {
  const data = await api('/dashboard');
  renderDashboard(data);
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => show(p, p.id === `tab-${name}`));
  loadTabData(name).catch((err) => alert(err.message));
}

async function loadTabData(name) {
  if (name === 'support') await loadSupportTab();
  if (name === 'users') await loadUsersTab();
  if (name === 'distributors') await loadDistributorsTab();
  if (name === 'ops') await loadOpsTab();
  if (name === 'audit') await loadAuditTab();
  if (name === 'agents') await loadFloatRequestsTab();
  if (name === 'work') await loadWorkTab();
  if (name === 'community') await loadCommunityTab();
  if (name === 'collective') await loadCollectiveTab();
}

async function enterApp() {
  show($('login-view'), false);
  show($('app-view'), true);
  await loadDashboard();
}

async function handleLogin(e) {
  e.preventDefault();
  $('login-error').classList.add('hidden');
  try {
    const result = await api('/auth/login', {
      auth: false,
      method: 'POST',
      body: { email: $('email').value, password: $('password').value },
    });
    challengeToken = result.challengeToken;

    if (result.setupRequired) {
      show($('login-form'), false);
      const setup = await api('/auth/setup-2fa', {
        auth: false,
        method: 'POST',
        body: { challengeToken },
      });
      $('totp-secret').textContent = setup.secret;
      show($('setup-form'), true);
      return;
    }

    show($('login-form'), false);
    show($('totp-form'), true);
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').classList.remove('hidden');
  }
}

async function handleTotp(e) {
  e.preventDefault();
  $('login-error').classList.add('hidden');
  try {
    const result = await api('/auth/verify-2fa', {
      auth: false,
      method: 'POST',
      body: { challengeToken, code: $('totp').value },
    });
    setToken(result.accessToken);
    await enterApp();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').classList.remove('hidden');
  }
}

async function handleSetup(e) {
  e.preventDefault();
  $('login-error').classList.add('hidden');
  try {
    const result = await api('/auth/confirm-2fa', {
      auth: false,
      method: 'POST',
      body: { challengeToken, code: $('setup-code').value },
    });
    setToken(result.accessToken);
    await enterApp();
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').classList.remove('hidden');
  }
}

document.addEventListener('click', async (e) => {
  const tx = e.target.closest('[data-tx]');
  if (tx) {
    const detail = await api(`/transactions/${tx.dataset.tx}`);
    showModal('Transaction', detail);
    return;
  }

  const release = e.target.closest('[data-release]');
  if (release) {
    const note = prompt('Optional note for audit log:') || undefined;
    await api(`/rails/${release.dataset.release}/release`, {
      method: 'POST',
      body: { action: release.dataset.action, note },
    });
    await loadDashboard();
    return;
  }

  const approve = e.target.closest('[data-held-approve]');
  if (approve) {
    await api(`/held-transactions/${approve.dataset.heldApprove}/approve`, { method: 'POST', body: {} });
    await loadDashboard();
    return;
  }

  const reject = e.target.closest('[data-held-reject]');
  if (reject) {
    const reason = prompt('Rejection reason:');
    if (!reason) return;
    await api(`/held-transactions/${reject.dataset.heldReject}/reject`, { method: 'POST', body: { reason } });
    await loadDashboard();
    return;
  }

  const ack = e.target.closest('[data-ack-fraud]');
  if (ack) {
    await api(`/fraud-alerts/${ack.dataset.ackFraud}/ack`, { method: 'POST' });
    await loadDashboard();
    return;
  }

  const ticketBtn = e.target.closest('[data-ticket]');
  if (ticketBtn) {
    const ticket = await api(`/support-tickets/${ticketBtn.dataset.ticket}`);
    const actionsHtml = `
      <button class="btn btn-sm btn-primary" id="modal-resolve">Mark resolved</button>
      <button class="btn btn-sm btn-ghost" id="modal-reply">Reply</button>
    `;
    showModal(`Ticket: ${ticket.subject}`, ticket, actionsHtml);
    $('modal-resolve')?.addEventListener('click', async () => {
      await api(`/support-tickets/${ticket.id}`, { method: 'PATCH', body: { status: 'resolved' } });
      show($('modal'), false);
      await loadDashboard();
      if (document.querySelector('.tab.active')?.dataset.tab === 'support') await loadSupportTab();
    });
    $('modal-reply')?.addEventListener('click', async () => {
      const reply = prompt('Reply to customer:', '');
      if (!reply) return;
      await api(`/support-tickets/${ticket.id}`, { method: 'POST', body: { body: reply } });
      show($('modal'), false);
      await loadDashboard();
    });
    return;
  }

  const kycApprove = e.target.closest('[data-kyc-approve]');
  if (kycApprove) {
    await api(`/kyc/${kycApprove.dataset.kycApprove}/approve`, { method: 'POST', body: {} });
    await loadUsersTab();
    return;
  }

  const kycReject = e.target.closest('[data-kyc-reject]');
  if (kycReject) {
    const reason = prompt('Rejection reason:');
    if (!reason) return;
    await api(`/kyc/${kycReject.dataset.kycReject}/reject`, { method: 'POST', body: { reason } });
    await loadUsersTab();
    return;
  }

  const kycAddr = e.target.closest('[data-kyc-addr]');
  if (kycAddr) {
    await api('/kyc/address/approve', { method: 'POST', body: { userId: kycAddr.dataset.kycAddr } });
    await loadUsersTab();
    return;
  }

  const userDetail = e.target.closest('[data-user-detail]');
  if (userDetail) {
    const detail = await api(`/users/${userDetail.dataset.userDetail}`);
    const html = `
      <div style="line-height:1.7;color:var(--text)">
        <p><strong>${detail.phone}</strong> · @${detail.handle ?? '—'} · ${detail.name ?? ''}</p>
        <p>Tier ${detail.verificationTier} · ${detail.verificationStatus}${detail.frozen ? ' · <span style="color:var(--r)">FROZEN</span>' : ''}</p>
        <p>Balance: ${detail.wallet?.koriBalance ?? 0} ₭</p>
        <p>Businesses: ${(detail.businesses ?? []).map((b) => b.name).join(', ') || '—'}</p>
        <p>Tickets: ${detail.tickets?.length ?? 0} · Fraud alerts: ${detail.fraudAlerts?.length ?? 0}</p>
      </div>
    `;
    const actionsHtml = `
      ${detail.frozen ? `<button class="btn btn-sm btn-primary" id="modal-unfreeze">Unfreeze</button>` : `<button class="btn btn-sm btn-danger" id="modal-freeze-user">Freeze</button>`}
      <button class="btn btn-sm btn-ghost" id="modal-tx-lookup">Find tx</button>
    `;
    $('modal-body').innerHTML = html;
    $('modal-title').textContent = 'User';
    $('modal-actions').innerHTML = actionsHtml;
    show($('modal'), true);
    $('modal-unfreeze')?.addEventListener('click', async () => {
      await api(`/users/${detail.id}/unfreeze`, { method: 'POST', body: {} });
      show($('modal'), false);
      alert('Unfrozen');
    });
    $('modal-freeze-user')?.addEventListener('click', async () => {
      const reason = prompt('Freeze reason:');
      if (!reason) return;
      await api(`/users/${detail.id}/freeze`, { method: 'POST', body: { reason } });
      show($('modal'), false);
      alert('Frozen');
    });
    return;
  }

  const distDetail = e.target.closest('[data-dist-detail]');
  if (distDetail) {
    const detail = await api(`/distributors/${distDetail.dataset.distDetail}`);
    showModal('Distributor', detail);
    return;
  }

  const distPause = e.target.closest('[data-dist-pause]');
  if (distPause) {
    const detail = await api(`/distributors/${distPause.dataset.distPause}`);
    await api(`/distributors/${distPause.dataset.distPause}`, {
      method: 'PATCH',
      body: { pauseOrders: !detail.pauseOrders },
    });
    await loadDistributorsTab();
    return;
  }
});

$('login-form').addEventListener('submit', handleLogin);
$('totp-form').addEventListener('submit', handleTotp);
$('setup-form').addEventListener('submit', handleSetup);
$('logout-btn').addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST', auth: !!token() });
  } catch {
    /* ignore */
  }
  setToken(null);
  location.reload();
});
$('refresh-btn').addEventListener('click', () => loadDashboard().catch(alert));
$('modal-close').addEventListener('click', () => show($('modal'), false));
$('export-report-btn').addEventListener('click', async () => {
  const date = new Date().toISOString().slice(0, 10);
  const res = await fetch(`${API}/reports/daily?date=${date}&format=json&export=1`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `k21-daily-${date}.json`;
  a.click();
});
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});
$('user-search-btn')?.addEventListener('click', () => searchUsers().catch(alert));
$('call-log-btn')?.addEventListener('click', async () => {
  try {
    await api('/support/calls', {
      method: 'POST',
      body: {
        phone: $('call-phone').value.trim(),
        userId: $('call-user-id').value.trim() || undefined,
        durationSec: $('call-duration').value ? parseInt($('call-duration').value, 10) : undefined,
        outcome: $('call-outcome').value.trim() || undefined,
        note: $('call-note').value.trim() || undefined,
      },
    });
    $('call-phone').value = '';
    $('call-note').value = '';
    await loadSupportTab();
    alert('Call logged');
  } catch (err) {
    alert(err.message);
  }
});
$('tx-lookup-btn').addEventListener('click', async () => {
  const id = $('tx-lookup').value.trim();
  if (!id) return;
  const detail = await api(`/transactions/${encodeURIComponent(id)}`);
  showModal('Transaction', detail);
});
$('freeze-btn').addEventListener('click', async () => {
  const id = $('freeze-user-id').value.trim();
  const reason = $('freeze-reason').value.trim();
  if (!id || !reason) return alert('User ID and reason required');
  await api(`/users/${id}/freeze`, { method: 'POST', body: { reason } });
  alert('Account frozen');
});
$('refund-btn').addEventListener('click', async () => {
  const recipientUserId = $('refund-user-id').value.trim();
  const amount = parseInt($('refund-amount').value, 10);
  const reason = $('refund-reason').value.trim();
  if (!recipientUserId || !amount || !reason) return alert('All refund fields required');
  await api('/refunds', { method: 'POST', body: { recipientUserId, amount, reason } });
  alert('Refund issued');
});

$('agent-create-btn')?.addEventListener('click', async () => {
  try {
    const body = {
      userId: $('agent-user-id').value.trim(),
      displayName: $('agent-display-name').value.trim() || undefined,
      locationLabel: $('agent-location').value.trim() || undefined,
      floatLimit: $('agent-float-limit').value ? parseInt($('agent-float-limit').value, 10) : undefined,
      initialFloat: $('agent-initial-float').value ? parseInt($('agent-initial-float').value, 10) : undefined,
    };
    if (!body.userId) return alert('User ID required');
    const result = await api('/agents', { method: 'POST', body });
    alert(`Agent created: ${result.agent.agentCode}`);
    await loadDashboard();
  } catch (error) {
    alert(error.message);
  }
});

$('agent-topup-btn')?.addEventListener('click', async () => {
  try {
    const id = $('agent-topup-id').value.trim();
    const amountXof = parseInt($('agent-topup-amount').value, 10);
    const note = $('agent-topup-note').value.trim() || undefined;
    if (!id || !amountXof) return alert('Agent ID and amount required');
    await api(`/agents/${encodeURIComponent(id)}/float`, { method: 'POST', body: { amountXof, note } });
    alert('Float topped up');
    await loadDashboard();
  } catch (error) {
    alert(error.message);
  }
});

$('float-requests-refresh-btn')?.addEventListener('click', () => loadFloatRequestsTab().catch(alert));

if (token()) {
  enterApp().catch(() => {
    setToken(null);
    show($('login-view'), true);
    show($('app-view'), false);
  });
}
