'use strict';
(() => {
  const $ = (s, e = document) => e.querySelector(s);
  const $$ = (s, e = document) => [...e.querySelectorAll(s)];
  const TZ = 'America/Sao_Paulo';
  const S = { visits: new Map(), type: '', scope: 'active', es: null, docks: [] };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '');
  const hms = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ }) : '');
  const minsSince = (iso, end) => ((end ? new Date(end) : new Date()) - new Date(iso)) / 60000;
  const dur = (m) => (m == null ? '—' : m < 60 ? `${Math.floor(m)} min` : `${Math.floor(m / 60)}h${String(Math.floor(m % 60)).padStart(2, '0')}`);
  const fmtPhone = (p) => (p.length === 11 ? `(${p.slice(0, 2)}) ${p.slice(2, 7)}-${p.slice(7)}` : p.length === 13 ? `(${p.slice(2, 4)}) ${p.slice(4, 9)}-${p.slice(9)}` : p);
  const ST = { AGUARDANDO: 'Na fila', CHAMADO: 'Chamado', CONFIRMADO: 'A caminho', NA_DOCA: 'Na doca', FINALIZADO: 'Liberado', ATENDIDO: 'Atendido', CANCELADO: 'Cancelado' };
  const ACTIVE = ['AGUARDANDO', 'CHAMADO', 'CONFIRMADO', 'NA_DOCA'];
  const REASON = { CONCLUIDO: 'carga/descarga concluída', CAMINHAO: 'comparecer ao caminhão', DOCUMENTOS: 'nota fiscal / documentos', MUDAR: 'mudar de doca' };
  const dockPending = (v) => v.status === 'NA_DOCA' && v.dock_call_at && (!v.dock_call_acked_at || v.dock_call_acked_at < v.dock_call_at);
  const TYPE = { RECEBIMENTO: 'RECEBIMENTO', EXPEDICAO: 'EXPEDIÇÃO' };

  async function api(path, body) {
    const r = await fetch('/api' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('Entre novamente.'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || `Erro ${r.status}`), { status: r.status });
    return d;
  }
  function toast(m, k = '') { const t = document.createElement('div'); t.className = 'toast ' + k; t.textContent = m; $('#toasts').append(t); setTimeout(() => t.remove(), 6000); }
  function beep() {
    try { const a = new (window.AudioContext || window.webkitAudioContext)(); const o = a.createOscillator(); const g = a.createGain(); o.frequency.value = 880; o.connect(g); g.connect(a.destination); g.gain.value = .15; o.start(); setTimeout(() => { o.stop(); a.close(); }, 220); } catch { /* sem áudio */ }
  }

  // ---------- modal ----------
  function modal({ title, body, buttons = [], onOpen }) {
    $('#mTitle').textContent = title; $('#mBody').innerHTML = body; const f = $('#mFoot'); f.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button'); el.className = 'btn ' + (b.cls || ''); el.textContent = b.label;
      el.onclick = async () => { if (!b.action) return close(); el.disabled = true; try { const r = await b.action(); if (r !== false) close(); } catch (e) { toast(e.message, 'err'); } finally { el.disabled = false; } };
      f.append(el);
    }
    $('#modal').hidden = false; if (onOpen) onOpen($('#mBody'));
  }
  const close = () => { $('#modal').hidden = true; $('#mBody').innerHTML = ''; };
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.hasAttribute('data-close')) close(); });

  // ---------- login ----------
  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; if (S.es) S.es.close(); }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    try { await api('/login', { name: f.get('name'), pin: f.get('pin') }); e.target.reset(); start(); } catch (err) { $('#loginErr').textContent = err.message; }
  });
  $('#logout').onclick = async () => { await api('/logout', {}).catch(() => {}); showLogin(); };

  async function start() {
    let me; try { me = await api('/me'); } catch { return showLogin(); }
    $('#login').hidden = true; $('#app').hidden = false; $('#opName').textContent = me.name;
    storageBanner(me.storage);
    if (location.hostname !== 'localhost' && location.protocol !== 'https:' && !me.publicUrl) {
      toast('Atenção: sem HTTPS os celulares não liberam notificações. Veja o README (túnel HTTPS gratuito).', 'err');
    }
    S.docks = await api('/docks');
    await load(); connect();
  }

  async function load() {
    const rows = await api('/visits?scope=' + S.scope);
    S.visits = new Map(rows.map((v) => [v.id, v]));
    render(); kpis();
  }

  function connect() {
    if (S.es) S.es.close();
    const es = new EventSource('/api/stream'); S.es = es;
    es.onopen = () => { $('#live').className = 'live on'; load().catch(() => {}); };
    es.onerror = () => { $('#live').className = 'live off'; api('/me').catch(() => {}); /* servidor reiniciou? volta ao login */ };
    es.addEventListener('visit', (ev) => {
      const v = JSON.parse(ev.data);
      const active = ACTIVE.includes(v.status);
      if (S.scope === 'active' && !active) S.visits.delete(v.id); else S.visits.set(v.id, v);
      render(v.id); kpis();
    });
    es.addEventListener('ack', (ev) => {
      const a = JSON.parse(ev.data);
      toast(`✔ ${a.driver_name} (${a.plate}) respondeu: ESTOU INDO (${a.dock})`, 'ok'); beep();
    });
  }

  // Aviso permanente quando os dados não sobrevivem a um reinício do servidor (nuvem sem banco externo).
  function storageBanner(st) {
    let el = $('#storageBanner');
    if (!st || st.mode !== 'TEMPORARIO') { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'storageBanner'; el.className = 'storage-warn'; $('.top').after(el); }
    el.textContent = 'DADOS TEMPORÁRIOS: sem banco externo configurado, a fila e o histórico são apagados quando o servidor dorme (15 min sem uso) ou reinicia. Configure DATABASE_URL (guia, passo 4).';
  }
  // Mantém o servidor gratuito acordado enquanto esta tela estiver aberta (ele dorme após 15 min sem acesso).
  setInterval(() => { if (!$('#app').hidden) fetch('/health', { cache: 'no-store' }).catch(() => {}); }, 4 * 60e3);

  // ---------- painel ----------
  function kpis() {
    const all = [...S.visits.values()];
    const c = (st) => all.filter((v) => v.status === st).length;
    api('/stats').then((s) => {
      $('#kpis').innerHTML = `<span><b>${s.waitingNow}</b>na fila</span><span><b>${c('CHAMADO') + c('CONFIRMADO')}</b>chamados</span><span><b>${c('NA_DOCA')}</b>na doca</span>
        <span><b>${dur(s.avgWaitMin)}</b>espera média hoje</span><span><b>${s.arrivals}</b>chegadas hoje</span>`;
    }).catch(() => {});
  }

  function render(flashId) {
    const order = { CHAMADO: 0, CONFIRMADO: 1, NA_DOCA: 2, AGUARDANDO: 3, FINALIZADO: 4, ATENDIDO: 4, CANCELADO: 5 };
    const rows = [...S.visits.values()].filter((v) => !S.type || v.op_type === S.type)
      .sort((a, b) => S.scope === 'active' ? (order[a.status] - order[b.status]) || a.arrived_at.localeCompare(b.arrived_at) : b.arrived_at.localeCompare(a.arrived_at));
    $('#rows').innerHTML = rows.map((v) => {
      const open = ACTIVE.includes(v.status);
      const waitM = minsSince(v.arrived_at, v.called_at || (open ? null : v.closed_at));
      let acts = '';
      if (open) {
        // A portaria só lança e acompanha: quem chama e indica a doca é o Recebimento/Expedição.
        acts += `<button class="btn xs" data-a="qr" data-id="${v.id}">QR</button><button class="btn xs no" data-a="cancel" data-id="${v.id}">Cancelar</button>`;
      }
      acts += `<button class="btn xs" data-a="log" data-id="${v.id}">Histórico</button>`;
      return `<tr class="${flashId === v.id ? 'flash' : ''}">
        <td><span class="auth">${esc(v.auth_code)}</span><br><span class="tag ${v.op_type}">${TYPE[v.op_type]}</span></td>
        <td><b>${esc(v.driver_name)}</b><span class="sub"><span class="plate">${esc(v.plate)}</span> · ${esc(v.carrier)}</span></td>
        <td>${esc(v.cargo)}${v.partner ? `<span class="sub">${v.op_type === 'RECEBIMENTO' ? 'Fornecedor' : 'Cliente'}: ${esc(v.partner)}</span>` : ''}</td>
        <td>${hm(v.arrived_at)}<span class="sub">espera <span class="wait ${open && !v.called_at && waitM > 30 ? 'long' : ''}">${dur(waitM)}</span>${v.called_at ? ` · chamado ${hm(v.called_at)}` : ''}${v.docked_at ? ` · na doca ${hm(v.docked_at)}` : ''}</span></td>
        <td class="dev">${v.driver_online ? '<span class="on">● página aberta</span>' : v.driver_linked_at ? '<span class="off">○ página fechada</span>' : '<span class="off">○ não conectou</span>'}
          <span class="sub">${v.push_enabled ? '🔔 notificação ativa' : 'sem notificação'}</span></td>
        <td><span class="st ${v.status}">${ST[v.status]}</span>${v.dock ? `<span class="sub"><b>${esc(v.dock)}</b>${v.call_count > 1 ? ` · ${v.call_count} chamadas` : ''}</span>` : ''}${teamTag(v)}</td>
        <td class="r"><div class="acts">${acts}</div></td></tr>`;
    }).join('') || `<tr><td colspan="7" class="sub" style="padding:24px">${S.scope === 'active' ? 'Nenhum caminhão no pátio.' : 'Sem registros hoje.'}</td></tr>`;
  }
  function teamTag(v) {
    if (!ACTIVE.includes(v.status)) return '';
    const team = v.op_type === 'RECEBIMENTO' ? 'Recebimento' : 'Expedição';
    let out = '';
    if (v.team_alert_at) {
      out += (!v.team_ack_at || v.team_ack_at < v.team_alert_at)
        ? `<span class="sub" style="color:var(--amber);font-weight:700">⚠ ${team} ainda não viu</span>`
        : `<span class="sub" style="color:var(--green);font-weight:700">✔ ${team} ciente ${hm(v.team_ack_at)}</span>`;
    }
    if (dockPending(v)) out += `<span class="sub" style="color:var(--amber);font-weight:700">📣 chamado na doca (${REASON[v.dock_call_reason] || ''}) — sem resposta</span>`;
    else if (v.dock_call_acked_at) out += `<span class="sub" style="color:var(--green)">✔ respondeu na doca ${hm(v.dock_call_acked_at)}</span>`;
    return out;
  }
  setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('pt-BR', { timeZone: TZ }); }, 1000);
  setInterval(() => { if (!$('#app').hidden) render(); }, 30000);

  $('#typeTabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.type = b.dataset.t; $$('#typeTabs button').forEach((x) => x.classList.toggle('on', x === b)); render(); };
  $('#scopeTabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.scope = b.dataset.s; $$('#scopeTabs button').forEach((x) => x.classList.toggle('on', x === b)); load(); };

  $('#rows').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const v = S.visits.get(Number(b.dataset.id)); if (!v) return;
    try {
      if (b.dataset.a === 'qr') return qrDialog(v, false);
      if (b.dataset.a === 'log') return logDialog(v);
      if (b.dataset.a === 'cancel') return modal({
        title: `Cancelar ${v.auth_code}`, body: `<p>${esc(v.driver_name)} · ${esc(v.plate)}</p><label>Motivo<input id="cNote" maxlength="200"></label>`,
        buttons: [{ label: 'Voltar' }, { label: 'Cancelar autorização', cls: 'no', action: () => api(`/visits/${v.id}/cancel`, { note: $('#cNote').value }) }],
      });
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---------- cadastro ----------
  $('#arrForm').addEventListener('change', (e) => {
    if (e.target.name === 'op_type') $('#partnerLbl').textContent = e.target.value === 'RECEBIMENTO' ? 'Fornecedor' : 'Cliente';
  });
  $('#arrForm').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#arrErr').textContent = '';
    const body = Object.fromEntries(new FormData(e.target));
    try {
      const v = await api('/visits', body);
      e.target.reset(); $('#partnerLbl').textContent = 'Fornecedor / cliente';
      if (S.scope === 'active') { S.visits.set(v.id, v); render(v.id); }
      qrDialog(v, true);
    } catch (err) { $('#arrErr').textContent = err.message; }
  });

  async function qrDialog(v, fresh) {
    const { driver_link: link } = v.driver_link ? v : await api(`/visits/${v.id}/link`);
    modal({
      title: fresh ? 'Entrada autorizada' : `QR do motorista — ${v.auth_code}`,
      body: `<div class="qrbox"><img src="/api/visits/${v.id}/qr.svg" alt="QR Code do motorista">
        <div><div class="sub">Autorização</div><div class="big-auth">${esc(v.auth_code)}</div>
        <p><b>${esc(v.driver_name)}</b><br><span class="plate">${esc(v.plate)}</span> <span class="tag ${v.op_type}">${TYPE[v.op_type]}</span></p>
        <p class="sub">Peça ao motorista para ler este QR com a câmera do celular e tocar em <b>ATIVAR ALERTAS</b>. O ${v.op_type === 'RECEBIMENTO' ? 'Recebimento' : 'Expedição'} já foi avisado e vai chamar.
        Alternativa: cartaz fixo da portaria + placa + 4 últimos dígitos do celular (${esc(v.phone.slice(-4))}).</p></div></div>
        <p class="sub" style="word-break:break-all">Link: <span class="mono">${esc(link)}</span></p>`,
      buttons: [{ label: 'Copiar link', action: async () => { await navigator.clipboard.writeText(link).catch(() => {}); toast('Link copiado.'); return false; } }, { label: 'Fechar', cls: 'primary' }],
    });
  }

  async function logDialog(v) {
    const ev = await api(`/visits/${v.id}/events`);
    const fmt = (d) => { try { const o = JSON.parse(d); return Object.entries(o).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`).join(' · '); } catch { return d || ''; } };
    modal({
      title: `${v.auth_code} — ${v.driver_name}`,
      body: `<p class="sub">Chegada ${hms(v.arrived_at)} · Chamada ${hms(v.called_at) || '—'} · A caminho ${hms(v.confirmed_at) || '—'} · Na doca ${hms(v.docked_at) || '—'} · Liberado ${hms(v.finished_at || v.attended_at) || '—'}</p>
        <ul class="timeline">${ev.map((e) => `<li><span class="when">${hms(e.created_at)}</span><b>${esc(e.type.replace(/_/g, ' '))}</b> ${e.actor ? '· ' + esc(e.actor) : ''}<div class="sub">${esc(fmt(e.detail))}</div></li>`).join('')}</ul>`,
      buttons: [{ label: 'Fechar', cls: 'primary' }],
    });
  }

  start();
})();
