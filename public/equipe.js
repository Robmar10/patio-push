'use strict';
/* Tela do Recebimento / Expedição: a equipe chama o motorista e indica a doca, marca quando encostou,
   chama o motorista de novo com o caminhão na doca (com o motivo) e libera a saída.
   Pisca e apita quando a portaria lança um caminhão desta equipe e quando o motorista responde. */
(() => {
  const $ = (s) => document.querySelector(s);
  const TKEY = 'pp_team';
  const LABEL = { RECEBIMENTO: 'RECEBIMENTO', EXPEDICAO: 'EXPEDIÇÃO' };
  const KIND = { NOVA_CHEGADA: 'NOVO CAMINHÃO NA FILA', ENTRANDO: 'MOTORISTA A CAMINHO', RESPONDEU: 'MOTORISTA RESPONDEU — ESTÁ INDO', LIBERADO: 'CAMINHÃO LIBERADO' };
  const REASONS = {
    CONCLUIDO: { label: 'Carga/descarga concluída', hint: 'retirar o caminhão' },
    CAMINHAO: { label: 'Comparecer ao caminhão', hint: 'motorista na doca' },
    DOCUMENTOS: { label: 'Nota fiscal / documentos', hint: 'apresentar na doca' },
    MUDAR: { label: 'Mudar de doca', hint: 'escolher a nova doca' },
  };
  const ACTIVE = ['AGUARDANDO', 'CHAMADO', 'CONFIRMADO', 'NA_DOCA'];
  const S = { team: null, visits: new Map(), docks: [], es: null, audio: null, beepT: null, picker: null };
  try { S.team = localStorage.getItem(TKEY); } catch { /* */ }
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TZ = 'America/Sao_Paulo';
  const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '');
  const mins = (a, b) => ((b ? new Date(b) : new Date()) - new Date(a)) / 60000;
  const dur = (m) => (m < 1 ? `${Math.max(0, Math.round(m * 60))} s` : m < 60 ? `${Math.floor(m)} min` : `${Math.floor(m / 60)}h${String(Math.floor(m % 60)).padStart(2, '0')}`);
  const fmtPhone = (p) => (p.length === 11 ? `(${p.slice(0, 2)}) ${p.slice(2, 7)}-${p.slice(7)}` : p);
  function toast(m, k = '') { const t = document.createElement('div'); t.className = 'toast ' + k; t.textContent = m; $('#toasts').append(t); setTimeout(() => t.remove(), 6000); }

  async function api(path, body) {
    const r = await fetch('/api' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('Entre novamente.'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Erro ${r.status}`);
    return d;
  }
  const show = (id) => ['login', 'pick', 'app'].forEach((x) => { $('#' + x).hidden = x !== id; });
  function showLogin() { if (S.es) S.es.close(); stopBeep(); $('#alert').hidden = true; show('login'); }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    try { await api('/login', { name: f.get('name'), pin: f.get('pin') }); e.target.reset(); boot(); } catch (err) { $('#loginErr').textContent = err.message; }
  });
  document.querySelectorAll('.pickbtn').forEach((b) => b.addEventListener('click', () => {
    S.team = b.dataset.team; try { localStorage.setItem(TKEY, S.team); } catch { /* */ }
    unlockAudio(); start();
  }));
  $('#switch').onclick = () => { stopBeep(); $('#alert').hidden = true; S.picker = null; show('pick'); };

  async function boot() {
    let me; try { me = await api('/me'); } catch { return; }
    $('#opName').textContent = me.name;
    show('pick'); // sempre pede um toque: libera o som do navegador
  }

  // ---------- som ----------
  function unlockAudio() { try { S.audio = S.audio || new (window.AudioContext || window.webkitAudioContext)(); S.audio.resume(); } catch { S.audio = null; } }
  function beep() {
    const a = S.audio; if (!a) return;
    [0, 0.25, 0.5].forEach((t, i) => { const o = a.createOscillator(); const g = a.createGain(); o.type = 'square'; o.frequency.value = i === 2 ? 1320 : 990; g.gain.value = 0.2; o.connect(g); g.connect(a.destination); o.start(a.currentTime + t); o.stop(a.currentTime + t + 0.18); });
  }
  function startBeep() { if (!S.beepT) { beep(); S.beepT = setInterval(beep, 2000); } }
  function stopBeep() { clearInterval(S.beepT); S.beepT = null; }

  // ---------- dados ----------
  async function start() {
    show('app');
    $('#teamName').textContent = LABEL[S.team];
    $('#tbar').className = 'tbar ' + S.team;
    document.title = `${LABEL[S.team]} · Pátio Push`;
    await refresh();
    connect();
  }
  async function refresh() {
    const [rows, docks] = await Promise.all([api('/visits?scope=active'), api('/docks')]);
    S.visits = new Map(rows.map((v) => [v.id, v])); S.docks = docks;
    render();
  }
  function connect() {
    if (S.es) S.es.close();
    const es = new EventSource('/api/stream'); S.es = es;
    es.onopen = () => { $('#live').className = 'live on'; refresh().catch(() => {}); };
    es.onerror = () => { $('#live').className = 'live off'; api('/me').catch(() => {}); };
    const upd = (ev) => {
      const v = JSON.parse(ev.data);
      if (ACTIVE.includes(v.status)) S.visits.set(v.id, v); else S.visits.delete(v.id);
      if (S.picker && !S.visits.has(S.picker.id)) S.picker = null;
      render();
    };
    es.addEventListener('visit', upd);
    es.addEventListener('team_alert', upd);
  }

  const mine = () => [...S.visits.values()].filter((v) => v.op_type === S.team && ACTIVE.includes(v.status));
  const pending = (v) => !!v.team_alert_at && (!v.team_ack_at || v.team_ack_at < v.team_alert_at);
  const dockPending = (v) => v.status === 'NA_DOCA' && v.dock_call_at && (!v.dock_call_acked_at || v.dock_call_acked_at < v.dock_call_at);
  function busyDocks() { const m = {}; for (const v of S.visits.values()) if (['CHAMADO', 'CONFIRMADO', 'NA_DOCA'].includes(v.status) && v.dock) m[v.dock] = (m[v.dock] || 0) + 1; return m; }

  function flags(v) {
    const f = [v.driver_online ? '<span class="ok">● celular conectado</span>' : v.driver_linked_at ? '<span class="off">○ página do motorista fechada</span>' : '<span class="wn">○ celular não conectou — avise por outro meio</span>'];
    if (v.push_enabled) f.push('<span class="ok">🔔 notificação ativa</span>');
    if (v.status === 'CONFIRMADO') f.push(`<span class="ok">✔ respondeu "estou indo" ${hm(v.confirmed_at)}</span>`);
    if (dockPending(v)) f.push(`<span class="wn">📣 chamado ${hm(v.dock_call_at)} (${esc(REASONS[v.dock_call_reason]?.label || '')}) — sem resposta</span>`);
    else if (v.dock_call_acked_at) f.push(`<span class="ok">✔ respondeu ${hm(v.dock_call_acked_at)}</span>`);
    return `<div class="fl">${f.join('')}</div>`;
  }
  function dockGrid(v, action) {
    const busy = busyDocks();
    return `<div class="docks">${S.docks.map((d) => `<button class="dock" data-a="${action}" data-id="${v.id}" data-dock="${esc(d.name)}">${esc(d.name)}${d.name === v.dock ? '<small>atual</small>' : busy[d.name] ? `<small>${busy[d.name]} em uso</small>` : ''}</button>`).join('')}</div>`;
  }
  function card(v) {
    const p = S.picker && S.picker.id === v.id ? S.picker.kind : null;
    let acts = ''; let pk = ''; let when = '';
    if (v.status === 'AGUARDANDO') {
      when = `chegou ${hm(v.arrived_at)} · esperando ${dur(mins(v.arrived_at))}`;
      acts = `<button class="btn tcall" data-a="pick-call" data-id="${v.id}">CHAMAR MOTORISTA</button>`;
      if (p === 'call') pk = `<div class="pk"><span class="lbl">Escolha a doca — o celular do motorista vibra na hora:</span>${dockGrid(v, 'call')}</div>`;
    } else if (v.status === 'CHAMADO' || v.status === 'CONFIRMADO') {
      when = `chamado ${hm(v.called_at)}${v.call_count > 1 ? ` · ${v.call_count} chamadas` : ''}`;
      acts = `<button class="btn sm tcall" data-a="recall" data-id="${v.id}">Rechamar</button>
        <button class="btn sm tsec" data-a="pick-call" data-id="${v.id}">Trocar doca</button>
        <button class="btn sm tok" data-a="docked" data-id="${v.id}">Encostou na doca</button>
        <button class="btn sm tno" data-a="uncall" data-id="${v.id}">Voltar para a fila</button>`;
      if (p === 'call') pk = `<div class="pk"><span class="lbl">Nova doca — o motorista é chamado de novo:</span>${dockGrid(v, 'call')}</div>`;
    } else if (v.status === 'NA_DOCA') {
      when = `na doca desde ${hm(v.docked_at)} · ${dur(mins(v.docked_at))}`;
      acts = `<button class="btn tcall" data-a="pick-reason" data-id="${v.id}">CHAMAR MOTORISTA</button>
        <button class="btn sm tok" data-a="finish" data-id="${v.id}">Liberar saída</button>`;
      if (p === 'reason') pk = `<div class="pk"><span class="lbl">Por que chamar o motorista?</span><div class="reasons">${Object.entries(REASONS).map(([k, r]) => `<button class="reason" data-a="${k === 'MUDAR' ? 'pick-move' : 'dockcall'}" data-reason="${k}" data-id="${v.id}">${r.label}<small>${r.hint}</small></button>`).join('')}</div></div>`;
      if (p === 'move') pk = `<div class="pk"><span class="lbl">Para qual doca o caminhão vai?</span>${dockGrid(v, 'move')}</div>`;
    }
    return `<article class="tv ${pending(v) || dockPending(v) ? 'hot' : ''}">
      <div><span class="pl">${esc(v.plate)}</span>${v.dock ? `<span class="dk">${esc(v.dock)}</span>` : ''}
        <div class="ln">${esc(v.driver_name)} · ${esc(v.carrier)} · ${esc(v.auth_code)}<br>${esc(v.cargo)}${v.partner ? ` · ${esc(v.partner)}` : ''}<br>${when} · tel. ${esc(fmtPhone(v.phone))}</div>
        ${flags(v)}</div>
      <div class="acts">${acts}</div>${pk}</article>`;
  }

  function render() {
    if ($('#app').hidden) return;
    const m = mine();
    const q = m.filter((v) => v.status === 'AGUARDANDO').sort((a, b) => a.arrived_at.localeCompare(b.arrived_at));
    const c = m.filter((v) => v.status === 'CHAMADO' || v.status === 'CONFIRMADO').sort((a, b) => (a.called_at || '').localeCompare(b.called_at || ''));
    const d = m.filter((v) => v.status === 'NA_DOCA').sort((a, b) => (a.docked_at || '').localeCompare(b.docked_at || ''));
    $('#nQueue').textContent = q.length; $('#nComing').textContent = c.length; $('#nDock').textContent = d.length;
    $('#tQueue').innerHTML = q.map(card).join('') || '<div class="empty">Nenhum caminhão esperando. Quando a portaria lançar um, ele aparece aqui e a tela avisa.</div>';
    $('#tComing').innerHTML = c.map(card).join('') || '<div class="empty">Ninguém chamado no momento.</div>';
    $('#tDock').innerHTML = d.map(card).join('') || '<div class="empty">Nenhum caminhão na doca. Use "Encostou na doca" quando o caminhão chegar.</div>';
    renderAlert(m);
  }

  function renderAlert(m) {
    const p = m.filter(pending).sort((a, b) => a.team_alert_at.localeCompare(b.team_alert_at));
    const box = $('#alert');
    if (!p.length) { box.hidden = true; stopBeep(); document.title = `${LABEL[S.team]} · Pátio Push`; return; }
    const v = p[0];
    box.className = 'alert ' + S.team; box.hidden = false;
    $('#aKind').textContent = KIND[v.team_alert_kind] || 'ATENÇÃO';
    $('#aDock').textContent = v.team_alert_kind === 'NOVA_CHEGADA' ? 'CHAMAR' : (v.dock || '');
    $('#aPlate').textContent = v.plate;
    $('#aInfo').innerHTML = `${esc(v.carrier)} · ${esc(v.driver_name)}<br><b>${esc(v.cargo)}</b>${v.partner ? ` · ${esc(v.partner)}` : ''}<br>Autorização ${esc(v.auth_code)}`;
    $('#aMore').textContent = p.length > 1 ? `+ ${p.length - 1} aviso(s) aguardando ciência` : '';
    $('#ackBtn').dataset.id = v.id;
    document.title = `🔴 ${v.plate} · ${KIND[v.team_alert_kind] || ''}`;
    startBeep();
  }

  $('#ackBtn').onclick = async () => {
    const id = Number($('#ackBtn').dataset.id);
    try { const v = await api(`/visits/${id}/team-ack`, { team: S.team }); S.visits.set(v.id, v); render(); } catch (e) { toast(e.message, 'err'); }
  };

  $('#app').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const v = S.visits.get(Number(b.dataset.id)); if (!v) return;
    const a = b.dataset.a;
    if (a.startsWith('pick-')) {
      const kind = a.slice(5);
      S.picker = S.picker && S.picker.id === v.id && S.picker.kind === kind && kind !== 'move' ? null : { id: v.id, kind };
      if (kind !== 'reason') S.docks = await api('/docks').catch(() => S.docks);
      return render();
    }
    S.picker = null; b.disabled = true;
    const report = (r, what) => {
      const d = r.delivery; if (!d) return;
      const ok = d.page_open || d.push.delivered_to_push_service > 0;
      toast(`${v.driver_name} ${what}: ${ok ? [d.page_open ? 'celular vibrando' : '', d.push.delivered_to_push_service ? 'notificação enviada' : ''].filter(Boolean).join(' + ') : `SEM CONEXÃO com o celular — avise pessoalmente ou ligue ${fmtPhone(v.phone)}`}`, ok ? 'ok' : 'err');
    };
    try {
      if (a === 'call') report(await api(`/visits/${v.id}/call`, { dock: b.dataset.dock }), `chamado para ${b.dataset.dock}`);
      if (a === 'recall') report(await api(`/visits/${v.id}/recall`, {}), 'chamado de novo');
      if (a === 'uncall') await api(`/visits/${v.id}/uncall`, {});
      if (a === 'docked') { await api(`/visits/${v.id}/docked`, {}); toast(`${v.plate} na ${v.dock}.`, 'ok'); }
      if (a === 'finish') { await api(`/visits/${v.id}/finish`, {}); toast(`${v.plate} liberado para sair.`, 'ok'); }
      if (a === 'dockcall') report(await api(`/visits/${v.id}/dock-call`, { reason: b.dataset.reason }), `chamado na ${v.dock}`);
      if (a === 'move') report(await api(`/visits/${v.id}/dock-call`, { reason: 'MUDAR', dock: b.dataset.dock }), `chamado para mudar para a ${b.dataset.dock}`);
    } catch (err) { toast(err.message, 'err'); } finally { b.disabled = false; }
  });

  // Mantém o servidor gratuito acordado enquanto esta tela estiver aberta, e atualiza os tempos de espera.
  setInterval(() => { if (!$('#app').hidden) fetch('/health', { cache: 'no-store' }).catch(() => {}); }, 4 * 60e3);
  setInterval(() => { if (!S.picker) render(); }, 30000);
  setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('pt-BR', { timeZone: TZ }); }, 1000);
  boot();
})();
