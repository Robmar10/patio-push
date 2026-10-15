'use strict';
(() => {
  const $ = (s, e = document) => e.querySelector(s);
  const $$ = (s, e = document) => [...e.querySelectorAll(s)];
  const TZ = 'America/Sao_Paulo';
  const S = { visits: new Map(), type: '', scope: 'active', es: null, docks: [], qrId: null, siteName: '' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '');
  const hms = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ }) : '');
  const minsSince = (iso, end) => ((end ? new Date(end) : new Date()) - new Date(iso)) / 60000;
  const dur = (m) => (m == null ? '—' : m < 60 ? `${Math.floor(m)} min` : `${Math.floor(m / 60)}h${String(Math.floor(m % 60)).padStart(2, '0')}`);
  const fmtPhone = (p) => (p.length === 11 ? `(${p.slice(0, 2)}) ${p.slice(2, 7)}-${p.slice(7)}` : p.length === 13 ? `(${p.slice(2, 4)}) ${p.slice(4, 9)}-${p.slice(9)}` : p);
  const ST = { AGUARDANDO: 'Na fila', CHAMADO: 'Chamado', CONFIRMADO: 'A caminho', NA_DOCA: 'Na doca', FINALIZADO: 'Liberado', ATENDIDO: 'Atendido', CANCELADO: 'Cancelado' };
  const ACTIVE = ['AGUARDANDO', 'CHAMADO', 'CONFIRMADO', 'NA_DOCA'];
  const msgPending = (v) => !!(v.msg && v.msg.pending);
  const awaitingExit = (v) => v.status === 'FINALIZADO' && !v.exited_at;
  const keep = (v) => ACTIVE.includes(v.status) || awaitingExit(v); // o que aparece em "Em aberto"
  const TYPE = { RECEBIMENTO: 'RECEBIMENTO', EXPEDICAO: 'EXPEDIÇÃO' };
  const NAME = { RECEBIMENTO: 'Recebimento', EXPEDICAO: 'Expedição' };
  const intl = (p) => (p.length <= 11 ? '55' + p : p);

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
    $('#login').hidden = true; $('#app').hidden = false; $('#opName').textContent = me.name; S.siteName = me.siteName || '';
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
      if (S.scope === 'active' && !keep(v)) S.visits.delete(v.id); else S.visits.set(v.id, v);
      render(v.id); kpis();
      if (S.qrId === v.id) qrLive(v);
    });
    es.addEventListener('test_ok', (ev) => {
      const t = JSON.parse(ev.data);
      const v = S.visits.get(t.id); if (v) { v.test_ok_at = t.at; if (S.qrId === t.id) qrLive(v); }
      toast(`✔ O celular do caminhão ${t.plate} recebeu o aviso de teste.`, 'ok'); beep();
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
        <span class="${all.filter(awaitingExit).length ? 'kx' : ''}"><b>${all.filter(awaitingExit).length}</b>liberados p/ sair</span>
        <span><b>${dur(s.avgWaitMin)}</b>espera média hoje</span><span><b>${dur(s.avgYardMin)}</b>tempo no pátio</span><span><b>${s.arrivals}</b>chegadas hoje</span>`;
    }).catch(() => {});
  }

  function render(flashId) {
    const order = { FINALIZADO: -1, CHAMADO: 0, CONFIRMADO: 1, NA_DOCA: 2, AGUARDANDO: 3, ATENDIDO: 4, CANCELADO: 5 };
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
      if (awaitingExit(v)) acts = `<button class="btn xs primary" data-a="exit" data-id="${v.id}">REGISTRAR SAÍDA</button>` + acts;
      acts += `<button class="btn xs" data-a="log" data-id="${v.id}">Histórico</button>`;
      return `<tr class="${flashId === v.id ? 'flash' : ''}">
        <td><span class="auth">${esc(v.auth_code)}</span><br><span class="tag ${v.op_type}">${TYPE[v.op_type]}</span>${v.next_op ? `<span class="sub">➜ depois ${NAME[v.next_op]}</span>` : ''}${(v.leg || 1) > 1 ? '<span class="sub">↩ transferido</span>' : ''}</td>
        <td><b>${esc(v.driver_name)}</b><span class="sub"><span class="plate">${esc(v.plate)}</span> · ${esc(v.carrier)}</span></td>
        <td>${esc(v.cargo)}${v.partner ? `<span class="sub">${v.op_type === 'RECEBIMENTO' ? 'Fornecedor' : 'Cliente'}: ${esc(v.partner)}</span>` : ''}</td>
        <td>${hm(v.arrived_at)}<span class="sub">espera <span class="wait ${open && !v.called_at && waitM > 30 ? 'long' : ''}">${dur(waitM)}</span>${v.called_at ? ` · chamado ${hm(v.called_at)}` : ''}${v.docked_at ? ` · na doca ${hm(v.docked_at)}` : ''}</span></td>
        <td class="dev">${v.driver_online ? '<span class="on">● página aberta</span>' : v.driver_linked_at ? '<span class="off">○ página fechada</span>' : '<span class="off">○ não conectou</span>'}
          <span class="sub">${v.push_enabled ? '🔔 notificação ativa' : '🔕 sem notificação'}${v.test_ok_at ? ' · ✔ teste ok' : ''}</span></td>
        <td><span class="st ${v.status}">${awaitingExit(v) ? 'Liberado — sair' : v.status === 'FINALIZADO' && v.exited_at ? `Saiu ${hm(v.exited_at)}` : ST[v.status]}</span>${v.dock ? `<span class="sub"><b>${esc(v.dock)}</b>${v.call_count > 1 ? ` · ${v.call_count} chamadas` : ''}</span>` : ''}${teamTag(v)}</td>
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
    if (msgPending(v)) out += `<span class="sub" style="color:var(--amber);font-weight:700">📣 ${esc(v.msg.label)}${v.msg.place ? ` → ${esc(v.msg.place)}` : ''} — sem resposta</span>`;
    else if (v.msg && v.msg.acked_at) out += `<span class="sub" style="color:var(--green)">✔ respondeu "${esc(v.msg.label)}" ${hm(v.msg.acked_at)}</span>`;
    if (['NAO_RECEBEU', 'SEM_RESPOSTA'].includes(v.team_alert_kind) && (!v.team_ack_at || v.team_ack_at < v.team_alert_at)) {
      out += `<span class="sub" style="color:var(--red,#c4241c);font-weight:700">⚠ ${v.team_alert_kind === 'NAO_RECEBEU' ? 'chamada não chegou no celular' : 'motorista não respondeu'}</span>`;
    }
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
      if (b.dataset.a === 'exit') {
        b.disabled = true;
        try { const nv = await api(`/visits/${v.id}/exit`, {}); toast(`Saída de ${nv.plate} registrada.`, 'ok'); } finally { b.disabled = false; }
        return;
      }
      if (b.dataset.a === 'cancel') return modal({
        title: `Cancelar ${v.auth_code}`, body: `<p>${esc(v.driver_name)} · ${esc(v.plate)}</p><label>Motivo<input id="cNote" maxlength="200"></label>`,
        buttons: [{ label: 'Voltar' }, { label: 'Cancelar autorização', cls: 'no', action: () => api(`/visits/${v.id}/cancel`, { note: $('#cNote').value }) }],
      });
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---------- cadastro ----------
  $('#arrForm').addEventListener('change', (e) => {
    if (e.target.name === 'op_type') {
      $('#partnerLbl').textContent = e.target.value === 'RECEBIMENTO' ? 'Fornecedor' : 'Cliente';
      $('#nextLbl').textContent = e.target.value === 'RECEBIMENTO' ? 'Depois de descarregar, vai CARREGAR na Expedição' : 'Depois de carregar, vai DESCARREGAR no Recebimento';
    }
  });
  $('#arrForm').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#arrErr').textContent = '';
    const body = Object.fromEntries(new FormData(e.target));
    try {
      const v = await api('/visits', body);
      e.target.reset(); $('#partnerLbl').textContent = 'Fornecedor / cliente'; $('#nextLbl').textContent = 'Operação dupla (Recebimento + Expedição)';
      if (S.scope === 'active') { S.visits.set(v.id, v); render(v.id); }
      qrDialog(v, true);
    } catch (err) { $('#arrErr').textContent = err.message; }
  });

  async function qrDialog(v, fresh) {
    const { driver_link: link } = v.driver_link ? v : await api(`/visits/${v.id}/link`);
    S.qrId = v.id;
    modal({
      title: fresh ? 'Entrada autorizada' : `QR do motorista — ${v.auth_code}`,
      body: `<div class="qrbox"><img src="/api/visits/${v.id}/qr.svg" alt="QR Code do motorista">
        <div><div class="sub">Autorização</div><div class="big-auth">${esc(v.auth_code)}</div>
        <p><b>${esc(v.driver_name)}</b><br><span class="plate">${esc(v.plate)}</span> <span class="tag ${v.op_type}">${TYPE[v.op_type]}</span>${v.next_op ? ` <span class="sub">➜ depois ${NAME[v.next_op]}</span>` : ''}</p>
        <div class="cartaz-id">Pelo <b>CARTAZ</b> da portaria, o motorista digita:<br>placa <b class="plate">${esc(v.plate)}</b> + final do celular <b class="plate">${esc(v.phone.slice(-4))}</b></div>
        <p class="sub">Ou lê este QR individual. Depois: <b>ATIVAR ALERTAS</b> → <b>PERMITIR</b>. Só o celular dele recebe as chamadas desta placa.</p>
        <div id="qrLive" class="qrlive"></div></div></div>
        <p class="sub" style="word-break:break-all">Link individual: <span class="mono">${esc(link)}</span></p>`,
      buttons: [
        { label: 'Copiar link', action: async () => { await navigator.clipboard.writeText(link).catch(() => {}); toast('Link copiado.'); return false; } },
        { label: 'Fechar', cls: 'primary' },
      ],
      onOpen: () => qrLive(v),
    });
  }
  // Checagem ao vivo do celular do motorista, para a portaria só liberar quando estiver tudo verde.
  function qrLive(v) {
    const el = $('#qrLive'); if (!el || $('#modal').hidden) { S.qrId = null; return; }
    const ok = (b) => (b ? '<b class="ok">✔</b>' : '<b class="no">○</b>');
    const all = v.driver_linked_at && v.push_enabled && v.test_ok_at;
    el.innerHTML = `<ul>
      <li>${ok(v.driver_linked_at)} Celular abriu a página${v.driver_online ? ' (aberta agora)' : ''}</li>
      <li>${ok(v.push_enabled)} Notificações permitidas${!v.push_enabled && v.driver_linked_at ? ' — <span class="no">peça para tocar em PERMITIR; se estiver bloqueado, a tela dele mostra como liberar</span>' : ''}</li>
      <li>${ok(v.test_ok_at)} Aviso de teste chegou no celular${v.test_ok_at ? ` ${hm(v.test_ok_at)}` : ''}</li></ul>
      ${all ? '<div class="qrok">TUDO CERTO — pode liberar o motorista para o pátio</div>'
        : `<button class="btn sm" id="qrTest" ${v.push_enabled ? '' : 'disabled'}>TESTAR AVISO NO CELULAR</button><span class="sub" id="qrTestMsg"></span>`}`;
    const t = $('#qrTest');
    if (t) t.onclick = async () => {
      t.disabled = true;
      try { await api(`/visits/${v.id}/test-push`, { seconds: 6 }); $('#qrTestMsg').textContent = ' Peça para BLOQUEAR o celular: o aviso chega em ~6 s.'; }
      catch (e) { $('#qrTestMsg').textContent = ' ' + e.message; }
      finally { setTimeout(() => { if ($('#qrTest')) $('#qrTest').disabled = false; }, 6000); }
    };
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
