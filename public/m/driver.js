'use strict';
/* Página do motorista: identifica, ativa alertas (gesto obrigatório), recebe a chamada em tempo real
   (SSE), vibra/toca enquanto não confirmar e envia "ESTOU INDO". Web Push cobre a tela bloqueada. */
(() => {
  const $ = (s) => document.querySelector(s);
  const KEY = 'pp_token';
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const S = { token: null, state: null, es: null, alarm: null, wake: null, audio: null, swReg: null, live: false, lastCall: 0 };

  // ---------- token (via QR individual ?t=... ou identificação) ----------
  const qs = new URLSearchParams(location.search);
  if (qs.get('t')) { try { localStorage.setItem(KEY, qs.get('t')); } catch { /* sem storage */ } history.replaceState(null, '', '/m/'); }
  try { S.token = localStorage.getItem(KEY) || qs.get('t'); } catch { S.token = qs.get('t'); }

  const show = (id) => ['vIdent', 'vActivate', 'vMain'].forEach((v) => { $('#' + v).hidden = v !== id; });

  async function api(path, body) {
    const r = await fetch('/api' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || 'Falha de conexão'), { status: r.status });
    return d;
  }

  async function boot() {
    if (!S.token) return show('vIdent');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).then((r) => { S.swReg = r; }).catch(() => {});
    try {
      const st = await api('/driver/state?t=' + encodeURIComponent(S.token));
      S.state = st;
      $('#helloName').textContent = `Olá, ${st.first_name}!`;
      if (['ATENDIDO', 'FINALIZADO', 'CANCELADO'].includes(st.status)) { show('vMain'); render(); connect(); return; }
      $('#activateBtn').textContent = 'ATIVAR ALERTAS';
      show('vActivate');
    } catch (e) {
      if (e.status === 404) { try { localStorage.removeItem(KEY); } catch { /* */ } S.token = null; show('vIdent'); $('#identErr').textContent = 'Seu acesso anterior terminou. Identifique-se novamente.'; }
      else { show('vIdent'); $('#identErr').textContent = 'Sem conexão com a portaria. Verifique a internet do celular.'; }
    }
  }

  $('#identForm').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#identErr').textContent = '';
    const f = new FormData(e.target);
    try {
      const r = await api('/driver/identify', { plate: f.get('plate'), phone4: f.get('phone4') });
      S.token = r.token; try { localStorage.setItem(KEY, r.token); } catch { /* */ }
      boot();
    } catch (err) { $('#identErr').textContent = err.message; }
  });

  // ---------- ativação (precisa do toque do motorista) ----------
  $('#activateBtn').addEventListener('click', async () => {
    // 1) vibração e som só são liberados após um gesto do usuário
    try { navigator.vibrate && navigator.vibrate(150); } catch { /* */ }
    try { S.audio = new (window.AudioContext || window.webkitAudioContext)(); await S.audio.resume(); } catch { S.audio = null; }
    // 2) manter a tela ligada enquanto espera (aumenta muito a chance de vibrar)
    await keepAwake();
    // 3) notificação + Web Push (para tela bloqueada / página em segundo plano)
    await enablePush();
    show('vMain'); render(); connect();
  });

  async function keepAwake() {
    try { if ('wakeLock' in navigator) { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener('release', () => { S.wake = null; renderChecks(); }); } } catch { S.wake = null; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !S.wake && S.audio) keepAwake().then(renderChecks); if (!document.hidden) refresh(); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (ev) => { if (ev.data && ev.data.type === 'push') refresh(); });
  }

  async function enablePush() {
    if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
    try {
      S.swReg = await navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' });
      const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (perm !== 'granted' || !('PushManager' in window)) return;
      const { publicKey } = await api('/push/key');
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
      await api('/driver/push-subscribe', { token: S.token, subscription: sub.toJSON() });
    } catch (e) { console.warn('push indisponível:', e); }
  }
  function b64ToU8(b) { const p = '='.repeat((4 - (b.length % 4)) % 4); const s = atob((b + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }

  // ---------- tempo real ----------
  function connect() {
    if (S.es) S.es.close();
    const es = new EventSource('/api/driver/stream?t=' + encodeURIComponent(S.token));
    S.es = es;
    es.onopen = () => { S.live = true; renderChecks(); };
    es.onerror = () => { S.live = false; renderChecks(); };
    es.addEventListener('state', (ev) => { S.state = JSON.parse(ev.data); render(); });
    es.addEventListener('call', () => { S.lastCall = 0; S.alarmKey = null; stopAlarm(); refresh(); });
  }
  async function refresh() { if (!S.token) return; try { S.state = await api('/driver/state?t=' + encodeURIComponent(S.token)); render(); } catch { /* */ } }
  setInterval(() => { if (!S.live) refresh(); }, 15000);

  // ---------- alarme (vibração + som repetidos até "ESTOU INDO") ----------
  function startAlarm() {
    if (S.alarm) return;
    const t0 = Date.now();
    const ring = () => {
      try { navigator.vibrate && navigator.vibrate([800, 250, 800, 250, 1200]); } catch { /* */ }
      beep();
      // Com o celular bloqueado ou em outro app, quem avisa é a notificação enviada pelo servidor (repete a cada 30 s).
      if (document.hidden && !S.state.push_enabled && Notification.permission === 'granted' && S.swReg && Date.now() - S.lastCall > 20000) {
        S.lastCall = Date.now();
        S.swReg.showNotification(`CHAMADA: ${S.state.dock}`, { body: `${$('#headline').textContent}. ${$('#subline').textContent}`, tag: 'chamada', renotify: true, requireInteraction: true, vibrate: [800, 250, 800, 250, 1200] }).catch(() => {});
      }
    };
    ring();
    const loop = () => { S.alarm = setTimeout(() => { ring(); loop(); }, Date.now() - t0 < 120000 ? 3500 : 15000); };
    loop();
  }
  function stopAlarm() { clearTimeout(S.alarm); S.alarm = null; try { navigator.vibrate && navigator.vibrate(0); } catch { /* */ } }
  function beep() {
    const a = S.audio; if (!a) return;
    try {
      [0, 0.35, 0.7].forEach((t) => {
        const o = a.createOscillator(); const g = a.createGain();
        o.type = 'square'; o.frequency.value = 1046; g.gain.value = 0.18;
        o.connect(g); g.connect(a.destination); o.start(a.currentTime + t); o.stop(a.currentTime + t + 0.22);
      });
    } catch { /* */ }
  }

  $('#ackBtn').addEventListener('click', async () => {
    stopAlarm();
    $('#ackBtn').disabled = true;
    try { S.state = await api('/driver/ack', { token: S.token }); render(); }
    catch { $('#subline').textContent = 'Não foi possível confirmar (sem internet?). Siga para a doca e avise a equipe.'; }
    finally { $('#ackBtn').disabled = false; }
  });

  // ---------- tela ----------
  const TYPE = { RECEBIMENTO: 'Recebimento', EXPEDICAO: 'Expedição' };
  // Textos da chamada feita com o caminhão já na doca.
  const DOCK_CALL = {
    CONCLUIDO: { head: 'RETIRE O CAMINHÃO', text: (d) => `Carga/descarga concluída. Retire o caminhão da ${d}.` },
    CAMINHAO: { head: 'VÁ ATÉ O CAMINHÃO', text: (d) => `Compareça ao seu caminhão na ${d}.` },
    DOCUMENTOS: { head: 'LEVE OS DOCUMENTOS', text: (d) => `Apresente a nota fiscal / documentos na ${d}.` },
    MUDAR: { head: 'MUDE DE DOCA', text: (d) => `Leve o caminhão para a ${d}.` },
  };
  // Uma "chave" por chamada: quando muda, o alarme recomeça do zero.
  const callKey = (s) => (s.status === 'CHAMADO' ? 'c' + s.call_count : s.dock_call_pending && s.dock_call ? 'd' + s.dock_call.at : null);

  function render() {
    const s = S.state; if (!s) return;
    $('#iAuth').textContent = s.auth_code; $('#iPlate').textContent = s.plate; $('#iType').textContent = TYPE[s.op_type] || s.op_type;
    const box = $('#state'); const ack = $('#ackBtn');
    const set = (cls, k, h, sub, title) => { box.className = 'state ' + cls; $('#kicker').textContent = k; $('#headline').textContent = h; $('#subline').textContent = sub; document.title = title; };
    ack.hidden = true;
    if (s.status === 'AGUARDANDO') {
      set('wait', 'AGUARDE SUA CHAMADA', s.position ? `${s.position}º na fila` : 'Você está na fila', `O ${s.team || 'time'} vai chamar você. O celular vai vibrar e tocar.`, 'Aguardando chamada');
    } else if (s.status === 'CHAMADO') {
      set('call', s.call_count > 1 ? `CHAMADA REPETIDA (${s.call_count}ª)` : 'SUA VEZ!', `COMPAREÇA À ${s.dock}`, `Caminhão ${s.plate}`, `🔔 ${s.dock}`);
      ack.hidden = false;
    } else if (s.status === 'CONFIRMADO') {
      set('go', 'CONFIRMADO', `Siga para a ${s.dock}`, `O ${s.team || 'time'} recebeu sua confirmação.`, `A caminho da ${s.dock}`);
    } else if (s.status === 'NA_DOCA') {
      if (s.dock_call_pending && s.dock_call) {
        const r = DOCK_CALL[s.dock_call.reason] || DOCK_CALL.CAMINHAO;
        set('call', 'CHAMADO NA DOCA', s.dock_call.reason === 'MUDAR' ? `VÁ PARA A ${s.dock}` : r.head, r.text(s.dock), `🔔 ${r.head}`);
        ack.hidden = false;
      } else {
        set('dock', 'NA DOCA', s.dock, 'Aguarde com esta tela aberta: a equipe pode chamar você aqui.', `Na ${s.dock}`);
      }
    } else {
      const done = s.status === 'FINALIZADO' || s.status === 'ATENDIDO';
      set('end', done ? 'SAÍDA LIBERADA' : 'AUTORIZAÇÃO ENCERRADA', done ? 'Bom trabalho!' : 'Procure a portaria', 'Você já pode fechar esta página.', done ? 'Saída liberada' : 'Encerrado');
      if (S.es) S.es.close();
      try { localStorage.removeItem(KEY); } catch { /* */ }
    }
    const key = callKey(s);
    if (key) { if (S.alarmKey !== key) { stopAlarm(); S.alarmKey = key; } startAlarm(); } else { stopAlarm(); S.alarmKey = null; }
    renderChecks();
  }

  function renderChecks() {
    const s = S.state || {};
    const items = [];
    const done = ['ATENDIDO', 'FINALIZADO', 'CANCELADO'].includes(s.status);
    if (!done) {
      items.push([S.live, S.live ? 'Conectado à portaria (internet ok)' : 'Sem conexão — verifique a internet do celular']);
      if ('vibrate' in navigator) items.push([!!S.audio, S.audio ? 'Vibração e som ativados' : 'Toque em ATIVAR ALERTAS para vibrar']);
      else items.push([false, isIOS ? 'iPhone não vibra por páginas web: deixe o volume alto e esta tela aberta' : 'Este navegador não permite vibrar: deixe o volume alto']);
      const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
      items.push([perm === 'granted' || s.push_enabled, perm === 'granted' ? 'Notificações permitidas (avisa com tela bloqueada)'
        : isIOS && !standalone ? 'iPhone: para avisar com tela bloqueada, use Compartilhar → Adicionar à Tela de Início'
          : perm === 'denied' ? 'Notificações bloqueadas — mantenha esta tela aberta' : 'Notificações não ativadas — mantenha esta tela aberta']);
      if (pushMode() !== 'ok') items.push([!!S.wake, S.wake ? 'Tela mantida ligada' : 'A tela pode apagar — evite bloquear o celular']);
    }
    $('#checks').innerHTML = items.map(([ok, t]) => `<li class="${ok ? '' : 'no'}">${t}</li>`).join('');
    $('#checks').hidden = !items.length;
    renderPushBox(done);
  }

  // ---------- quadro "chamada com o celular bloqueado" ----------
  function pushMode() {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return isIOS && !standalone ? 'ios-home' : 'unsupported';
    if (isIOS && !standalone) return 'ios-home';
    const p = Notification.permission;
    if (p === 'granted' && S.state && S.state.push_enabled) return 'ok';
    if (p === 'denied') return 'denied';
    return 'ask';
  }
  function renderPushBox(done) {
    if (!$('#pushBox')) { const d = document.createElement('div'); d.id = 'pushBox'; d.className = 'card pushbox'; $('#checks').before(d); }
    if (!$('#footNote')) { const n = document.createElement('p'); n.id = 'footNote'; n.className = 'note'; $('#checks').after(n); }
    const box = $('#pushBox');
    if (done) { box.hidden = true; $('#footNote').textContent = ''; return; }
    const mode = pushMode();
    box.hidden = false;
    box.className = 'card pushbox ' + (mode === 'ok' ? 'ok' : 'bad');
    const html = {
      ok: `<h3>✔ Pode bloquear o celular</h3>
        <div>Pode usar outros aplicativos ou bloquear a tela. A chamada chega como <b>notificação com vibração</b> e se repete até você responder. Dá para tocar em <b>ESTOU INDO</b> direto na notificação.</div>
        <button class="btn alt" id="testBtn">TESTAR AVISO</button><p class="msg" id="testMsg"></p>`,
      ask: `<h3>⚠ Falta permitir as notificações</h3>
        <div>Sem isso, você <b>só é chamado com esta página aberta na tela</b>.</div>
        <button class="btn" id="permBtn">PERMITIR NOTIFICAÇÕES</button>`,
      denied: `<h3>⚠ Notificações bloqueadas</h3>
        <div>Você <b>só será chamado com esta página aberta na tela</b>. Para liberar:</div>
        <ol><li>Toque no <b>cadeado</b> (ou nos ⋮ três pontos) ao lado do endereço do site.</li>
        <li>Toque em <b>Permissões</b> ou <b>Configurações do site</b> → <b>Notificações</b> → <b>Permitir</b>.</li>
        <li>Volte aqui e toque no botão abaixo.</li></ol>
        <button class="btn" id="permBtn">JÁ LIBEREI</button>`,
      'ios-home': `<h3>⚠ iPhone: falta um passo</h3>
        <div>Para ser chamado com o celular bloqueado:</div>
        <ol><li>Toque em <b>Compartilhar</b> (quadrado com seta ↑) no Safari.</li>
        <li>Toque em <b>Adicionar à Tela de Início</b> → <b>Adicionar</b>.</li>
        <li>Abra pelo novo ícone <b>P</b>, informe placa e celular e toque em <b>ATIVAR ALERTAS</b> → <b>Permitir</b>.</li></ol>
        <div>Até lá, deixe esta página aberta e o volume alto.</div>`,
      unsupported: `<h3>⚠ Este navegador não recebe notificações</h3>
        <div>Abra o link no <b>Chrome</b> ou deixe esta página aberta na tela, com volume alto.</div>`,
    }[mode];
    if (box.dataset.mode !== mode) { box.innerHTML = html; box.dataset.mode = mode; }
    $('#footNote').textContent = mode === 'ok'
      ? 'Não feche o navegador "à força" (arrastando da lista de apps) e mantenha a internet ligada. Celular no silencioso ou em "Não perturbe" pode não vibrar.'
      : 'Mantenha esta página aberta, com internet ligada. Volume e vibração dependem das configurações do seu celular.';
  }
  document.addEventListener('click', async (e) => {
    if (e.target.id === 'permBtn') {
      await enablePush(); await refresh(); $('#pushBox').dataset.mode = ''; renderChecks();
    } else if (e.target.id === 'testBtn') {
      const msg = $('#testMsg');
      try {
        await api('/driver/test-push', { token: S.token });
        msg.textContent = 'Agora BLOQUEIE o celular. Em 10 segundos chega a notificação de teste.';
      } catch (err) { msg.textContent = err.message; }
    }
  });

  boot();
})();
