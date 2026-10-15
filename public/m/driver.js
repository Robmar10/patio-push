'use strict';
/* Página do motorista: identifica, ativa alertas, recebe chamadas e recados em tempo real (SSE) e por
   notificação (Web Push, funciona com o celular bloqueado ou em outro app), vibra/toca até ele responder
   e envia "ESTOU INDO". */
(() => {
  const $ = (s) => document.querySelector(s);
  const KEY = 'pp_token';
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const hasNotif = 'Notification' in window && 'serviceWorker' in navigator;
  const S = { token: null, state: null, es: null, alarm: null, alarmKey: null, wake: null, audio: null, live: false, pushErr: '' };

  // ---------- token (via QR individual ?t=... ou identificação) ----------
  const qs = new URLSearchParams(location.search);
  // Entrou pelo CARTAZ fixo (sem link individual e sem vir de uma notificação): se este celular já tiver
  // um acesso salvo, pergunta "É você?" antes de mostrar — nunca mostra a entrada de outro motorista.
  const fromCartaz = !qs.get('t') && !qs.get('n');
  if (qs.get('n')) history.replaceState(null, '', '/m/');
  if (qs.get('t')) {
    try { localStorage.setItem(KEY, qs.get('t')); } catch { /* sem storage */ }
    // No iPhone o link fica na barra: o ícone "Adicionar à Tela de Início" abre com o acesso do motorista.
    if (!(isIOS && !standalone)) history.replaceState(null, '', '/m/');
  }
  try { S.token = localStorage.getItem(KEY) || qs.get('t'); } catch { S.token = qs.get('t'); }

  const show = (id) => ['vIdent', 'vConfirm', 'vActivate', 'vMain'].forEach((v) => { $('#' + v).hidden = v !== id; });
  const OPNAME = { DESCARREGAR: 'DESCARGA', CARREGAR: 'CARGA' };
  const whoHtml = (st) => `<b>${escapeHtml(st.first_name)}</b><span class="pl">${escapeHtml(st.plate)}</span>
    Autorização ${escapeHtml(st.auth_code)}<br><span class="op ${st.action}">${OPNAME[st.action] || ''} · ${escapeHtml(st.team)}</span>`;
  // Já confirmado nesta aba (ex.: recarregou a página): não pergunta de novo. Uma leitura nova do cartaz abre aba nova.
  const SKEY = 'pp_ok';
  const okHere = () => { try { return !!S.token && sessionStorage.getItem(SKEY) === S.token; } catch { return false; } };
  const markOk = () => { try { if (S.token) sessionStorage.setItem(SKEY, S.token); } catch { /* */ } };
  let confirmed = !fromCartaz || okHere();
  if (confirmed) markOk();

  async function api(path, body) {
    const r = await fetch('/api' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || 'Falha de conexão'), { status: r.status });
    return d;
  }

  function bindToken() {
    const link = document.querySelector('link[rel=manifest]');
    if (link && S.token) link.href = '/m/manifest.webmanifest?t=' + encodeURIComponent(S.token);
    if ('serviceWorker' in navigator && S.token) {
      navigator.serviceWorker.ready.then((reg) => reg.active && reg.active.postMessage({ type: 'token', token: S.token })).catch(() => {});
    }
  }

  async function boot() {
    if (!S.token) return show('vIdent');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).catch(() => {});
    try {
      const st = await api('/driver/state?t=' + encodeURIComponent(S.token));
      S.state = st;
      bindToken();
      $('#helloName').textContent = `Olá, ${st.first_name}!`;
      if (['ATENDIDO', 'FINALIZADO', 'CANCELADO'].includes(st.status)) {
        if (fromCartaz && !confirmed) { forget(); return show('vIdent'); } // acesso antigo: identificar de novo
        show('vMain'); render(); connect(); return;
      }
      $('#activateWho').innerHTML = whoHtml(st);
      if (!confirmed && okHere()) confirmed = true;
      if (confirmed) markOk();
      if (!confirmed) { $('#confirmWho').innerHTML = whoHtml(st); return show('vConfirm'); }
      // Já permitiu antes (ex.: abriu pela notificação): vai direto, sem pedir de novo.
      if (hasNotif && Notification.permission === 'granted') {
        await syncPush(!!st.push_error); // envio falhou antes: renova a inscrição sozinho
        show('vMain'); render(); connect();
        return;
      }
      show('vActivate');
    } catch (e) {
      if (e.status === 404) { try { localStorage.removeItem(KEY); } catch { /* */ } S.token = null; show('vIdent'); $('#identErr').textContent = 'Seu acesso anterior terminou. Identifique-se novamente.'; }
      else { show('vIdent'); $('#identErr').textContent = 'Sem conexão com a portaria. Verifique a internet do celular.'; }
    }
  }

  function forget() {
    try { localStorage.removeItem(KEY); } catch { /* */ }
    S.token = null; S.state = null; if (S.es) S.es.close();
    $('#identErr').textContent = '';
  }
  $('#confirmYes').addEventListener('click', () => { confirmed = true; boot(); });
  $('#confirmNo').addEventListener('click', () => { forget(); show('vIdent'); });

  $('#identForm').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#identErr').textContent = '';
    const f = new FormData(e.target);
    try {
      const r = await api('/driver/identify', { plate: f.get('plate'), phone4: f.get('phone4') });
      S.token = r.token; try { localStorage.setItem(KEY, r.token); } catch { /* */ }
      confirmed = true; // acabou de digitar placa + celular
      boot();
    } catch (err) { $('#identErr').textContent = err.message; }
  });

  // ---------- permissão de notificação ----------
  // Precisa ser chamada DIRETO no toque do motorista (antes de qualquer espera); senão alguns Android
  // tratam o pedido como "sem gesto" e bloqueiam ou escondem a pergunta.
  function askPermission() {
    if (!hasNotif) return Promise.resolve('unsupported');
    if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
    try {
      const p = Notification.requestPermission();
      return p && typeof p.then === 'function' ? p : Promise.resolve(Notification.permission);
    } catch { return Promise.resolve(Notification.permission); }
  }
  // Inscreve este celular para receber notificações (não pergunta nada se a permissão já foi dada).
  const sameKey = (sub, key) => {
    try {
      const a = new Uint8Array(sub.options.applicationServerKey || []);
      return a.length === key.length && a.every((x, i) => x === key[i]);
    } catch { return true; } // navegador não informa a chave: mantém a inscrição
  };
  async function syncPush(force) {
    S.pushErr = '';
    if (!hasNotif || Notification.permission !== 'granted' || !('PushManager' in window)) return false;
    try {
      await navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' });
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api('/push/key');
      const key = b64ToU8(publicKey);
      let sub = await reg.pushManager.getSubscription();
      // Inscrição antiga feita com outra chave do servidor (ou pedido de REATIVAR): o Google recusaria todas as
      // notificações em silêncio. Cancela e inscreve de novo com a chave atual.
      if (sub && (force || !sameKey(sub, key))) { try { await sub.unsubscribe(); } catch { /* */ } sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await api('/driver/push-subscribe', { token: S.token, subscription: sub.toJSON() });
      bindToken();
      if (S.state) S.state.push_enabled = true;
      return true;
    } catch (e) {
      S.pushErr = (e && (e.message || e.name)) || 'erro desconhecido';
      console.warn('push indisponível:', e);
      return false;
    }
  }
  function b64ToU8(b) { const p = '='.repeat((4 - (b.length % 4)) % 4); const s = atob((b + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }

  // ---------- ALARME SONORO EM SEGUNDO PLANO (não depende da permissão de notificação) ----------
  // O Chrome do Android não congela abas que estão tocando áudio. A página toca um som contínuo INAUDÍVEL
  // (25 Hz, volume baixíssimo): a aba continua viva e conectada com o celular bloqueado ou com outro app aberto.
  // Na chamada, um segundo áudio (alarme alto, que já está tocando sem som) é desmutado — não precisa de toque
  // nem de permissão. O cartão de mídia da tela de bloqueio mostra o que fazer (ex.: DESCARREGAR NA DOCA 04).
  const SOUND = { keep: null, alarm: null, on: false, err: '' };
  function wavUrl(seconds, rate, fn) {
    const n = Math.floor(seconds * rate); const buf = new ArrayBuffer(44 + n * 2); const d = new DataView(buf);
    const w = (o, t) => { for (let i = 0; i < t.length; i++) d.setUint8(o + i, t.charCodeAt(i)); };
    w(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true);
    d.setUint16(22, 1, true); d.setUint32(24, rate, true); d.setUint32(28, rate * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
    w(36, 'data'); d.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, Math.max(-1, Math.min(1, fn(i / rate))) * 32767, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  // alarme: bipes fortes alternando 1.150/880 Hz (0,22 s ligado / 0,12 s desligado), ciclo de 2,4 s
  const alarmWave = (t) => { const c = t % 0.34; if (c > 0.22) return 0; const f = Math.floor(t / 0.34) % 2 ? 880 : 1150; return 0.85 * Math.sign(Math.sin(2 * Math.PI * f * t)); };
  function setMedia(title, artist) {
    try {
      if (!('mediaSession' in navigator)) return;
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist: artist || 'Pátio Push — chamada do motorista', album: 'Portaria', artwork: [{ src: '/m/icon.svg', sizes: '512x512', type: 'image/svg+xml' }] });
      // Pausar pelo cartão de mídia desligaria o alarme: ignora (o motorista responde pela página).
      ['pause', 'stop'].forEach((a) => { try { navigator.mediaSession.setActionHandler(a, () => { SOUND.keep && SOUND.keep.play().catch(() => {}); }); } catch { /* */ } });
    } catch { /* */ }
  }
  // Precisa ser chamado dentro de um toque do motorista (regra de áudio dos navegadores).
  function startSoundMode() {
    if (SOUND.on || SOUND.keep) return;
    try {
      SOUND.keep = new Audio(wavUrl(2, 8000, (t) => 0.004 * Math.sin(2 * Math.PI * 25 * t)));
      SOUND.keep.loop = true;
      SOUND.alarm = new Audio(wavUrl(2.4, 16000, alarmWave));
      SOUND.alarm.loop = true; SOUND.alarm.muted = true;
      ['keep', 'alarm'].forEach((k) => SOUND[k].setAttribute('playsinline', ''));
      Promise.all([SOUND.keep.play(), SOUND.alarm.play()])
        .then(() => {
          SOUND.on = true; SOUND.err = '';
          if (S.alarmKey) soundAlarm(true, $('#headline').textContent, $('#subline').textContent); // já havia chamada pendente
          else setMedia('Aguardando chamada', 'Pátio Push — não feche esta aba');
          renderChecks();
        })
        .catch((e) => { SOUND.err = (e && e.name) || 'bloqueado'; SOUND.keep = null; SOUND.alarm = null; renderChecks(); });
      // Se o sistema pausar o áudio (ex.: ligação), retoma quando possível.
      SOUND.keep.addEventListener('pause', () => setTimeout(() => SOUND.keep && SOUND.keep.play().catch(() => {}), 1500));
    } catch (e) { SOUND.err = e.message; }
  }
  function soundAlarm(on, title, sub) {
    if (!SOUND.alarm) return;
    SOUND.alarm.muted = !on;
    if (on) { SOUND.alarm.currentTime = 0; if (SOUND.alarm.paused) SOUND.alarm.play().catch(() => {}); setMedia(`🔔 ${title}`, sub || 'Toque para abrir e responder ESTOU INDO'); }
  }
  function stopSoundMode() {
    ['keep', 'alarm'].forEach((k) => { try { SOUND[k] && SOUND[k].pause(); } catch { /* */ } SOUND[k] = null; });
    SOUND.on = false;
  }

  // ---------- ativação (precisa do toque do motorista) ----------
  function unlockAudio() {
    try { if (!S.audio) S.audio = new (window.AudioContext || window.webkitAudioContext)(); S.audio.resume(); } catch { S.audio = null; }
  }
  document.addEventListener('pointerdown', () => {
    if (!$('#vMain').hidden && S.state && !['FINALIZADO', 'CANCELADO', 'ATENDIDO'].includes(S.state.status)) startSoundMode();
    if (!S.audio) { unlockAudio(); renderChecks(); }
  }, { passive: true });

  $('#activateBtn').addEventListener('click', async () => {
    const perm = askPermission(); // 1º: o pedido de permissão, ainda dentro do toque
    startSoundMode(); // 2º: alarme sonoro em segundo plano (também precisa do toque)
    try { navigator.vibrate && navigator.vibrate(150); } catch { /* */ }
    unlockAudio();
    $('#activateBtn').disabled = true;
    await perm;
    await syncPush();
    keepAwake();
    $('#activateBtn').disabled = false;
    show('vMain'); render(); connect();
  });

  async function keepAwake() {
    try { if ('wakeLock' in navigator && !S.wake) { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener('release', () => { S.wake = null; renderChecks(); }); } } catch { S.wake = null; }
    renderChecks();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (S.audio) keepAwake();
    refresh();
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (ev) => { if (ev.data && ev.data.type === 'push') refresh(); });
  }

  // ---------- tempo real ----------
  function connect() {
    if (S.es) S.es.close();
    const es = new EventSource('/api/driver/stream?t=' + encodeURIComponent(S.token));
    S.es = es;
    es.onopen = () => { S.live = true; renderChecks(); };
    es.onerror = () => { S.live = false; renderChecks(); };
    es.addEventListener('state', (ev) => { S.state = JSON.parse(ev.data); render(); });
    es.addEventListener('call', () => { S.alarmKey = null; stopAlarm(); refresh(); });
  }
  async function refresh() { if (!S.token) return; try { S.state = await api('/driver/state?t=' + encodeURIComponent(S.token)); render(); } catch { /* */ } }
  setInterval(() => { if (!S.live && !$('#vMain').hidden) refresh(); }, 15000);

  // ---------- alarme da página aberta (vibração + som repetidos até "ESTOU INDO") ----------
  function startAlarm() {
    if (S.alarm) return;
    const t0 = Date.now();
    const ring = () => {
      if (!document.hidden) { try { navigator.vibrate && navigator.vibrate([800, 250, 800, 250, 1200]); } catch { /* */ } beep(); }
      // Com o celular bloqueado ou em outro app, quem avisa é a notificação do servidor (repete a cada 30 s).
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
    catch { $('#subline').textContent = 'Não foi possível confirmar (sem internet?). Vá até o local indicado e avise a equipe.'; }
    finally { $('#ackBtn').disabled = false; }
  });

  // ---------- tela ----------
  const TYPE = { DESCARREGAR: 'Descarga', CARREGAR: 'Carga' };
  // Uma "chave" por chamada: quando muda, o alarme recomeça do zero.
  const callKey = (s) => (s.status === 'CHAMADO' ? 'c' + s.call_count : s.msg && s.msg.pending ? 'm' + s.msg.at : null);

  function render() {
    const s = S.state; if (!s) return;
    $('#iAuth').textContent = s.auth_code; $('#iPlate').textContent = s.plate; $('#iType').textContent = TYPE[s.action] || s.team;
    const box = $('#state'); const ack = $('#ackBtn');
    const set = (cls, k, h, sub, title) => { box.className = 'state ' + cls; $('#kicker').textContent = k; $('#headline').textContent = h; $('#subline').textContent = sub; document.title = title; };
    ack.hidden = true;
    const team = s.team || 'equipe';
    const act = s.action || 'DESCARREGAR'; const actL = act.toLowerCase();
    const m = s.msg;
    if ((s.status === 'AGUARDANDO' || s.status === 'NA_DOCA') && m && m.pending) {
      set('call', s.status === 'NA_DOCA' ? 'CHAMADO NA DOCA' : 'RECADO DA EQUIPE', m.head, m.text, `🔔 ${m.head}`);
      ack.hidden = false;
    } else if (s.status === 'AGUARDANDO') {
      const pos = s.position ? `${s.position}º na fila` : 'Você está na fila';
      if (s.leg > 1) {
        set('wait', `AGUARDE PARA ${act}`, pos, s.prev_dock ? `Libere a ${s.prev_dock} e aguarde no pátio. A ${team} vai chamar você para ${actL}.` : `Agora quem chama você é a ${team}, para ${actL}.`, 'Aguardando chamada');
      } else {
        set('wait', `AGUARDE PARA ${act}`, pos, `O ${team} vai chamar você para ${actL}. O celular vai vibrar e tocar.`, 'Aguardando chamada');
      }
    } else if (s.status === 'CHAMADO') {
      set('call', s.call_count > 1 ? `CHAMADA REPETIDA (${s.call_count}ª)` : 'SUA VEZ!', `${act} NA ${s.dock}`, `Leve o caminhão ${s.plate} até a ${s.dock}.`, `🔔 ${act} ${s.dock}`);
      ack.hidden = false;
    } else if (s.status === 'CONFIRMADO') {
      set('go', 'CONFIRMADO', `Siga para a ${s.dock}`, `Para ${actL}. O ${team} recebeu sua confirmação.`, `A caminho da ${s.dock}`);
    } else if (s.status === 'NA_DOCA') {
      set('dock', `NA DOCA · ${OPNAME[act]}`, s.dock, s.next_team ? `Depois desta etapa você vai para a ${s.next_team}. A equipe avisa por aqui.` : 'A equipe pode chamar você por aqui (carga pronta, documentos, canhoto).', `Na ${s.dock}`);
    } else {
      const done = s.status === 'FINALIZADO' || s.status === 'ATENDIDO';
      if (done && !s.exited) set('go', 'SAÍDA LIBERADA', 'Pode sair', 'Apresente-se na portaria com o caminhão.', 'Saída liberada');
      else set('end', done ? 'SAÍDA REGISTRADA' : 'AUTORIZAÇÃO ENCERRADA', done ? 'Boa viagem!' : 'Procure a portaria', 'Você já pode fechar esta página.', done ? 'Boa viagem' : 'Encerrado');
      if (s.exited || !done) {
        stopSoundMode();
        if (S.es) S.es.close();
        try { localStorage.removeItem(KEY); } catch { /* */ }
      }
    }
    const key = callKey(s);
    if (key) {
      if (S.alarmKey !== key) { stopAlarm(); S.alarmKey = key; soundAlarm(true, $('#headline').textContent, $('#subline').textContent); }
      startAlarm();
    } else {
      stopAlarm(); S.alarmKey = null; soundAlarm(false);
      if (SOUND.on) setMedia($('#kicker').textContent, `${$('#headline').textContent} — não feche esta aba`);
    }
    renderChecks();
  }

  function renderChecks() {
    if ($('#vMain').hidden) return;
    const s = S.state || {};
    const items = [];
    const done = ['ATENDIDO', 'FINALIZADO', 'CANCELADO'].includes(s.status);
    if (!done) {
      items.push([S.live, S.live ? 'Conectado à portaria (internet ok)' : 'Sem conexão — verifique a internet do celular']);
      if ('vibrate' in navigator) items.push([!!S.audio, S.audio ? 'Som e vibração da página ativados' : 'Toque na tela uma vez para liberar o som']);
      else items.push([false, isIOS ? 'iPhone não vibra por páginas web: deixe o volume alto' : 'Este navegador não vibra: deixe o volume alto']);
      items.push([SOUND.on, SOUND.on ? 'Alarme sonoro ativo: toca com a tela bloqueada ou em outro app (não feche esta aba)'
        : SOUND.err ? 'Alarme sonoro bloqueado pelo navegador — toque na tela uma vez' : 'Toque na tela uma vez para ligar o alarme sonoro']);
    }
    $('#checks').innerHTML = items.map(([ok, t]) => `<li class="${ok ? '' : 'no'}">${t}</li>`).join('');
    $('#checks').hidden = !items.length;
    renderPushBox(done);
  }

  // ---------- quadro "chamada com o celular bloqueado" ----------
  function pushMode() {
    if (isIOS && !standalone) return 'ios-home';
    if (!hasNotif || !('PushManager' in window)) return 'unsupported';
    const p = Notification.permission;
    if (p === 'denied') return 'denied';
    if (p === 'granted') return S.state && S.state.push_enabled ? 'ok' : (S.pushErr || (S.state && S.state.push_error)) ? 'error' : 'ask';
    return 'ask';
  }
  function renderPushBox(done) {
    const box = $('#pushBox');
    if (done) { box.hidden = true; $('#footNote').textContent = ''; return; }
    const mode = pushMode();
    box.hidden = false;
    box.className = 'card pushbox ' + (mode === 'ok' || SOUND.on ? 'ok' : 'bad');
    const html = {
      ok: `<h3>✔ Pode bloquear o celular</h3>
        <div>Pode usar outros aplicativos ou bloquear a tela. A chamada chega como <b>notificação com vibração</b> e se repete até você responder. Dá para tocar em <b>ESTOU INDO</b> direto na notificação.</div>
        <button class="btn alt" id="testBtn">TESTAR AVISO</button><p class="msg" id="testMsg"></p>`,
      ask: `<h3>⚠ Falta permitir as notificações</h3>
        <div>${SOUND.on ? '🔊 O <b>alarme sonoro</b> já está ativo: pode sair desta tela ou bloquear o celular, <b>sem fechar esta aba</b>. ' : ''}Para receber também como notificação, toque no botão e depois em <b>Permitir</b>.</div>
        <button class="btn" id="permBtn">PERMITIR NOTIFICAÇÕES</button><p class="msg bad" id="permMsg"></p>`,
      error: `<h3>⚠ O celular não conseguiu ativar os avisos</h3>
        <div>As notificações não estão chegando neste celular (${escapeHtml(S.pushErr || (S.state && S.state.push_error) || '')}). Toque em <b>REATIVAR</b>. Se continuar, abra este link no <b>Chrome</b> e confira a internet.</div>
        <button class="btn" id="permBtn">REATIVAR AVISOS</button><p class="msg bad" id="permMsg"></p>`,
      denied: `<h3>${SOUND.on ? '🔊 Alarme sonoro ativo · notificações bloqueadas' : '⚠ Notificações bloqueadas neste navegador'}</h3>
        <div>${SOUND.on ? 'Você <b>será chamado pelo alarme sonoro</b>, mesmo com a tela bloqueada ou em outro app. <b>Não feche esta aba</b> e deixe o <b>volume de mídia alto</b>. Para receber também como notificação, libere:' : 'Toque na tela para ligar o alarme sonoro. Para receber também como notificação, libere:'}</div>
        <ol><li>Toque no ícone <b>à esquerda do endereço</b> do site (cadeado ou ajustes).</li>
        <li>Toque em <b>Permissões</b> → <b>Notificações</b> → ligue. Se aparecer, toque em <b>Redefinir permissões</b>.</li>
        <li>Não aparece ou está cinza? Em <b>Configurações do celular</b> → <b>Aplicativos</b> → <b>Chrome</b> (ou o navegador que abriu esta página) → <b>Notificações</b> → ligue.</li>
        <li>Volte e <b>recarregue a página</b> (puxe a tela para baixo).</li></ol>
        <button class="btn" id="permBtn">JÁ LIBEREI</button><p class="msg bad" id="permMsg"></p>`,
      'ios-home': `<h3>⚠ iPhone: falta um passo</h3>
        <div>Para ser chamado com o celular bloqueado:</div>
        <ol><li>Toque em <b>Compartilhar</b> (quadrado com seta ↑) no Safari.</li>
        <li>Toque em <b>Adicionar à Tela de Início</b> → <b>Adicionar</b>.</li>
        <li>Abra pelo novo ícone <b>Chamada</b> e toque em <b>ATIVAR ALERTAS</b> → <b>Permitir</b>.</li></ol>
        <div>Até lá, o alarme sonoro desta aba chama você: não feche a aba e deixe o volume alto.</div>`,
      unsupported: `<h3>⚠ Este navegador não recebe notificações</h3>
        <div>Abra o link no <b>Chrome</b> ou deixe esta página aberta na tela, com volume alto.</div>`,
    }[mode];
    const sig = mode + (SOUND.on ? '+som' : '') + (mode === 'error' ? (S.pushErr || (S.state && S.state.push_error) || '') : '');
    if (box.dataset.mode !== sig) { box.innerHTML = html; box.dataset.mode = sig; }
    $('#footNote').textContent = mode === 'ok'
      ? 'Não feche o navegador "à força" (arrastando da lista de apps) e mantenha a internet ligada. No silencioso ou em "Não perturbe" o celular pode não vibrar.'
      : 'Não feche esta aba (pode sair dela ou bloquear o celular). Internet ligada e VOLUME DE MÍDIA alto: é ele que toca o alarme.';
  }
  function escapeHtml(t) { return String(t || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  document.addEventListener('click', async (e) => {
    if (e.target.id === 'permBtn') {
      const perm = askPermission(); // ainda dentro do toque
      const msg = $('#permMsg');
      const p = await perm;
      if (p === 'denied') { if (msg) msg.textContent = 'Continua bloqueado. Siga os passos acima e recarregue a página.'; $('#pushBox').dataset.mode = ''; renderChecks(); return; }
      if (p !== 'granted') { if (msg) msg.textContent = 'O celular não mostrou a pergunta. Recarregue a página e toque de novo.'; return; }
      const ok = await syncPush(pushMode() === 'error');
      await refresh();
      $('#pushBox').dataset.mode = ''; renderChecks();
      if (!ok && $('#permMsg')) $('#permMsg').textContent = 'Não foi possível ativar. Tente de novo em instantes.';
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
