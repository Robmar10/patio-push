'use strict';
/* Tela do Recebimento / Expedição: chama o motorista e indica a doca, manda recados (buscar nota, assinar
   canhoto, documentos, texto livre) com o local, marca quando encostou, chama na doca, passa o caminhão para a
   outra equipe e libera a saída. Pisca e apita quando há caminhão novo, quando o motorista responde e quando
   a chamada NÃO chegou no celular (com WhatsApp e telefone prontos). */
(() => {
  const $ = (s) => document.querySelector(s);
  const TKEY = 'pp_team';
  const LABEL = { RECEBIMENTO: 'RECEBIMENTO', EXPEDICAO: 'EXPEDIÇÃO' };
  const NAME = { RECEBIMENTO: 'Recebimento', EXPEDICAO: 'Expedição' };
  const other = (t) => (t === 'RECEBIMENTO' ? 'EXPEDICAO' : 'RECEBIMENTO');
  const KIND = {
    NOVA_CHEGADA: 'NOVO CAMINHÃO NA FILA', ENTRANDO: 'MOTORISTA A CAMINHO', RESPONDEU: 'MOTORISTA RESPONDEU — ESTÁ INDO',
    TRANSFERIDO: 'CAMINHÃO PASSADO PARA VOCÊS', NAO_RECEBEU: 'O CELULAR NÃO RECEBEU A CHAMADA', SEM_RESPOSTA: 'MOTORISTA NÃO RESPONDEU',
  };
  const PROBLEM = ['NAO_RECEBEU', 'SEM_RESPOSTA'];
  const ACTIVE = ['AGUARDANDO', 'CHAMADO', 'CONFIRMADO', 'NA_DOCA'];
  const S = { team: null, visits: new Map(), docks: [], cfg: { reasons: {}, offices: [], siteName: '' }, es: null, audio: null, beepT: null, picker: null };
  try { S.team = localStorage.getItem(TKEY); } catch { /* */ }
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TZ = 'America/Sao_Paulo';
  const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '');
  const mins = (a, b) => ((b ? new Date(b) : new Date()) - new Date(a)) / 60000;
  const dur = (m) => (m < 1 ? `${Math.max(0, Math.round(m * 60))} s` : m < 60 ? `${Math.floor(m)} min` : `${Math.floor(m / 60)}h${String(Math.floor(m % 60)).padStart(2, '0')}`);
  const fmtPhone = (p) => (p.length === 11 ? `(${p.slice(0, 2)}) ${p.slice(2, 7)}-${p.slice(7)}` : p.length === 13 ? `(${p.slice(2, 4)}) ${p.slice(4, 9)}-${p.slice(9)}` : p);
  const intl = (p) => (p.length <= 11 ? '55' + p : p);
  function toast(m, k = '') { const t = document.createElement('div'); t.className = 'toast ' + k; t.textContent = m; $('#toasts').append(t); setTimeout(() => t.remove(), 7000); }

  async function api(path, body) {
    const r = await fetch('/api' + path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
    S.cfg = await api('/config').catch(() => S.cfg);
    await refresh();
    connect();
  }
  async function refresh() {
    const [rows, docks] = await Promise.all([api('/visits?scope=active'), api('/docks')]);
    S.visits = new Map(rows.filter((v) => ACTIVE.includes(v.status)).map((v) => [v.id, v])); S.docks = docks;
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
      if (S.picker && (!S.visits.has(S.picker.id) || S.visits.get(S.picker.id).op_type !== S.team)) S.picker = null;
      render();
    };
    es.addEventListener('visit', upd);
    es.addEventListener('team_alert', upd);
  }

  const mine = () => [...S.visits.values()].filter((v) => v.op_type === S.team && ACTIVE.includes(v.status));
  const pending = (v) => !!v.team_alert_at && (!v.team_ack_at || v.team_ack_at < v.team_alert_at);
  const msgPending = (v) => !!(v.msg && v.msg.pending);
  const callPending = (v) => v.status === 'CHAMADO' || msgPending(v);
  function busyDocks() { const m = {}; for (const v of S.visits.values()) if (['CHAMADO', 'CONFIRMADO', 'NA_DOCA'].includes(v.status) && v.dock) m[v.dock] = (m[v.dock] || 0) + 1; return m; }

  // Mensagem pronta para o WhatsApp (plano B quando o celular não recebe a notificação).
  function waText(v) {
    const first = v.driver_name.split(' ')[0];
    const who = `Aqui é o ${NAME[v.op_type]}${S.cfg.siteName ? ` (${S.cfg.siteName})` : ''}.`;
    if (msgPending(v)) return `Olá ${first}! ${who} ${v.msg.head}: ${v.msg.text} Caminhão ${v.plate}.`;
    if (v.status === 'CHAMADO' || v.status === 'CONFIRMADO') return `Olá ${first}! ${who} Sua vez: compareça à ${v.dock} com o caminhão ${v.plate}.`;
    if (v.status === 'NA_DOCA') return `Olá ${first}! ${who} Compareça ao seu caminhão na ${v.dock}.`;
    return `Olá ${first}! ${who} Seu caminhão ${v.plate} está na fila. Mantenha a página de chamada aberta e as notificações ativas.`;
  }
  const contact = (v, big) => `<a class="ct wa${big ? ' big' : ''}" target="_blank" rel="noopener" href="https://wa.me/${intl(v.phone)}?text=${encodeURIComponent(waText(v))}">WhatsApp</a>`
    + `<a class="ct tel${big ? ' big' : ''}" href="tel:+${intl(v.phone)}">Ligar ${esc(fmtPhone(v.phone))}</a>`;

  function flags(v) {
    const f = [v.driver_online ? '<span class="ok">● página aberta</span>' : v.driver_linked_at ? '<span class="off">○ página fechada</span>' : '<span class="wn">○ celular não conectou — avise por outro meio</span>'];
    if (v.push_enabled) f.push('<span class="ok">🔔 chama com celular bloqueado</span>');
    else if (v.driver_linked_at) f.push('<span class="wn">🔕 sem notificação — só chama com a página aberta</span>');
    if (callPending(v) && v.last_ring_at) {
      f.push(v.push_receipt_at && v.push_receipt_at >= v.last_ring_at
        ? `<span class="ok">📳 chegou no celular ${hm(v.push_receipt_at)}</span>`
        : v.driver_online ? '<span class="ok">📳 tocando na página aberta</span>' : '<span class="wn">⏳ confirmando entrega no celular…</span>');
    }
    if (v.status === 'CONFIRMADO') f.push(`<span class="ok">✔ respondeu "estou indo" ${hm(v.confirmed_at)}</span>`);
    if (msgPending(v)) f.push(`<span class="wn">📣 ${esc(v.msg.label)}${v.msg.place ? ` → ${esc(v.msg.place)}` : ''} ${hm(v.msg.at)} — sem resposta</span>`);
    else if (v.msg && v.msg.acked_at) f.push(`<span class="ok">✔ respondeu "${esc(v.msg.label)}" ${hm(v.msg.acked_at)}</span>`);
    if (v.next_op) f.push(`<span class="nx">➜ depois vai para a ${NAME[v.next_op]}</span>`);
    if ((v.leg || 1) > 1) f.push(`<span class="nx">↩ veio do ${NAME[other(v.op_type)]}${v.prev_dock ? ` (${esc(v.prev_dock)})` : ''}</span>`);
    return `<div class="fl">${f.join('')}</div>`;
  }
  function dockGrid(v, action, extra = '') {
    const busy = busyDocks();
    return `<div class="docks">${S.docks.map((d) => `<button class="dock" data-a="${action}" data-id="${v.id}" data-place="${esc(d.name)}"${extra}>${esc(d.name)}${d.name === v.dock ? '<small>atual</small>' : busy[d.name] ? `<small>${busy[d.name]} em uso</small>` : ''}</button>`).join('')}</div>`;
  }
  function placeGrid(v, reason, optional) {
    const places = [...(v.dock ? [v.dock] : []), ...S.cfg.offices];
    return `<div class="docks">${places.map((p) => `<button class="dock" data-a="msg" data-id="${v.id}" data-reason="${reason}" data-place="${esc(p)}">${esc(p)}${p === v.dock ? '<small>doca atual</small>' : ''}</button>`).join('')}
      ${optional ? `<button class="dock" data-a="msg" data-id="${v.id}" data-reason="${reason}" data-place="">SEM LOCAL</button>` : ''}</div>`;
  }
  function reasonGrid(v) {
    const list = Object.entries(S.cfg.reasons).filter(([, r]) => r.at.includes(v.status));
    return `<div class="reasons">${list.map(([k, r]) => {
      const a = r.place === 'dock' ? 'msg' : r.place === 'newdock' ? 'pick-move' : 'pick-place';
      const hint = r.place === 'dock' ? `na ${esc(v.dock)}` : r.place === 'newdock' ? 'escolher a nova doca' : r.place === 'optional' ? 'escrever o recado' : 'escolher o local';
      return `<button class="reason" data-a="${a}" data-reason="${k}" data-id="${v.id}">${esc(r.label)}<small>${hint}</small></button>`;
    }).join('')}</div>`;
  }

  function card(v) {
    const p = S.picker && S.picker.id === v.id ? S.picker : null;
    const otherName = NAME[other(v.op_type)];
    let acts = ''; let pk = ''; let when = '';
    if (v.status === 'AGUARDANDO') {
      when = `${(v.leg || 1) > 1 ? 'na fila desde' : 'chegou'} ${hm(v.queued_at || v.arrived_at)} · esperando ${dur(mins(v.queued_at || v.arrived_at))}`;
      acts = `<button class="btn tcall" data-a="pick-call" data-id="${v.id}">CHAMAR MOTORISTA</button>
        <button class="btn sm tsec" data-a="pick-reason" data-id="${v.id}">Recado</button>
        <button class="btn sm tsec" data-a="transfer" data-id="${v.id}">Passar p/ ${otherName}</button>`;
      if (p && p.kind === 'call') pk = `<div class="pk"><span class="lbl">Escolha a doca — o celular do motorista vibra na hora:</span>${dockGrid(v, 'call')}</div>`;
    } else if (v.status === 'CHAMADO' || v.status === 'CONFIRMADO') {
      when = `chamado ${hm(v.called_at)}${v.call_count > 1 ? ` · ${v.call_count} chamadas` : ''}`;
      acts = `<button class="btn sm tcall" data-a="recall" data-id="${v.id}">Rechamar</button>
        <button class="btn sm tsec" data-a="pick-call" data-id="${v.id}">Trocar doca</button>
        <button class="btn sm tok" data-a="docked" data-id="${v.id}">Encostou na doca</button>
        <button class="btn sm tno" data-a="uncall" data-id="${v.id}">Voltar para a fila</button>`;
      if (p && p.kind === 'call') pk = `<div class="pk"><span class="lbl">Nova doca — o motorista é chamado de novo:</span>${dockGrid(v, 'call')}</div>`;
    } else if (v.status === 'NA_DOCA') {
      when = `na doca desde ${hm(v.docked_at)} · ${dur(mins(v.docked_at))}`;
      acts = `<button class="btn tcall" data-a="pick-reason" data-id="${v.id}">CHAMAR MOTORISTA</button>
        ${v.next_op ? `<button class="btn tnext" data-a="transfer" data-id="${v.id}">ENVIAR P/ ${otherName.toUpperCase()}</button>` : ''}
        <button class="btn sm tok" data-a="finish" data-id="${v.id}">Liberar saída</button>
        ${v.next_op ? '' : `<button class="btn sm tsec" data-a="transfer" data-id="${v.id}">Enviar p/ ${otherName}</button>`}`;
      if (p && p.kind === 'move') pk = `<div class="pk"><span class="lbl">Para qual doca o caminhão vai?</span>${dockGrid(v, 'msg', ' data-reason="MUDAR"')}</div>`;
    }
    if (p && p.kind === 'reason') pk = `<div class="pk"><span class="lbl">${v.status === 'NA_DOCA' ? 'Por que chamar o motorista?' : 'Qual recado? O celular vibra até ele responder:'}</span>${reasonGrid(v)}</div>`;
    if (p && p.kind === 'place') {
      const r = S.cfg.reasons[p.reason] || {};
      pk = `<div class="pk"><span class="lbl">${esc(r.label || '')} — para onde o motorista deve ir?</span>
        ${p.reason === 'OUTRO' ? `<input class="txt" id="msgText" maxlength="120" placeholder="Escreva o recado (ex.: Aguarde a conferência da carga)" value="${esc(p.text || '')}">` : ''}
        ${placeGrid(v, p.reason, r.place === 'optional')}</div>`;
    }
    return `<article class="tv ${pending(v) || msgPending(v) ? 'hot' : ''}">
      <div><span class="pl">${esc(v.plate)}</span>${v.dock ? `<span class="dk">${esc(v.dock)}</span>` : ''}
        <div class="ln">${esc(v.driver_name)} · ${esc(v.carrier)} · ${esc(v.auth_code)}<br>${esc(v.cargo)}${v.partner ? ` · ${esc(v.partner)}` : ''}<br>${when}</div>
        ${flags(v)}<div class="cts">${contact(v)}</div></div>
      <div class="acts">${acts}</div>${pk}</article>`;
  }

  function render() {
    if ($('#app').hidden) return;
    // Enquanto alguém digita um recado, não redesenha a lista (perderia o cursor); só atualiza o alerta.
    if (document.activeElement && document.activeElement.id === 'msgText') return renderAlert(mine());
    const keepText = $('#msgText') ? $('#msgText').value : null;
    const m = mine();
    const q = m.filter((v) => v.status === 'AGUARDANDO').sort((a, b) => (a.queued_at || a.arrived_at).localeCompare(b.queued_at || b.arrived_at));
    const c = m.filter((v) => v.status === 'CHAMADO' || v.status === 'CONFIRMADO').sort((a, b) => (a.called_at || '').localeCompare(b.called_at || ''));
    const d = m.filter((v) => v.status === 'NA_DOCA').sort((a, b) => (a.docked_at || '').localeCompare(b.docked_at || ''));
    $('#nQueue').textContent = q.length; $('#nComing').textContent = c.length; $('#nDock').textContent = d.length;
    $('#tQueue').innerHTML = q.map(card).join('') || '<div class="empty">Nenhum caminhão esperando. Quando a portaria lançar um (ou a outra equipe passar um para vocês), ele aparece aqui e a tela avisa.</div>';
    $('#tComing').innerHTML = c.map(card).join('') || '<div class="empty">Ninguém chamado no momento.</div>';
    $('#tDock').innerHTML = d.map(card).join('') || '<div class="empty">Nenhum caminhão na doca. Use "Encostou na doca" quando o caminhão chegar.</div>';
    if (keepText !== null && $('#msgText')) { $('#msgText').value = keepText; }
    renderAlert(m);
  }

  function renderAlert(m) {
    // Problemas de entrega primeiro: são os que fazem um caminhão "sumir".
    const p = m.filter(pending).sort((a, b) => (PROBLEM.includes(b.team_alert_kind) - PROBLEM.includes(a.team_alert_kind)) || a.team_alert_at.localeCompare(b.team_alert_at));
    const box = $('#alert');
    if (!p.length) { box.hidden = true; stopBeep(); document.title = `${LABEL[S.team]} · Pátio Push`; return; }
    const v = p[0];
    const prob = PROBLEM.includes(v.team_alert_kind);
    box.className = 'alert ' + S.team + (prob ? ' prob' : ''); box.hidden = false;
    let kind = KIND[v.team_alert_kind] || 'ATENÇÃO';
    if (v.team_alert_kind === 'TRANSFERIDO') kind = `VEIO DO ${LABEL[other(v.op_type)]} — CHAMAR`;
    $('#aKind').textContent = kind;
    $('#aDock').textContent = v.team_alert_kind === 'NOVA_CHEGADA' || v.team_alert_kind === 'TRANSFERIDO' ? 'CHAMAR' : (msgPending(v) && v.msg.place ? v.msg.place : v.dock || '');
    $('#aPlate').textContent = v.plate;
    $('#aInfo').innerHTML = prob
      ? `${esc(v.driver_name)} · ${esc(v.carrier)}<br><b>${v.team_alert_kind === 'NAO_RECEBEU' ? 'A notificação não chegou no celular (sem internet, notificações bloqueadas ou celular desligado).' : 'A chamada chegou, mas o motorista ainda não respondeu.'}</b><br>Avise por outro meio:<div class="a-ct">${contact(v, true)}</div>`
      : `${esc(v.carrier)} · ${esc(v.driver_name)}<br><b>${esc(v.cargo)}</b>${v.partner ? ` · ${esc(v.partner)}` : ''}<br>Autorização ${esc(v.auth_code)}`;
    $('#aMore').textContent = p.length > 1 ? `+ ${p.length - 1} aviso(s) aguardando ciência` : '';
    $('#ackBtn').dataset.id = v.id;
    $('#ackBtn').textContent = prob ? 'CIENTE — VOU AVISAR' : 'CIENTE';
    document.title = `🔴 ${v.plate} · ${kind}`;
    startBeep();
  }

  $('#ackBtn').onclick = async () => {
    const id = Number($('#ackBtn').dataset.id);
    try { const v = await api(`/visits/${id}/team-ack`, { team: S.team }); S.visits.set(v.id, v); render(); } catch (e) { toast(e.message, 'err'); }
  };

  $('#app').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'msgText') e.preventDefault(); });
  $('#app').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const v = S.visits.get(Number(b.dataset.id)); if (!v) return;
    const a = b.dataset.a;
    if (a.startsWith('pick-')) {
      const kind = a.slice(5);
      const same = S.picker && S.picker.id === v.id && S.picker.kind === kind && !b.dataset.reason;
      S.picker = same ? null : { id: v.id, kind, reason: b.dataset.reason || null };
      if (kind === 'call' || kind === 'move') S.docks = await api('/docks').catch(() => S.docks);
      return render();
    }
    const report = (r, what) => {
      const d = r.delivery; if (!d) return;
      const ok = d.page_open || d.push.delivered_to_push_service > 0;
      toast(`${v.driver_name} ${what}: ${ok ? [d.page_open ? 'página aberta tocando' : '', d.push.delivered_to_push_service ? 'notificação enviada — confirmando entrega no celular' : ''].filter(Boolean).join(' + ') : `SEM CONEXÃO com o celular — use o WhatsApp ou ligue ${fmtPhone(v.phone)}`}`, ok ? 'ok' : 'err');
    };
    if (a === 'finish' && v.next_op && !confirm(`${v.plate} ainda vai para a ${NAME[v.next_op]}. Liberar a saída mesmo assim?\n\nPara mandar para a ${NAME[v.next_op]}, use "ENVIAR P/ ${NAME[v.next_op].toUpperCase()}".`)) return;
    if (a === 'transfer' && !confirm(`Passar ${v.plate} para a ${NAME[other(v.op_type)]}?\n\n${v.status === 'NA_DOCA' ? `O motorista recebe o aviso para liberar a ${v.dock} e aguardar no pátio. ` : ''}A tela da ${NAME[other(v.op_type)]} vai piscar para chamar.`)) return;
    const text = a === 'msg' && b.dataset.reason === 'OUTRO' ? ($('#msgText') ? $('#msgText').value.trim() : '') : undefined;
    if (a === 'msg' && b.dataset.reason === 'OUTRO' && (!text || text.length < 3)) { toast('Escreva o recado antes de escolher o local.', 'err'); $('#msgText') && $('#msgText').focus(); return; }
    S.picker = null; b.disabled = true;
    try {
      if (a === 'call') report(await api(`/visits/${v.id}/call`, { dock: b.dataset.place }), `chamado para ${b.dataset.place}`);
      if (a === 'recall') report(await api(`/visits/${v.id}/recall`, {}), 'chamado de novo');
      if (a === 'uncall') await api(`/visits/${v.id}/uncall`, {});
      if (a === 'docked') { await api(`/visits/${v.id}/docked`, {}); toast(`${v.plate} na ${v.dock}.`, 'ok'); }
      if (a === 'finish') { await api(`/visits/${v.id}/finish`, {}); toast(`${v.plate} liberado. A portaria registra a saída.`, 'ok'); }
      if (a === 'transfer') { await api(`/visits/${v.id}/transfer`, {}); toast(`${v.plate} passado para a ${NAME[other(v.op_type)]}.`, 'ok'); }
      if (a === 'msg') {
        const r = S.cfg.reasons[b.dataset.reason] || {};
        report(await api(`/visits/${v.id}/message`, { reason: b.dataset.reason, place: b.dataset.place || '', text }), `chamado (${r.label || 'recado'}${b.dataset.place ? ` → ${b.dataset.place}` : ''})`);
      }
    } catch (err) { toast(err.message, 'err'); } finally { b.disabled = false; render(); }
  });

  // Mantém o servidor gratuito acordado enquanto esta tela estiver aberta, e atualiza os tempos de espera.
  setInterval(() => { if (!$('#app').hidden) fetch('/health', { cache: 'no-store' }).catch(() => {}); }, 4 * 60e3);
  setInterval(() => { if (!S.picker) render(); }, 30000);
  setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('pt-BR', { timeZone: TZ }); }, 1000);
  boot();
})();
