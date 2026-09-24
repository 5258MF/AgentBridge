(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const t = (key, ...args) => {
    const template = (window.__AB_I18N__ && window.__AB_I18N__[key]) || key;
    return String(template).replace(/[{]([0-9]+)[}]/g, (placeholder, indexText) => {
      const index = Number(indexText);
      return index < args.length ? String(args[index]) : placeholder;
    });
  };
  let lastStatus = null;
  let busy = false;
  let installingCloudflared = false;
  let publicHealthCheckPending = false;
  let publicHealthCheckRequestId = null;
  const canAutoInstallCloudflared = window.__AB_CAN_AUTO_INSTALL_CLOUDFLARED__ === true;
  let domainInputDirty = false;
  let namedTunnelInputDirty = false;
  let trustedBrowserOriginsInputDirty = false;
  let trustedBrowserOriginsSavePending = false;
  let pendingTrustedBrowserOriginsChange = null;
  let languageChanging = false;
  const currentLanguagePreference = $('languageSelect').value;
  let savedTrustedBrowserOriginsText = normalizeTrustedBrowserOriginsText($('trustedBrowserOriginsInput').value);
  let trustedBrowserOriginsRevision = Number.isInteger(window.__AB_TRUSTED_BROWSER_ORIGINS_REVISION__)
    ? window.__AB_TRUSTED_BROWSER_ORIGINS_REVISION__
    : 0;
  let lastRevision = -1;
  let todoExpanded = false;
  let footerCollapsed = false;
  const expandedToolActivities = new Set();
  const sessionScroll = $('sessionSection').querySelector('.agentbridge-session-scroll');
  const timelineEl = $('timeline');

  function setNamedTunnelInputDirty(dirty) {
    if (namedTunnelInputDirty === dirty) return;
    namedTunnelInputDirty = dirty;
    vscode.postMessage({ type: 'namedTunnelDirtyChanged', dirty });
  }

  function normalizeTrustedBrowserOriginsText(value) {
    return value
      .split(String.fromCharCode(10))
      .map((line) => line.trim())
      .filter(Boolean)
      .join(String.fromCharCode(10));
  }

  function setTrustedBrowserOriginsInputDirty(dirty) {
    if (trustedBrowserOriginsInputDirty === dirty) return;
    trustedBrowserOriginsInputDirty = dirty;
    vscode.postMessage({ type: 'trustedBrowserOriginsDirtyChanged', dirty });
    if (!dirty && !trustedBrowserOriginsSavePending) applyPendingTrustedBrowserOriginsChange();
  }

  function trustedBrowserOriginsSnapshot(origins, revision) {
    return {
      origins,
      revision,
      text: normalizeTrustedBrowserOriginsText(origins.join(String.fromCharCode(10))),
    };
  }

  function rememberPendingTrustedBrowserOriginsChange(snapshot) {
    if (!pendingTrustedBrowserOriginsChange || snapshot.revision >= pendingTrustedBrowserOriginsChange.revision) {
      pendingTrustedBrowserOriginsChange = snapshot;
    }
  }

  function applyTrustedBrowserOriginsSnapshot(snapshot, showSavedStatus) {
    trustedBrowserOriginsRevision = snapshot.revision;
    savedTrustedBrowserOriginsText = snapshot.text;
    $('trustedBrowserOriginsInput').value = savedTrustedBrowserOriginsText;
    setTrustedBrowserOriginsInputDirty(false);
    if (showSavedStatus) {
      $('trustedBrowserOriginsStatus').textContent = t('trustedBrowserOriginsSaved');
      $('trustedBrowserOriginsStatus').style.display = 'block';
    } else {
      $('trustedBrowserOriginsStatus').style.display = 'none';
    }
  }

  function applyPendingTrustedBrowserOriginsChange() {
    if (trustedBrowserOriginsInputDirty || trustedBrowserOriginsSavePending || !pendingTrustedBrowserOriginsChange) return;
    const pending = pendingTrustedBrowserOriginsChange;
    pendingTrustedBrowserOriginsChange = null;
    if (pending.revision >= trustedBrowserOriginsRevision) {
      applyTrustedBrowserOriginsSnapshot(pending, false);
    }
  }

  function formatDuration(durationMs) {
    if (durationMs == null) return '';
    if (durationMs < 1000) return (Math.round(durationMs / 100) / 10) + 's';
    const s = Math.round(durationMs / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function formatTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function activityIconChar(activity) {
    if (activity.status === 'error') return '✕';
    if (activity.status === 'running') return '◌';
    switch (activity.presentation && activity.presentation.kind) {
      case 'files': return '🗎';
      case 'search': return '⌕';
      case 'edit': return '✎';
      case 'terminal': return '⌨';
      case 'diagnostics': return '⚠';
      case 'lsp': return 'ƒ';
      default: return '⚙';
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function isNearBottom() {
    return sessionScroll.scrollHeight - sessionScroll.scrollTop - sessionScroll.clientHeight < 72;
  }

  function openResource(item) {
    vscode.postMessage({ type: 'openResource', value: { path: item.path, line: item.line, column: item.column, folder: item.folder } });
  }

  function renderTodos(todos) {
    const region = $('todosRegion');
    region.textContent = '';
    if (!todos || todos.length === 0) return;
    const details = el('details', 'agentbridge-todos');
    details.open = todoExpanded;
    const summary = el('summary', 'agentbridge-todos-summary');
    summary.appendChild(el('span', 'agentbridge-todo-icon', '☑'));
    summary.appendChild(el('strong', null, t('todosTitle')));
    const count = todos.filter((t) => t.status === 'completed').length;
    summary.appendChild(el('span', 'agentbridge-todos-count', count + ' / ' + todos.length));
    details.appendChild(summary);
    const body = el('div', 'agentbridge-todos-body');
    for (const todo of todos) {
      const row = el('div', 'agentbridge-todo ' + todo.status);
      row.appendChild(el('span', 'agentbridge-todo-icon', todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◌' : '○'));
      row.appendChild(el('span', 'agentbridge-todo-title', todo.title));
      if (todo.status === 'in_progress') {
        const progress = el('span', 'agentbridge-todo-progress');
        if (todo.phase) progress.appendChild(el('span', 'phase', todo.phase));
        if (todo.message) progress.appendChild(el('span', 'message', todo.message));
        if (todo.percent != null) progress.appendChild(el('span', 'percent', Math.round(todo.percent) + '%'));
        row.appendChild(progress);
      }
      body.appendChild(row);
    }
    details.appendChild(body);
    region.appendChild(details);
  }

  function renderProgress(activity) {
    const row = el('div', 'agentbridge-progress-row');
    row.appendChild(el('span', 'agentbridge-progress-icon agentbridge-spin', '◌'));
    const body = el('div', 'agentbridge-progress-body');
    const task = el('div', 'agentbridge-progress-task');
    if (activity.todoTitle) task.appendChild(el('span', 'task', activity.todoTitle));
    if (activity.phase) task.appendChild(el('span', 'phase', activity.phase));
    if (activity.message) task.appendChild(el('span', 'message', activity.message));
    body.appendChild(task);
    row.appendChild(body);
    if (activity.percent != null) row.appendChild(el('span', 'agentbridge-progress-percent', Math.round(activity.percent) + '%'));
    return row;
  }

  function renderCodeSection(label, text) {
    const section = el('div', 'agentbridge-tool-section');
    section.appendChild(el('label', 'agentbridge-tool-section-label', label));
    const pre = el('pre', null);
    pre.textContent = text || '';
    section.appendChild(pre);
    return section;
  }

  function renderToolItems(activity, container) {
    const items = activity.presentation.items || [];
    const shown = items.slice(0, 40);
    for (const item of shown) {
      const row = el('div', 'agentbridge-tool-item' + (item.severity ? ' severity-' + item.severity : ''));
      const iconChar = item.kind === 'folder' ? '▸' : item.kind === 'search' ? '⌕' : item.kind === 'diagnostic' ? '⚠' : item.kind === 'symbol' ? 'ƒ' : '🗎';
      row.appendChild(el('span', 'agentbridge-tool-item-icon', iconChar));
      const labels = el('div', 'agentbridge-tool-item-labels');
      labels.appendChild(el('span', 'agentbridge-tool-item-primary', item.label || item.path || ''));
      const secondary = [];
      if (item.line != null) secondary.push((item.line != null ? 'L' + item.line : '') + (item.column != null ? ':' + item.column : ''));
      if (item.description) secondary.push(item.description);
      if (item.additions != null || item.deletions != null) {
        const stats = el('span', null);
        if (item.additions) stats.appendChild(el('span', 'additions', '+' + item.additions));
        if (item.deletions) stats.appendChild(el('span', 'deletions', '-' + item.deletions));
        labels.appendChild(stats);
      }
      if (secondary.length) labels.appendChild(el('span', 'agentbridge-tool-item-secondary', secondary.join(' · ')));
      row.appendChild(labels);
      row.addEventListener('click', () => openResource(item));
      container.appendChild(row);
    }
    if (items.length > 40) container.appendChild(el('div', 'agentbridge-tool-more', '+ ' + (items.length - 40) + ' more'));
  }

  function renderMiniDiff(diffPreview, container) {
    if (!diffPreview) return;
    const mini = el('div', 'agentbridge-mini-diff');
    for (const file of diffPreview) {
      const fileCard = el('div', 'agentbridge-mini-diff-file');
      const header = el('div', 'agentbridge-mini-diff-header');
      const fileButton = el('button', 'agentbridge-mini-diff-file-button');
      fileButton.appendChild(el('span', null, '🗎'));
      fileButton.appendChild(el('span', 'agentbridge-mini-diff-path', file.path || ''));
      fileButton.addEventListener('click', () => openResource({ path: file.path, line: 1 }));
      header.appendChild(fileButton);
      const openButton = el('button', 'agentbridge-mini-diff-open', '⇄');
      openButton.title = t('openFullDiff');
      openButton.addEventListener('click', () => vscode.postMessage({ type: 'openDiff', value: { diff: file.diff, path: file.path } }));
      header.appendChild(openButton);
      fileCard.appendChild(header);
      const code = el('div', 'agentbridge-mini-diff-code');
      const hunks = (file.diff || '').split('\n');
      for (const line of hunks) {
        let cls = 'context';
        let marker = '';
        let text = line;
        if (line.startsWith('+')) { cls = 'add'; marker = '+'; }
        else if (line.startsWith('-')) { cls = 'delete'; marker = '-'; }
        else if (line.startsWith('@@')) { cls = 'context'; marker = '@@'; text = line.slice(2).trim(); }
        const row = el('div', 'agentbridge-mini-diff-line ' + cls);
        row.appendChild(el('span', 'agentbridge-mini-diff-line-number', ''));
        row.appendChild(el('span', 'agentbridge-mini-diff-marker', marker));
        row.appendChild(el('span', 'agentbridge-mini-diff-text', text));
        code.appendChild(row);
      }
      fileCard.appendChild(code);
      mini.appendChild(fileCard);
    }
    container.appendChild(mini);
  }

  function renderEditSummaryItems(activity, summary) {
    const items = activity.presentation.items || [];
    const files = items.filter((i) => i.kind === 'file');
    const shown = files.slice(0, 8);
    const wrap = el('div', 'agentbridge-edit-summary-files');
    for (const file of shown) {
      const button = el('button', 'agentbridge-edit-summary-file');
      button.appendChild(el('span', 'agentbridge-edit-summary-file-icon', '🗎'));
      button.appendChild(el('span', 'agentbridge-edit-summary-file-path', file.path || file.label || ''));
      if (file.additions != null || file.deletions != null) {
        const stats = el('span', 'agentbridge-edit-summary-file-stats');
        if (file.additions) stats.appendChild(el('span', 'additions', '+' + file.additions));
        if (file.deletions) stats.appendChild(el('span', 'deletions', '-' + file.deletions));
        button.appendChild(stats);
      }
      button.addEventListener('click', () => openResource(file));
      wrap.appendChild(button);
    }
    if (files.length > 8) wrap.appendChild(el('div', 'agentbridge-edit-summary-more', '+ ' + (files.length - 8) + ' more'));
    summary.appendChild(wrap);
  }

  function sessionShortId(sid) {
    return (sid || '').slice(0, 8).toUpperCase();
  }
  function sessionHue(sid) {
    if (!sid) return 220;
    let h = 0;
    for (let i = 0; i < Math.min(sid.length, 8); i++) h = (h * 31 + sid.charCodeAt(i)) % 360;
    return h;
  }
  function sessionBadge(sid) {
    if (!sid) return null;
    const span = el('span', 'agentbridge-session-badge');
    span.textContent = '#' + sessionShortId(sid);
    const hue = sessionHue(sid);
    span.style.color = 'hsl(' + hue + ', 70%, 45%)';
    span.style.borderColor = 'hsl(' + hue + ', 70%, 65%)';
    span.title = 'MCP session · ' + sid;
    return span;
  }

  function sessionState(session) {
    if (Number(session && session.activeRequests) > 0) return 'processing';
    if (Number(session && session.activeStreams) > 0) return 'connected';
    return 'idle';
  }

  function renderSessionList(sessions) {
    const list = $('sessionList');
    list.textContent = '';
    if (!sessions || sessions.length === 0) {
      list.style.display = 'none';
      return;
    }
    list.style.display = '';
    const counts = { processing: 0, connected: 0, idle: 0 };
    for (const session of sessions) counts[sessionState(session)] += 1;
    const header = el('div', 'agentbridge-session-list-header');
    const headerRow = el('div', 'agentbridge-session-list-header-row');
    const heading = el('div', 'agentbridge-session-list-heading');
    heading.appendChild(el('span', 'agentbridge-session-list-title', t('activeSessions', sessions.length)));
    heading.appendChild(el('span', 'agentbridge-session-list-summary', t('sessionStateSummary', counts.processing, counts.connected, counts.idle)));
    headerRow.appendChild(heading);
    const clearIdleButton = el('button', 'secondary agentbridge-session-list-clear', t('clearIdleSessions'));
    clearIdleButton.disabled = counts.idle === 0;
    clearIdleButton.addEventListener('click', () => {
      if (counts.idle === 0) return;
      vscode.postMessage({ type: 'clearIdleSessions' });
    });
    headerRow.appendChild(clearIdleButton);
    header.appendChild(headerRow);
    list.appendChild(header);
    for (const session of sessions) {
      const row = el('div', 'agentbridge-session-list-row');
      const badge = sessionBadge(session.sessionId);
      if (badge) row.appendChild(badge);
      const info = el('span', 'agentbridge-session-list-info');
      const state = sessionState(session);
      const parts = [state === 'processing' ? t('sessionProcessing') : state === 'connected' ? t('sessionKeepingConnection') : t('sessionIdle')];
      if (state === 'processing') parts.push(t('activeRequestsOf', session.activeRequests));
      if (state === 'connected') parts.push(t('activeStreamsOf', session.activeStreams));
      parts.push(t('lastActivityAt', formatTime(session.lastActivity)));
      info.textContent = parts.join(' · ');
      row.appendChild(info);
      const btn = el('button', 'secondary agentbridge-session-list-disconnect', t('disconnect'));
      btn.addEventListener('click', () => vscode.postMessage({ type: 'disconnectSession', sessionId: session.sessionId }));
      row.appendChild(btn);
      list.appendChild(row);
    }
  }

  function renderToolCard(activity) {
    const details = el('details', 'agentbridge-tool-card state-' + activity.status + ' kind-' + (activity.presentation && activity.presentation.kind || 'generic'));
    const isOpen = expandedToolActivities.has(activity.id);
    details.open = isOpen;
    const summary = el('summary', 'agentbridge-tool-summary');
    const icon = el('span', 'agentbridge-tool-icon' + (activity.status === 'running' ? ' agentbridge-spin' : ''));
    icon.textContent = activityIconChar(activity);
    summary.appendChild(icon);
    const labels = el('div', 'agentbridge-tool-labels');
    labels.appendChild(el('span', 'agentbridge-tool-title', activity.tool));
    const badge = sessionBadge(activity.sessionId);
    if (badge) labels.appendChild(badge);
    if (activity.presentation && activity.presentation.subtitle) {
      labels.appendChild(el('span', 'agentbridge-tool-subtitle', activity.presentation.subtitle));
    }
    summary.appendChild(labels);
    const meta = activity.status === 'running' ? t('running') : activity.status === 'error' ? t('failed') : formatDuration(activity.durationMs);
    const metaEl = el('span', 'agentbridge-tool-meta', meta);
    if (activity.status === 'running' && activity.at) {
      metaEl.dataset.liveId = String(activity.id);
      metaEl.dataset.startedAt = String(new Date(activity.at).getTime());
    }
    summary.appendChild(metaEl);
    if (activity.presentation && activity.presentation.kind === 'edit' && activity.presentation.items && activity.presentation.items.length) {
      renderEditSummaryItems(activity, summary);
    }
    details.appendChild(summary);
    const body = el('div', 'agentbridge-tool-body');
    const pres = activity.presentation || {};
    if (pres.kind !== 'edit' && pres.items && pres.items.length) renderToolItems(activity, body);
    if (pres.kind === 'edit' && pres.diffPreview) renderMiniDiff(pres.diffPreview, body);
    if (pres.terminalId) {
      const actions = el('div', 'agentbridge-tool-actions');
      const button = el('button', 'agentbridge-tool-action', t('openTerminal'));
      button.addEventListener('click', () => vscode.postMessage({ type: 'openTerminal', terminalId: pres.terminalId }));
      actions.appendChild(button);
      body.appendChild(actions);
    }
    const showRawInput = pres.kind === 'generic' || activity.tool === 'send_command_input';
    if (showRawInput && pres.input != null) body.appendChild(renderCodeSection(t('inputLabel'), pres.input));
    if (pres.output != null) body.appendChild(renderCodeSection(t('outputLabel'), pres.output));
    if (activity.status === 'error' && activity.message && activity.message !== pres.output) {
      body.appendChild(el('div', 'agentbridge-tool-error', activity.message));
    }
    details.appendChild(body);
    details.addEventListener('toggle', () => {
      if (details.open) expandedToolActivities.add(activity.id);
      else expandedToolActivities.delete(activity.id);
    });
    return details;
  }

  function renderTimeline(activities) {
    timelineEl.textContent = '';
    $('clearHistoryButton').disabled = !(activities || []).some((activity) => activity.status !== 'running');
    const liveActivityIds = new Set((activities || []).map((activity) => activity.id));
    for (const activityId of expandedToolActivities) {
      if (!liveActivityIds.has(activityId)) expandedToolActivities.delete(activityId);
    }
    if (!activities || activities.length === 0) {
      const empty = el('div', 'agentbridge-session-empty');
      empty.appendChild(el('div', 'agentbridge-session-empty-icon', '◌'));
      empty.appendChild(el('strong', null, t('noRemoteActivity')));
      empty.appendChild(el('span', null, t('noRemoteActivityHint')));
      timelineEl.appendChild(empty);
      return;
    }
    for (const activity of activities) {
      if (activity.status === 'progress') timelineEl.appendChild(renderProgress(activity));
      else timelineEl.appendChild(renderToolCard(activity));
    }
  }

  function updateSessionStartStopControl(status) {
    const statusLoaded = status !== null;
    const state = status && status.state ? status.state : 'stopped';
    const cloudflaredInstallInProgress = installingCloudflared || (status && status.cloudflaredInstalling === true);
    const tunnelCheckInProgress = status && status.tunnelChecking === true;
    const isCloudflare = status && (status.tunnelProvider === 'cloudflare' || status.tunnelProvider === 'cloudflare-named');
    const cloudflareStartBlocked = state !== 'running' && isCloudflare
      && (status.tunnelChecked !== true || status.tunnelInstalled !== true || status.tunnelConfigValid !== true);
    const startStop = $('sessionStartStopButton');
    startStop.disabled = !statusLoaded || busy || cloudflaredInstallInProgress || tunnelCheckInProgress || state === 'starting' || cloudflareStartBlocked;
    startStop.textContent = state === 'running' ? t('stop') : state === 'starting' ? t('starting') : t('connect');
  }

  function publicHealthView(status) {
    const runningOrStarting = status.state === 'running' || status.state === 'starting';
    const allowed = new Set(['inactive', 'checking', 'healthy', 'unstable', 'unhealthy']);
    const state = allowed.has(status.publicHealthState)
      ? status.publicHealthState
      : runningOrStarting ? 'checking' : 'inactive';
    const labels = {
      inactive: t('publicHealthInactive'),
      checking: t('publicHealthChecking'),
      healthy: t('publicHealthHealthy'),
      unstable: t('publicHealthUnstable'),
      unhealthy: t('publicHealthUnhealthy'),
    };
    const details = {
      inactive: t('publicHealthInactiveDetails'),
      checking: t('publicHealthCheckingDetails'),
      healthy: t('publicHealthHealthyDetails'),
      unstable: t('publicHealthUnstableDetails'),
      unhealthy: t('publicHealthUnhealthyDetails'),
    };
    return { state, label: labels[state], details: details[state] };
  }

  function renderPublicHealth(status) {
    const health = publicHealthView(status);
    const meta = [];
    if (status.publicHealthAvailable === true && status.publicHealthAutomatic === false) meta.push(t('publicHealthManualOnly'));
    if (status.publicHealthLastCheckedAt) meta.push(t('publicHealthLastChecked', formatTime(status.publicHealthLastCheckedAt)));
    if (health.state === 'unhealthy' && status.publicHealthLastSuccessAt) meta.push(t('publicHealthLastSuccess', formatTime(status.publicHealthLastSuccessAt)));
    if (Number(status.publicHealthFailureCount) > 0) meta.push(t('publicHealthFailures', status.publicHealthFailureCount));
    const metaText = meta.join(' · ');
    const tooltip = [health.details, metaText, status.publicHealthError].filter(Boolean).join('\n');
    for (const badge of [$('configPublicHealthBadge'), $('sessionPublicHealthBadge')]) {
      badge.className = 'agentbridge-public-health-badge state-' + health.state;
      badge.textContent = health.label;
      badge.title = tooltip;
    }
    $('sessionPublicHealthBadge').style.display = status.state === 'starting' || status.publicHealthAvailable === true ? '' : 'none';
    $('publicHealthDetails').textContent = health.details;
    $('publicHealthDetails').title = status.publicHealthError || health.details;
    $('publicHealthMeta').textContent = metaText;
    $('publicHealthPanel').style.display = status.state === 'starting' || status.publicHealthAvailable === true ? '' : 'none';
    $('checkPublicHealthButton').textContent = status.publicHealthChecking || publicHealthCheckPending ? t('checking') : t('checkPublicHealthNow');
    return { ...health, metaText, tooltip };
  }

  function renderSessionStatus(status) {
    const connected = status.connected;
    const state = status.state;
    const dot = $('connectionDot');
    dot.className = 'agentbridge-session-dot state-' + (connected ? 'connected' : state);
    $('connectionTitle').textContent = 'AgentBridge' + (connected ? ' · ' + t('connected') : '');
    const desc = $('connectionDescription');
    if (footerCollapsed) {
      const parts = [];
      parts.push(connected ? t('connected') : state === 'running' ? t('waitingForConnection') : state);
      if (status.stats && status.stats.toolCalls != null) parts.push(t('calls', status.stats.toolCalls));
      if (status.stats && status.stats.averageDurationMs != null) parts.push(t('average', formatDuration(status.stats.averageDurationMs)));
      if (status.stats && status.stats.successRate != null) parts.push(t('success', Math.round(status.stats.successRate)));
      desc.textContent = parts.join(' · ');
      $('footerDetails').style.display = 'none';
    } else {
      const health = publicHealthView(status);
      desc.textContent = health.state === 'unhealthy' ? t('publicHealthUnhealthyDetails')
        : health.state === 'unstable' ? t('publicHealthUnstableDetails')
        : connected ? t('clientConnected')
        : state === 'running' ? t('waitingClient')
        : state === 'error' ? (status.lastError || t('bridgeFailed'))
        : t('startToMonitor');
      $('footerDetails').style.display = '';
      renderSessionList(status.sessions || []);
      const stats = $('sessionStats');
      stats.textContent = '';
      const statDefs = [
        [t('statToolCalls'), status.stats ? status.stats.toolCalls : null, ''],
        [t('statAverage'), status.stats ? status.stats.averageDurationMs : null, formatDuration],
        [t('statFailed'), status.stats ? status.stats.failedToolCalls : null, ''],
        [t('statSuccess'), status.stats ? status.stats.successRate : null, (v) => v == null ? '' : Math.round(v) + '%'],
      ];
      for (const [label, value, fmt] of statDefs) {
        const stat = el('div', 'agentbridge-session-stat');
        stat.appendChild(el('span', null, label));
        stat.appendChild(el('strong', null, value == null ? '—' : (typeof fmt === 'function' ? fmt(value) : value)));
        stats.appendChild(stat);
      }
      const meta = [];
      if (status.activeRequests) meta.push(t('activeRequests', status.activeRequests));
      if (status.stats && status.stats.lastTool) meta.push(t('recent') + status.stats.lastTool);
      if (status.stats && status.stats.lastToolAt) meta.push(formatTime(status.stats.lastToolAt));
      $('footerMeta').textContent = meta.length ? t('recentActivity') + meta.join(' · ') : '';
      $('footerHint').textContent = connected ? t('monitoring') : state === 'running' ? t('sessionWillUpdate') : t('startToMonitor');
    }
    updateSessionStartStopControl(status);
  }

  function renderSession(status) {
    if (status.revision === lastRevision && status.revision != null) {
      renderSessionStatus(status);
      return;
    }
    lastRevision = status.revision;
    const wasNearBottom = isNearBottom();
    renderTodos(status.todos);
    renderTimeline(status.activities);
    renderSessionStatus(status);
    if (sessionScroll.scrollHeight > sessionScroll.clientHeight && wasNearBottom) {
      sessionScroll.scrollTop = sessionScroll.scrollHeight;
    }
  }

  function renderStateBadge(badge, state) {
    badge.className = 'agentbridge-state state-' + state;
    badge.textContent = state === 'running' ? t('running') : state === 'starting' ? t('starting') : state === 'error' ? t('error') : t('stopped');
  }

  function refreshStatus(status, persistentMode, quickTunnelCopied) {
    lastStatus = status;
    if (namedTunnelInputDirty && status.tunnelProvider !== 'cloudflare-named') {
      setNamedTunnelInputDirty(false);
    }
    // Keep the primary action synchronized before rendering non-critical session/UI details.
    // If any later renderer fails, the visible label and click action must still agree.
    updateControls();
    try {
      renderStatus(status, persistentMode, quickTunnelCopied);
    } catch (error) {
      const detail = error instanceof Error ? (error.stack || error.message) : String(error);
      console.error('[AgentBridge panel] status render failed', error);
      vscode.postMessage({ type: 'panelRenderError', detail });
    } finally {
      updateControls();
    }
  }

  function renderCloudflaredInstallerNotice(status, isCloudflare) {
    const notice = $('cloudflaredInstallerNotice');
    if (!isCloudflare || status.tunnelInstalled === true) {
      notice.style.display = 'none';
      notice.textContent = '';
      return;
    }
    const outcome = status.lastCloudflaredInstallResult && status.lastCloudflaredInstallResult.code;
    let message = outcome === 'permission-denied' ? t('cloudflaredInstallPermissionDeniedNotice')
      : outcome === 'cancelled' ? t('cloudflaredInstallCancelled')
      : outcome === 'command-failed' ? t('cloudflaredInstallCommandFailedNotice')
      : outcome === 'verification-failed' ? t('cloudflaredInstallVerificationFailedNotice')
      : status.tunnelChecking ? t('checkingTunnel')
      : status.cloudflaredInstallerAvailability === 'available'
        ? (status.cloudflaredInstaller === 'winget' ? t('wingetInstallerAvailable') : t('homebrewInstallerAvailable'))
        : status.cloudflaredInstallerAvailability === 'unavailable'
          ? (status.cloudflaredInstaller === 'winget' ? t('wingetInstallerUnavailable') : t('homebrewInstallerUnavailable'))
          : status.cloudflaredInstallerAvailability === 'manual-only'
            ? t('cloudflaredManualInstallerOnly')
            : t('cloudflaredInstallerUnchecked');
    notice.textContent = message;
    notice.style.display = '';
  }

  function renderStatus(status, persistentMode, quickTunnelCopied) {
    const publicHealth = renderPublicHealth(status);
    renderSession(status);
    const isNgrok = status.tunnelProvider === 'ngrok';
    const isNamed = status.tunnelProvider === 'cloudflare-named';
    const isQuick = status.tunnelProvider === 'cloudflare';

    renderStateBadge($('stateBadge'), status.state);
    $('openFolderGroup').style.display = 'none';
    if (status.state === 'running') {
      $('stateDetails').textContent = publicHealth.state === 'unhealthy' ? t('publicHealthUnhealthyDetails')
        : publicHealth.state === 'unstable' ? t('publicHealthUnstableDetails')
        : t('remoteEndpointReady', status.activeRequests);
    } else if (status.state === 'starting') {
      $('stateDetails').textContent = isQuick ? t('generatingQuickUrl') : isNamed ? t('connectingNamedHost') : t('openingSecureEndpoint');
    } else if (status.state === 'error') {
      $('stateDetails').textContent = status.lastError || t('bridgeFailed');
      if (typeof status.lastError === 'string' && status.lastError.includes('workspace folder')) {
        $('openFolderGroup').style.display = '';
      }
    } else {
      $('stateDetails').textContent = isQuick ? t('startForQuickUrl')
        : isNamed ? (status.configuredNamedDomain ? t('namedStoppedNotConnected') : t('configureNamedFirst'))
        : status.configuredDomain ? t('ngrokStoppedNoEndpoint') : t('configureNgrokDomainFirst');
    }

    const providerDomainMissing = isNgrok ? !status.configuredDomain : isNamed ? !status.configuredNamedDomain : false;
    const cloudflareNotChecked = (isQuick || isNamed) && status.tunnelChecked !== true;
    const publicHealthNeedsAttention = status.publicHealthAvailable === true && publicHealth.state === 'unhealthy';
    const configurationNeedsAttention = status.state === 'error' || cloudflareNotChecked || status.tunnelInstalled !== true || status.tunnelConfigValid !== true || providerDomainMissing;
    const connectionNeedsAttention = configurationNeedsAttention || publicHealthNeedsAttention;
    if (configurationNeedsAttention) $('connectionCard').open = true;
    const connectionState = status.state === 'error' || publicHealthNeedsAttention ? 'error'
      : status.state === 'starting' ? 'starting'
        : connectionNeedsAttention ? 'stopped' : 'running';
    const showingPublicHealth = status.publicHealthAvailable === true;
    if (showingPublicHealth) {
      $('connectionBadge').className = 'agentbridge-public-health-badge state-' + publicHealth.state;
      $('connectionBadge').textContent = publicHealth.label;
      $('connectionBadge').title = publicHealth.tooltip;
    } else {
      renderStateBadge($('connectionBadge'), connectionState);
      $('connectionBadge').title = '';
    }
    if (status.state === 'error') {
      $('connectionBadge').textContent = t('needsAttention');
      $('connectionDetails').textContent = t('bridgeConnectionNeedsAttention');
    } else if (status.state === 'starting') {
      $('connectionDetails').textContent = isQuick ? t('generatingQuickUrl') : isNamed ? t('connectingNamedHost') : t('openingSecureEndpoint');
    } else if (publicHealthNeedsAttention) {
      $('connectionDetails').textContent = t('publicHealthUnhealthyDetails');
    } else if (showingPublicHealth && publicHealth.state === 'unstable') {
      $('connectionDetails').textContent = t('publicHealthUnstableDetails');
    } else if (showingPublicHealth && publicHealth.state === 'checking') {
      $('connectionDetails').textContent = t('publicHealthCheckingDetails');
    } else if (status.tunnelChecking) {
      $('connectionBadge').textContent = t('checking');
      $('connectionDetails').textContent = t('checkingTunnel');
    } else if (cloudflareNotChecked) {
      $('connectionBadge').textContent = t('needsAttention');
      $('connectionDetails').textContent = t('cloudflaredInstallerUnchecked');
    } else if (status.tunnelInstalled === undefined) {
      $('connectionBadge').textContent = t('checking');
      $('connectionDetails').textContent = t('notCheckedTunnelClient');
    } else if (!status.tunnelInstalled) {
      $('connectionBadge').textContent = t('needsConfig');
      $('connectionDetails').textContent = isQuick || isNamed ? t('cloudflaredNotInstalled') : t('ngrokNotInstalled');
    } else if (!status.tunnelConfigValid) {
      $('connectionBadge').textContent = t('needsAttention');
      $('connectionDetails').textContent = isNamed ? t('namedConfigNeedsAttention') : t('ngrokConfigNeedsAttention');
    } else if (providerDomainMissing) {
      $('connectionBadge').textContent = t('needsConfig');
      $('connectionDetails').textContent = isNamed ? t('hostnameNotSet') : t('reservedDomainNotSet');
    } else {
      if (!showingPublicHealth) $('connectionBadge').textContent = t('ready');
      $('connectionDetails').textContent = isQuick ? t('quickReady')
        : isNamed ? t('namedReady', status.configuredNamedDomain)
        : t('ngrokReady', status.configuredDomain);
    }
    if (showingPublicHealth && publicHealth.metaText) {
      $('connectionDetails').textContent += ' · ' + publicHealth.metaText;
    }

    if (status.tunnelChecking) {
      $('tunnelState').textContent = t('checkingTunnel');
    } else if (status.tunnelInstalled === undefined || cloudflareNotChecked) {
      $('tunnelState').textContent = t('notCheckedTunnelClient');
    } else if (!status.tunnelInstalled) {
      $('tunnelState').textContent = isQuick || isNamed ? t('cloudflaredNeedsSetup') : t('ngrokNeedsSetup');
    } else if (!status.tunnelConfigValid) {
      $('tunnelState').textContent = isNamed ? t('namedConfigIssues') : t('ngrokConfigIssues');
    } else if (providerDomainMissing) {
      $('tunnelState').textContent = t('ngrokReadyFillDomain');
    } else {
      $('tunnelState').textContent = t('readySuffix', (status.tunnelVersion || (isQuick || isNamed ? 'cloudflared' : 'ngrok')));
    }

    const needsTunnelSetup = cloudflareNotChecked || status.tunnelInstalled === false || status.tunnelConfigValid === false || providerDomainMissing;
    $('tunnelSetupPanel').classList.toggle('needs-attention', needsTunnelSetup);
    $('cloudflareSetup').style.display = isQuick ? '' : 'none';
    $('cloudflareNamedSetup').style.display = isNamed ? '' : 'none';
    $('ngrokSetup').style.display = isNgrok ? '' : 'none';
    $('installCloudflaredButton').style.display = canAutoInstallCloudflared && (isQuick || isNamed) && status.tunnelInstalled === false && status.cloudflaredInstallerAvailability === 'available' ? '' : 'none';
    $('checkButton').textContent = status.tunnelChecking ? t('checking') : t('checkTunnel');
    renderCloudflaredInstallerNotice(status, isQuick || isNamed);
    $('cloudflareSetup').querySelector('summary').textContent = needsTunnelSetup ? t('setupCloudflaredSummary') : t('cloudflaredHelpSummary');
    $('ngrokSetup').querySelector('summary').textContent = needsTunnelSetup ? t('setupNgrokSummary') : t('ngrokHelpSummary');
    $('cloudflareNamedSetup').querySelector('summary').textContent = needsTunnelSetup ? t('setupNamedSummary') : t('namedHelpSummary');

    const showUrl = status.state === 'running' && status.publicUrl;
    $('publicUrlSection').style.display = showUrl ? '' : 'none';
    if (showUrl) {
      $('publicUrlValue').value = status.publicUrl;
      $('publicUrlValue').title = status.publicUrl;
    }
    if (isQuick && status.state === 'running' && status.publicUrl && quickTunnelCopied) {
      $('addressNotice').style.display = '';
      $('addressNotice').textContent = t('quickAddressCopied');
    } else {
      $('addressNotice').style.display = 'none';
    }

    $('toolsContainer').textContent = '';
    for (const tool of status.toolNames) {
      const badge = document.createElement('span');
      badge.className = 'agentbridge-tool' + (tool === 'report_progress' || tool === 'set_todos' ? ' bridge-only' : '');
      badge.textContent = tool;
      if (tool === 'set_todos' || tool === 'report_progress') badge.title = t('bridgeOnlyTool');
      $('toolsContainer').appendChild(badge);
    }

    $('quickProvider').classList.toggle('selected', isQuick);
    $('namedProvider').classList.toggle('selected', isNamed);
    $('ngrokProvider').classList.toggle('selected', isNgrok);
    $('quickProvider').setAttribute('aria-checked', String(isQuick));
    $('namedProvider').setAttribute('aria-checked', String(isNamed));
    $('ngrokProvider').setAttribute('aria-checked', String(isNgrok));
    $('domainField').style.display = isNgrok ? '' : 'none';
    $('namedConfiguration').style.display = isNamed ? '' : 'none';
    if (!domainInputDirty && document.activeElement !== $('domainInput')) {
      $('domainInput').value = status.configuredDomain || '';
    }
    if (!namedTunnelInputDirty) {
      if (document.activeElement !== $('namedDomainInput')) {
        $('namedDomainInput').value = status.configuredNamedDomain || '';
      }
      if (document.activeElement !== $('namedPortInput')) {
        $('namedPortInput').value = String(status.namedTunnelLocalPort || 48271);
      }
    }
    $('namedTokenStatus').textContent = status.namedTunnelTokenConfigured ? t('tokenSaved') : t('tokenNotSaved');
    if (typeof persistentMode === 'boolean') {
      $('persistentModeToggle').setAttribute('aria-checked', String(persistentMode));
      $('persistentModeToggle').title = persistentMode ? t('persistentOnTitle') : t('persistentOffTitle');
    }
    const readOnlyActive = status.readOnlyMode === true;
    renderMode(readOnlyActive);
    // The read-only notice stays until the next toggle. It is only dropped when the mode later
    // changes elsewhere (settings.json), after a status has first confirmed the toggled mode.
    const readOnlyNotice = $('readOnlyNotice');
    if (readOnlyNotice.dataset.mode) {
      if (readOnlyActive === (readOnlyNotice.dataset.mode === 'on')) {
        readOnlyNotice.dataset.confirmed = 'true';
      } else if (readOnlyNotice.dataset.confirmed === 'true') {
        readOnlyNotice.style.display = 'none';
        readOnlyNotice.textContent = '';
        readOnlyNotice.dataset.mode = '';
        readOnlyNotice.dataset.confirmed = '';
      }
    }
    if (typeof status.openInternalBrowser === 'string' && ['auto','all','external'].includes(status.openInternalBrowser)) {
      $('openInternalBrowserAuto').setAttribute('aria-checked', String(status.openInternalBrowser === 'auto'));
      $('openInternalBrowserAll').setAttribute('aria-checked', String(status.openInternalBrowser === 'all'));
      $('openInternalBrowserExternal').setAttribute('aria-checked', String(status.openInternalBrowser === 'external'));
    }
    if (typeof status.tunnelProtocol === 'string' && ['auto','quic','http2'].includes(status.tunnelProtocol)) {
      $('tunnelProtocolAuto').setAttribute('aria-checked', String(status.tunnelProtocol === 'auto'));
      $('tunnelProtocolQuic').setAttribute('aria-checked', String(status.tunnelProtocol === 'quic'));
      $('tunnelProtocolHttp2').setAttribute('aria-checked', String(status.tunnelProtocol === 'http2'));
    }
    $('managedShellCurrentLabel').textContent = status.managedShellPath || t('unknown');
    const managedShellWarnEl = $('managedShellWarning');
    const managedShellWarn = status.managedShellOverrideWarning;
    if (managedShellWarn && typeof managedShellWarn === 'string' && managedShellWarn) {
      managedShellWarnEl.style.display = '';
      managedShellWarnEl.textContent = '⚠ ' + managedShellWarn;
    } else {
      managedShellWarnEl.style.display = 'none';
      managedShellWarnEl.textContent = '';
    }
    updateNamedTunnelOriginPreview();
  }

  function updateNamedTunnelOriginPreview() {
    const port = Number($('namedPortInput').value) || (lastStatus && lastStatus.namedTunnelLocalPort) || 48271;
    $('namedOriginValue').value = 'http://127.0.0.1:' + port;
    $('namedOriginValue').title = $('namedOriginValue').value;
  }

  function renderLocalError(message) {
    $('stateBadge').className = 'agentbridge-state state-error';
    $('stateBadge').textContent = t('error');
    $('stateDetails').textContent = message;
  }

  function updateControls() {
    const statusLoaded = lastStatus !== null;
    const running = lastStatus && lastStatus.state === 'running';
    const starting = lastStatus && lastStatus.state === 'starting';
    const isNgrok = lastStatus && lastStatus.tunnelProvider === 'ngrok';
    const isNamed = lastStatus && lastStatus.tunnelProvider === 'cloudflare-named';
    const isQuick = lastStatus && lastStatus.tunnelProvider === 'cloudflare';
    const cloudflaredInstallInProgress = installingCloudflared || (lastStatus && lastStatus.cloudflaredInstalling === true);
    const tunnelChecking = lastStatus && lastStatus.tunnelChecking === true;
    const tunnelOperationBusy = busy || cloudflaredInstallInProgress || tunnelChecking;
    const cloudflareStartBlocked = !running && (isQuick || isNamed)
      && (lastStatus.tunnelChecked !== true || lastStatus.tunnelInstalled !== true || lastStatus.tunnelConfigValid !== true);

    $('quickProvider').disabled = !statusLoaded || tunnelOperationBusy || running || starting;
    $('namedProvider').disabled = !statusLoaded || tunnelOperationBusy || running || starting;
    $('ngrokProvider').disabled = !statusLoaded || tunnelOperationBusy || running || starting;
    $('domainInput').disabled = !statusLoaded || tunnelOperationBusy || running || starting || !isNgrok;
    $('namedDomainInput').disabled = !statusLoaded || tunnelOperationBusy || running || starting || !isNamed;
    $('namedTokenInput').disabled = !statusLoaded || tunnelOperationBusy || running || starting || !isNamed;
    $('namedPortInput').disabled = !statusLoaded || tunnelOperationBusy || running || starting || !isNamed;
    $('copyOriginButton').disabled = !statusLoaded || !$('namedOriginValue').value;
    $('saveNamedTunnelButton').disabled = !statusLoaded || tunnelOperationBusy || running || starting || !isNamed || !$('namedDomainInput').value.trim() || !Number.isInteger(Number($('namedPortInput').value));
    $('clearNamedTunnelTokenButton').disabled = !statusLoaded || tunnelOperationBusy || running || starting || !isNamed || lastStatus.namedTunnelTokenConfigured !== true;
    $('checkButton').disabled = !statusLoaded || tunnelOperationBusy || running || starting;
    $('checkPublicHealthButton').disabled = !statusLoaded || busy || !running || lastStatus.publicHealthAvailable !== true || publicHealthCheckPending || lastStatus.publicHealthChecking === true;
    $('installCloudflaredButton').disabled = !statusLoaded || tunnelOperationBusy || running || starting || !canAutoInstallCloudflared || !(isQuick || isNamed) || lastStatus.tunnelInstalled !== false || lastStatus.cloudflaredInstallerAvailability !== 'available';
    $('installCloudflaredButton').textContent = cloudflaredInstallInProgress ? t('installing') : t('installCloudflared');
    $('rotateButton').disabled = !statusLoaded || tunnelOperationBusy || running || starting;
    $('startStopButton').disabled = !statusLoaded || tunnelOperationBusy || starting || cloudflareStartBlocked;
    $('startStopButton').textContent = running ? t('stopBridge') : starting ? t('starting') : t('startBridge');
    $('persistentModeToggle').disabled = !statusLoaded || busy || cloudflaredInstallInProgress;
    $('modePlanButton').disabled = !statusLoaded || busy;
    $('modeBuildButton').disabled = !statusLoaded || busy;
    $('managedShellInput').disabled = !statusLoaded || busy;
    $('managedShellSaveButton').disabled = !statusLoaded || busy;
    $('managedShellResetButton').disabled = !statusLoaded || busy;
    $('openInternalBrowserAuto').disabled = !statusLoaded || busy;
    $('openInternalBrowserAll').disabled = !statusLoaded || busy;
    $('openInternalBrowserExternal').disabled = !statusLoaded || busy;
    $('tunnelProtocolAuto').disabled = !statusLoaded || busy;
    $('tunnelProtocolQuic').disabled = !statusLoaded || busy;
    $('tunnelProtocolHttp2').disabled = !statusLoaded || busy;
    $('languageSelect').disabled = !statusLoaded || tunnelOperationBusy || languageChanging;
    $('trustedBrowserOriginsInput').disabled = !statusLoaded || busy;
    $('trustedBrowserOriginsSaveButton').disabled = !statusLoaded || busy;
    updateSessionStartStopControl(lastStatus);
  }

  function selectTunnelProvider(provider) {
    if (!lastStatus || busy || lastStatus.tunnelChecking || lastStatus.cloudflaredInstalling || lastStatus.state === 'running' || lastStatus.state === 'starting' || lastStatus.tunnelProvider === provider) return;
    busy = true;
    domainInputDirty = false;
    updateControls();
    vscode.postMessage({ type: 'setProvider', provider });
  }

  async function persistDomain() {
    if (busy || !lastStatus || lastStatus.tunnelProvider !== 'ngrok' || lastStatus.state === 'running' || lastStatus.state === 'starting') return;
    const domain = $('domainInput').value.trim();
    if (!domain) {
      domainInputDirty = false;
      $('domainInput').value = lastStatus.configuredDomain || '';
      return;
    }
    if (domain === lastStatus.configuredDomain) {
      domainInputDirty = false;
      return;
    }
    busy = true;
    updateControls();
    vscode.postMessage({ type: 'configure', domain });
  }

  async function saveNamedTunnel() {
    if (busy || !lastStatus || lastStatus.state === 'running' || lastStatus.state === 'starting') return;
    const domain = $('namedDomainInput').value.trim();
    const token = $('namedTokenInput').value.trim();
    const localPort = Number($('namedPortInput').value);
    if (!domain) {
      renderLocalError(t('enterHostname'));
      $('namedDomainInput').focus();
      return;
    }
    if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
      renderLocalError(t('enterPortRange'));
      $('namedPortInput').focus();
      return;
    }
    if (!token && lastStatus.namedTunnelTokenConfigured !== true) {
      renderLocalError(t('pasteTokenFirst'));
      $('namedTokenInput').focus();
      return;
    }
    busy = true;
    updateControls();
    vscode.postMessage({
      type: 'configureNamedTunnel',
      domain,
      token: token || undefined,
      localPort,
    });
  }

  function toggleBridge() {
    if (busy || !lastStatus || lastStatus.tunnelChecking || lastStatus.cloudflaredInstalling) return;
    if (lastStatus.state === 'running') {
      busy = true;
      updateControls();
      vscode.postMessage({ type: 'stop' });
      return;
    }
    const provider = lastStatus.tunnelProvider;
    const domain = $('domainInput').value.trim();
    if (provider === 'ngrok' && !domain) {
      $('connectionCard').open = true;
      renderLocalError(t('enterNgrokDomainFirst'));
      $('domainInput').focus();
      return;
    }
    if (provider === 'cloudflare-named' && (!lastStatus.configuredNamedDomain || !lastStatus.namedTunnelTokenConfigured)) {
      $('connectionCard').open = true;
      renderLocalError(t('saveNamedConfigFirst'));
      (lastStatus.configuredNamedDomain ? $('namedTokenInput') : $('namedDomainInput')).focus();
      return;
    }
    if ((provider === 'cloudflare' || provider === 'cloudflare-named') && lastStatus.tunnelChecked !== true) {
      $('connectionCard').open = true;
      renderLocalError(t('checkCloudflareBeforeStart'));
      return;
    }
    if ((provider === 'cloudflare' || provider === 'cloudflare-named') && (lastStatus.tunnelInstalled !== true || lastStatus.tunnelConfigValid !== true)) {
      $('connectionCard').open = true;
      renderLocalError(t('cloudflareCheckNotReady'));
      return;
    }
    busy = true;
    updateControls();
    vscode.postMessage({ type: 'start', domain: provider === 'ngrok' ? domain : undefined });
  }

  function resetBusy() {
    busy = false;
    installingCloudflared = false;
    updateControls();
  }

  $('startStopButton').addEventListener('click', toggleBridge);
  $('openFolderButton').addEventListener('click', () => vscode.postMessage({ type: 'openFolder' }));
  $('copyUrlButton').addEventListener('click', () => {
    if (lastStatus && lastStatus.publicUrl) vscode.postMessage({ type: 'copy', text: lastStatus.publicUrl });
  });
  $('copyOriginButton').addEventListener('click', () => {
    if (!lastStatus) return;
    vscode.postMessage({ type: 'copy', text: $('namedOriginValue').value });
  });
  $('openChatGptButton').addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: 'https://chatgpt.com/' }));
  $('openArenaButton').addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: 'https://arena.ai/agent' }));
  $('openWorkBuddyButton').addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: 'https://www.workbuddy.cn/app' }));
  $('openTraeButton').addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: 'https://work.trae.cn' }));
  $('openQwenButton').addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: 'https://qwenwork.cn/app/chat' }));
  $('moreSitesButton').addEventListener('click', () => {
    const group = $('moreSitesGroup');
    const expanded = group.hasAttribute('hidden');
    group.toggleAttribute('hidden', !expanded);
    $('moreSitesButton').setAttribute('aria-expanded', String(expanded));
    $('moreSitesButton').textContent = expanded ? t('moreSitesOpen') : t('moreSites');
  });
  $('copyPromptButton').addEventListener('click', () => vscode.postMessage({ type: 'copyPrompt' }));
  $('checkButton').addEventListener('click', () => {
    if (!lastStatus || busy || lastStatus.tunnelChecking || lastStatus.cloudflaredInstalling || lastStatus.state === 'running' || lastStatus.state === 'starting') return;
    busy = true;
    updateControls();
    vscode.postMessage({ type: 'checkTunnel' });
  });
  $('checkPublicHealthButton').addEventListener('click', () => {
    if (!lastStatus || busy || lastStatus.state !== 'running' || lastStatus.publicHealthAvailable !== true || publicHealthCheckPending || lastStatus.publicHealthChecking === true) return;
    publicHealthCheckPending = true;
    publicHealthCheckRequestId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    updateControls();
    $('checkPublicHealthButton').textContent = t('checking');
    vscode.postMessage({ type: 'checkPublicHealth', requestId: publicHealthCheckRequestId });
  });
  $('installCloudflaredButton').addEventListener('click', () => {
    if (!lastStatus || busy || lastStatus.tunnelChecking || lastStatus.cloudflaredInstalling === true || lastStatus.cloudflaredInstallerAvailability !== 'available') return;
    busy = true;
    installingCloudflared = true;
    updateControls();
    vscode.postMessage({ type: 'installCloudflared' });
  });
  $('rotateButton').addEventListener('click', () => {
    if (!lastStatus || busy || lastStatus.tunnelChecking) return;
    busy = true;
    updateControls();
    vscode.postMessage({ type: 'rotateEndpoint' });
  });
  $('persistentModeToggle').addEventListener('click', () => {
    if (!lastStatus || busy || lastStatus.cloudflaredInstalling) return;
    const enabled = $('persistentModeToggle').getAttribute('aria-checked') !== 'true';
    $('persistentModeToggle').setAttribute('aria-checked', String(enabled));
    $('persistentModeToggle').title = enabled ? t('persistentOnTitle') : t('persistentOffTitle');
    vscode.postMessage({ type: 'setPersistentMode', enabled });
  });
  /** Plan mode is read-only mode; the active side of the Plan | Build switch shows the current mode. */
  function renderMode(readOnly) {
    $('modePlanButton').setAttribute('aria-checked', String(readOnly));
    $('modeBuildButton').setAttribute('aria-checked', String(!readOnly));
  }
  function requestReadOnlyMode(enabled) {
    if (!lastStatus || busy) return;
    if (($('modePlanButton').getAttribute('aria-checked') === 'true') === enabled) return; // already in that mode
    renderMode(enabled);
    // Shown in the hero card under the status line, near the header switch; addressNotice is
    // reset on every status render, so it cannot carry this message.
    const notice = $('readOnlyNotice');
    // The tool list is the same in both modes, so the notice does not depend on the tunnel type.
    notice.textContent = enabled ? t('readOnlyEnabledNotice') : t('readOnlyDisabledNotice');
    notice.dataset.mode = enabled ? 'on' : 'off';
    notice.dataset.confirmed = '';
    notice.style.display = '';
    vscode.postMessage({ type: 'setReadOnlyMode', enabled });
  }
  $('modePlanButton').addEventListener('click', () => requestReadOnlyMode(true));
  $('modeBuildButton').addEventListener('click', () => requestReadOnlyMode(false));
  $('managedShellSaveButton').addEventListener('click', () => {
    if (!lastStatus || busy) return;
    const raw = $('managedShellInput').value.trim();
    $('managedShellInput').value = '';
    vscode.postMessage({ type: 'configureManagedShell', path: raw });
  });
  $('managedShellInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('managedShellSaveButton').click();
    }
  });
  $('managedShellResetButton').addEventListener('click', () => {
    if (!lastStatus || busy) return;
    $('managedShellInput').value = '';
    vscode.postMessage({ type: 'resetManagedShell' });
  });
  const setOib = (v) => {
    if (!lastStatus || busy) return;
    vscode.postMessage({ type: 'setOpenInternalBrowser', value: v });
  };
  $('openInternalBrowserAuto').addEventListener('click', () => setOib('auto'));
  $('openInternalBrowserAll').addEventListener('click', () => setOib('all'));
  $('openInternalBrowserExternal').addEventListener('click', () => setOib('external'));
  const setTunnelProtocol = (v) => {
    if (!lastStatus || busy) return;
    vscode.postMessage({ type: 'setTunnelProtocol', value: v });
  };
  $('tunnelProtocolAuto').addEventListener('click', () => setTunnelProtocol('auto'));
  $('tunnelProtocolQuic').addEventListener('click', () => setTunnelProtocol('quic'));
  $('tunnelProtocolHttp2').addEventListener('click', () => setTunnelProtocol('http2'));
  $('languageSelect').addEventListener('change', () => {
    const select = $('languageSelect');
    const nextLanguage = select.value;
    if (namedTunnelInputDirty) {
      select.value = currentLanguagePreference;
      window.alert(t('saveNamedTunnelBeforeLanguageChange'));
      return;
    }
    if (trustedBrowserOriginsInputDirty) {
      select.value = currentLanguagePreference;
      window.alert(t('saveTrustedBrowserOriginsBeforeLanguageChange'));
      return;
    }
    if (select.disabled || busy || installingCloudflared || (lastStatus && lastStatus.tunnelChecking === true)) {
      select.value = currentLanguagePreference;
      return;
    }
    languageChanging = true;
    updateControls();
    vscode.postMessage({ type: 'setLanguage', value: nextLanguage, advancedOpen: $('advancedCard').open });
  });
  $('trustedBrowserOriginsSaveButton').addEventListener('click', () => {
    if (busy) return;
    const origins = $('trustedBrowserOriginsInput').value
      .split(String.fromCharCode(10))
      .map((value) => value.trim())
      .filter(Boolean);
    $('trustedBrowserOriginsStatus').style.display = 'none';
    trustedBrowserOriginsSavePending = true;
    busy = true;
    updateControls();
    vscode.postMessage({ type: 'setTrustedBrowserOrigins', origins });
  });
  $('trustedBrowserOriginsInput').addEventListener('input', () => {
    $('trustedBrowserOriginsStatus').style.display = 'none';
    setTrustedBrowserOriginsInputDirty(
      normalizeTrustedBrowserOriginsText($('trustedBrowserOriginsInput').value) !== savedTrustedBrowserOriginsText,
    );
  });
  $('quickProvider').addEventListener('click', () => selectTunnelProvider('cloudflare'));
  $('namedProvider').addEventListener('click', () => selectTunnelProvider('cloudflare-named'));
  $('ngrokProvider').addEventListener('click', () => selectTunnelProvider('ngrok'));
  $('domainInput').addEventListener('input', () => { domainInputDirty = true; });
  $('domainInput').addEventListener('blur', () => persistDomain());
  $('domainInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      persistDomain();
      $('domainInput').blur();
    }
  });
  for (const input of [$('namedDomainInput'), $('namedTokenInput'), $('namedPortInput')]) {
    input.addEventListener('input', () => {
      setNamedTunnelInputDirty(true);
      updateNamedTunnelOriginPreview();
      updateControls();
    });
  }
  $('saveNamedTunnelButton').addEventListener('click', saveNamedTunnel);
  $('clearNamedTunnelTokenButton').addEventListener('click', () => {
    if (busy || !lastStatus || !lastStatus.namedTunnelTokenConfigured) return;
    if (window.confirm(t('confirmClearToken'))) {
      busy = true;
      updateControls();
      vscode.postMessage({ type: 'clearNamedTunnelToken' });
    }
  });
  document.querySelectorAll('.agentbridge-command-row button[data-copy]').forEach((button) => {
    button.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: button.getAttribute('data-copy') }));
  });
  document.querySelectorAll('button[data-open]').forEach((button) => {
    button.addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: button.getAttribute('data-open') }));
  });

  function switchTab(tab) {
    const isSession = tab === 'session';
    $('tabConfig').classList.toggle('active', !isSession);
    $('tabSession').classList.toggle('active', isSession);
    $('tabConfig').setAttribute('aria-selected', String(!isSession));
    $('tabSession').setAttribute('aria-selected', String(isSession));
    $('tabConfig').tabIndex = isSession ? -1 : 0;
    $('tabSession').tabIndex = isSession ? 0 : -1;
    $('configSection').style.display = isSession ? 'none' : '';
    $('sessionSection').style.display = isSession ? '' : 'none';
    const target = isSession ? $('tabSession') : $('tabConfig');
    target.focus();
  }
  $('tabConfig').addEventListener('click', () => switchTab('config'));
  $('tabSession').addEventListener('click', () => switchTab('session'));
  const tabs = [$('tabConfig'), $('tabSession')];
  document.addEventListener('keydown', (event) => {
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (event.key === 'ArrowRight' || event.key === 'End') {
      event.preventDefault();
      switchTab('session');
    } else if (event.key === 'ArrowLeft' || event.key === 'Home') {
      event.preventDefault();
      switchTab('config');
    }
  });
  $('sessionStartStopButton').addEventListener('click', () => {
    toggleBridge();
  });
  $('clearHistoryButton').addEventListener('click', () => {
    if (!lastStatus || !Array.isArray(lastStatus.activities) || !lastStatus.activities.some((activity) => activity.status !== 'running')) return;
    $('clearHistoryButton').disabled = true;
    vscode.postMessage({ type: 'clearActivityHistory' });
  });
  $('sessionCollapseButton').addEventListener('click', () => {
    footerCollapsed = !footerCollapsed;
    $('sessionSection').classList.toggle('footer-collapsed', footerCollapsed);
    $('sessionCollapseButton').textContent = footerCollapsed ? '▴' : '▾';
    if (lastStatus) renderSessionStatus(lastStatus);
  });
  $('todosRegion').addEventListener('toggle', (event) => {
    if (event.target && event.target.tagName === 'DETAILS' && event.target.classList.contains('agentbridge-todos')) {
      todoExpanded = event.target.open;
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'status' && message.status) {
      refreshStatus(message.status, message.persistentMode, message.quickTunnelCopied === true);
    } else if (message && message.type === 'idleSessionsCleared' && message.status) {
      refreshStatus(message.status, message.persistentMode, message.quickTunnelCopied === true);
    } else if (message && message.type === 'activityHistoryCleared' && message.status) {
      refreshStatus(message.status, message.persistentMode, message.quickTunnelCopied === true);
    } else if (message && message.type === 'publicHealthChecked' && message.status) {
      if (message.requestId !== publicHealthCheckRequestId) return;
      publicHealthCheckPending = false;
      publicHealthCheckRequestId = null;
      refreshStatus(message.status, message.persistentMode, message.quickTunnelCopied === true);
    } else if (message && message.type === 'trustedBrowserOriginsSaved' && Array.isArray(message.origins)) {
      trustedBrowserOriginsSavePending = false;
      const revision = Number.isInteger(message.revision) ? message.revision : -1;
      const savedSnapshot = trustedBrowserOriginsSnapshot(message.origins, revision);
      const pending = pendingTrustedBrowserOriginsChange;
      pendingTrustedBrowserOriginsChange = null;
      if (pending && pending.revision > savedSnapshot.revision) {
        applyTrustedBrowserOriginsSnapshot(pending, false);
      } else if (savedSnapshot.revision >= trustedBrowserOriginsRevision) {
        applyTrustedBrowserOriginsSnapshot(savedSnapshot, true);
      } else {
        applyPendingTrustedBrowserOriginsChange();
      }
    } else if (message && message.type === 'trustedBrowserOriginsChanged' && Array.isArray(message.origins)) {
      const revision = Number.isInteger(message.revision) ? message.revision : -1;
      if (revision >= trustedBrowserOriginsRevision) {
        const snapshot = trustedBrowserOriginsSnapshot(message.origins, revision);
        if (trustedBrowserOriginsInputDirty || trustedBrowserOriginsSavePending) {
          rememberPendingTrustedBrowserOriginsChange(snapshot);
        } else {
          applyTrustedBrowserOriginsSnapshot(snapshot, false);
        }
      }
    } else if (message && message.type === 'operationFinished') {
      if (message.operation === 'configureNamedTunnel' && message.succeeded === true) {
        setNamedTunnelInputDirty(false);
      }
      if (message.operation === 'setProvider' && message.succeeded === true) {
        setNamedTunnelInputDirty(false);
      }
      if (message.operation === 'setLanguage') {
        languageChanging = false;
        if (message.succeeded !== true) $('languageSelect').value = currentLanguagePreference;
      }
      if (message.operation === 'setTrustedBrowserOrigins') {
        trustedBrowserOriginsSavePending = false;
        if (message.succeeded !== true) {
          setTrustedBrowserOriginsInputDirty(
            normalizeTrustedBrowserOriginsText($('trustedBrowserOriginsInput').value) !== savedTrustedBrowserOriginsText,
          );
        }
        applyPendingTrustedBrowserOriginsChange();
      }
      try {
        if (message.status) refreshStatus(message.status, message.persistentMode, message.quickTunnelCopied === true);
      } finally {
        if (!installingCloudflared) resetBusy();
      }
    } else if (message && message.type === 'cloudflaredInstallFinished') {
      try {
        if (message.status) refreshStatus(message.status, message.persistentMode, false);
      } finally {
        resetBusy();
      }
    }
  });
  setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('.agentbridge-tool-meta[data-live-id]').forEach((el) => {
      const started = Number(el.dataset.startedAt);
      if (Number.isFinite(started)) el.textContent = formatDuration(now - started);
    });
  }, 1000);
  updateControls();
  vscode.postMessage({ type: 'refresh' });
})();
