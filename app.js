/* Nexo Movilidad — app del vendedor (consulta). Sin dependencias.
   - El código de enlace (NEXO1.…) trae la clave de cifrado; se guarda cifrada con el PIN del vendedor.
   - Los datos (datos.json.enc, AES-256-GCM) se guardan tal como llegan y se descifran en memoria al desbloquear.
   - Fuente de datos: Dropbox (si config.js tiene la clave de aplicación) o «Abrir archivo» manual. */
'use strict';
const VERSION_APP = '0.1.0';
const CFG = window.NEXO_MOVIL || {};
const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = { a: (u8) => { let s = ''; u8.forEach(b => { s += String.fromCharCode(b); }); return btoa(s); }, d: (t) => Uint8Array.from(atob(t), c => c.charCodeAt(0)) };
const b64url = { d: (t) => b64.d(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4)), a: (u8) => b64.a(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
const hexA = (h) => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
const fmt = (n, d = 2) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString('es-VE', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtFecha = (iso) => { if (!iso) return '—'; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return m ? `${m[3]}/${m[2]}/${m[1]}` : iso; };
const fmtTS = (iso) => { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
let avisoT; function aviso(msg, error) { const a = $('#aviso'); a.textContent = msg; a.className = 'ver' + (error ? ' error' : ''); clearTimeout(avisoT); avisoT = setTimeout(() => { a.className = ''; }, error ? 5000 : 2500); }

/* ---------- Almacenamiento local (IndexedDB) ---------- */
let _db;
function bd() { return _db || (_db = new Promise((res, rej) => { const r = indexedDB.open('nexo-movil', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })); }
async function kvGet(k) { const d = await bd(); return new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function kvSet(k, v) { const d = await bd(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
async function kvDel(k) { const d = await bd(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }

/* ---------- Criptografía ---------- */
async function claveDePin(pin, sal) { const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']); return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: sal, iterations: 150000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
async function sellar(obj, ck) { const iv = crypto.getRandomValues(new Uint8Array(12)); const d = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ck, enc.encode(JSON.stringify(obj))); return { iv: b64.a(iv), d: b64.a(new Uint8Array(d)) }; }
async function abrir(sobre, ck) { const d = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.d(sobre.iv) }, ck, b64.d(sobre.d)); return JSON.parse(dec.decode(d)); }
// Archivo de Nexo: { f:1, n:versión de clave, iv, t:etiqueta, d } → WebCrypto espera texto cifrado + etiqueta juntos
async function descifrarArchivo(texto, claveHex) {
  let e; try { e = JSON.parse(texto); } catch (x) { throw new Error('El archivo no es un archivo de datos de Nexo'); }
  if (!e || e.f !== 1 || !e.iv || !e.t || !e.d) throw new Error('El archivo no es un archivo de datos de Nexo');
  const k = await crypto.subtle.importKey('raw', hexA(claveHex), 'AES-GCM', false, ['decrypt']);
  const cif = b64.d(e.d), tag = b64.d(e.t), junto = new Uint8Array(cif.length + tag.length); junto.set(cif); junto.set(tag, cif.length);
  try { return { enc: e, datos: JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.d(e.iv) }, k, junto))) }; }
  catch (x) { const er = new Error('No se pudo descifrar: el archivo no corresponde a este teléfono o la clave fue renovada. Pide a la oficina un nuevo código de enlace.'); er.codigo = 'clave'; throw er; }
}

/* ---------- Estado en memoria ---------- */
let cfg = null; // { empresa, s, n, vinculadoEn, salt, sec:{iv,d} } — sec = { k, refresh, raiz } cifrado con el PIN
let pinKey = null, sec = null, datos = null, recibido = null, vista = { pest: 'articulos', lista: '', q: '', cli: null, qc: '' };
let ultimoToque = Date.now(); const BLOQUEO_MS = 5 * 60 * 1000;
['click', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, () => { ultimoToque = Date.now(); }, { passive: true }));
setInterval(() => { if (pinKey && Date.now() - ultimoToque > BLOQUEO_MS) bloquear(); }, 15000);
function bloquear() { pinKey = null; sec = null; datos = null; vista = { pest: 'articulos', lista: '', q: '', cli: null, qc: '' }; pintar(); }

/* ---------- Pantallas ---------- */
const app = () => $('#app');
function pintar() {
  if (!cfg) return pantallaEnlace();
  if (!pinKey) return pantallaPin();
  return pantallaPrincipal();
}
function pantallaEnlace(error) {
  app().innerHTML = `<div class="centro"><h2>Nexo Movilidad</h2><p class="nota">Para empezar pega el <b>código de enlace</b> que te dio la oficina y elige un PIN. Esto se hace una sola vez.</p>
    <form id="fEnlace" autocomplete="off"><label for="codigo">Código de enlace</label><textarea id="codigo" rows="4" placeholder="NEXO1.…" spellcheck="false"></textarea>
    <label for="pin1">Elige un PIN (4 a 8 números)</label><input id="pin1" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password">
    <label for="pin2">Repite el PIN</label><input id="pin2" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password">
    ${error ? `<p class="err" id="err">${esc(error)}</p>` : ''}<button class="p" id="btnEnlazar">Enlazar este teléfono</button>${cfg ? '<button type="button" class="s" id="btnCancelarEnlace">Cancelar</button>' : ''}</form>
    <p class="nota">El PIN protege la clave en este teléfono. Si lo olvidas, la oficina te genera un código nuevo.</p></div>`;
  const bc = $('#btnCancelarEnlace'); if (bc) bc.onclick = () => pintar();
  $('#fEnlace').onsubmit = async (ev) => { ev.preventDefault(); await enlazar($('#codigo').value.trim(), $('#pin1').value, $('#pin2').value); };
}
async function enlazar(codigo, p1, p2) {
  let c;
  try { if (!codigo.startsWith('NEXO1.')) throw 0; c = JSON.parse(dec.decode(b64url.d(codigo.slice(6)))); if (!c || c.v !== 1 || !c.s || !/^[0-9a-f]{64}$/.test(c.k)) throw 0; } catch (e) { return pantallaEnlace('El código de enlace no es válido. Cópialo completo, empezando por NEXO1.'); }
  if (!/^\d{4,8}$/.test(p1)) return pantallaEnlace('El PIN debe tener de 4 a 8 números.');
  if (p1 !== p2) return pantallaEnlace('Los dos PIN no coinciden.');
  const salt = crypto.getRandomValues(new Uint8Array(16)); const ck = await claveDePin(p1, salt);
  const previo = cfg; // si se reenlaza (clave renovada) se conservan los datos viejos hasta la próxima sincronización
  cfg = { empresa: c.e || '', s: c.s, n: c.n || 1, vinculadoEn: new Date().toISOString(), salt: b64.a(salt), sec: await sellar({ k: c.k, refresh: previo && previo.s === c.s && sec ? sec.refresh || '' : '', raiz: sec ? sec.raiz || '' : '' }, ck) };
  await kvSet('cfg', cfg); pinKey = ck; sec = await abrir(cfg.sec, ck); await cargarDatosGuardados(); pintar(); aviso('Teléfono enlazado');
  if (!datos) sincronizar(); // primera descarga
}
function pantallaPin(error) {
  app().innerHTML = `<div class="centro"><h2>Nexo Movilidad</h2><p class="nota">${esc(cfg.empresa)}</p><form id="fPin"><label for="pin">PIN</label><input id="pin" type="password" inputmode="numeric" maxlength="8" autocomplete="current-password" autofocus>${error ? `<p class="err" id="err">${esc(error)}</p>` : ''}<button class="p" id="btnPin">Entrar</button></form><button class="s" id="btnNuevoCodigo">Olvidé mi PIN / tengo un código nuevo</button></div>`;
  $('#btnNuevoCodigo').onclick = () => pantallaEnlace();
  $('#fPin').onsubmit = async (ev) => { ev.preventDefault(); const pin = $('#pin').value; const ck = await claveDePin(pin, b64.d(cfg.salt)); try { sec = await abrir(cfg.sec, ck); pinKey = ck; ultimoToque = Date.now(); await cargarDatosGuardados(); await procesarRetornoDropbox(); pintar(); } catch (e) { pantallaPin('PIN incorrecto.'); } };
}
async function cargarDatosGuardados() {
  datos = null; const g = await kvGet('datos'); if (!g) return;
  try { const r = await descifrarArchivo(g.raw, sec.k); datos = r.datos; recibido = g.recibido; } catch (e) { datos = null; }
}
function datosViejos() { return datos && Date.now() - Date.parse(datos.generado) > 24 * 3600 * 1000; }
function cabecera() {
  const t = datos && datos.tasa;
  return `<div class="cab"><h1>${esc(datos ? datos.vendedor.nombre : 'Nexo')} · ${esc(cfg.empresa)}</h1><div class="sub">${datos ? `Datos al ${esc(fmtTS(datos.generado))}${t ? ` · Tasa Bs ${fmt(t.valor, 4)} (${esc(fmtFecha(t.fecha))})` : ''}` : 'Sin datos todavía'}</div>${datosViejos() ? '<div class="viejo">Los datos tienen más de un día: sincroniza cuando tengas señal</div>' : ''}</div>
  <div class="pest">${[['articulos', 'Artículos'], ['clientes', 'Clientes'], ['ajustes', 'Ajustes']].map(([k, n]) => `<button data-p="${k}" class="${vista.pest === k && !vista.cli ? 'on' : ''}">${n}</button>`).join('')}</div>`;
}
function pantallaPrincipal() {
  app().innerHTML = cabecera() + '<div class="cuerpo" id="cuerpo"></div>';
  document.querySelectorAll('.pest button').forEach(b => { b.onclick = () => { vista.pest = b.dataset.p; vista.cli = null; pantallaPrincipal(); }; });
  if (vista.pest === 'ajustes') return vistaAjustes();
  if (!datos) { $('#cuerpo').innerHTML = `<div class="tarjeta"><p>Aún no hay datos en este teléfono.</p><button class="p" id="btnSync">Sincronizar ahora</button>${mensajeFuente()}</div>`; $('#btnSync').onclick = () => sincronizar(); return; }
  if (vista.pest === 'clientes') return vista.cli ? vistaCliente() : vistaClientes();
  return vistaArticulos();
}
const mensajeFuente = () => CFG.dropboxAppKey ? '' : '<p class="nota">La conexión directa con Dropbox aún no está configurada: usa «Abrir archivo» en Ajustes.</p>';

/* ---------- Artículos ---------- */
function precioHtml(a, lp) {
  const pr = a.precios && a.precios[lp], t = datos.tasa ? datos.tasa.valor : null;
  if (pr == null || pr === '') return '<span class="chico">sin precio</span>';
  const iva = a.alicuota ? pr * (1 + a.alicuota / 100) : pr;
  return `<div class="precio">$ ${fmt(pr)}</div>${a.alicuota ? `<div class="chico">+ IVA ${a.alicuota}% = $ ${fmt(iva)}</div>` : '<div class="chico">sin IVA</div>'}${t ? `<div class="chico">Bs ${fmt(iva * t)}</div>` : ''}`;
}
function vistaArticulos() {
  const listas = datos.listasPrecio || []; if (!vista.lista || !listas.some(l => l.id === vista.lista)) vista.lista = (listas[0] || {}).id || '';
  $('#cuerpo').innerHTML = `<input id="buscar" type="search" placeholder="Buscar por código, nombre o código de barras" value="${esc(vista.q)}" autocomplete="off"><label for="lista">Lista de precios</label><select id="lista">${listas.map(l => `<option value="${esc(l.id)}" ${l.id === vista.lista ? 'selected' : ''}>${esc(l.nombre)}</option>`).join('')}</select><div id="listaArt"></div>`;
  $('#buscar').oninput = (e) => { vista.q = e.target.value; pintarArticulos(); }; $('#lista').onchange = (e) => { vista.lista = e.target.value; pintarArticulos(); };
  pintarArticulos();
}
function pintarArticulos() {
  const q = norm(vista.q).trim(), MAX = 80;
  const todos = datos.articulos.filter(a => !q || norm([a.codigo, a.descripcion, a.codigoBarras, a.categoria].join(' ')).includes(q));
  const res = todos.slice(0, MAX), deps = datos.depositos || [];
  $('#listaArt').innerHTML = res.map(a => {
    const ex = a.manejaInventario ? `<span class="pill ${a.existencia > 0 ? 'ok' : 'cero'}">${a.existencia > 0 ? 'Existencia ' + fmt(a.existencia, a.existencia % 1 ? 2 : 0) : 'Sin existencia'}</span>` : '<span class="pill">Servicio</span>';
    const det = a.manejaInventario && deps.length > 1 ? `<table><thead><tr><th>Depósito</th><th class="n">Existencia</th></tr></thead><tbody>${deps.map(d => `<tr><td>${esc(d.nombre)}</td><td class="n">${fmt((a.porDeposito || {})[d.id] || 0, 0)}</td></tr>`).join('')}</tbody></table>` : '';
    const otras = (datos.listasPrecio || []).filter(l => l.id !== vista.lista && a.precios && a.precios[l.id] != null).map(l => `${esc(l.nombre)}: $ ${fmt(a.precios[l.id])}`).join(' · ');
    return `<details class="tarjeta"><summary><div class="fila"><div><h3>${esc(a.descripcion)}</h3><div class="chico">${esc(a.codigo)}${a.categoria ? ' · ' + esc(a.categoria) : ''}${a.unidad ? ' · ' + esc(a.unidad) : ''}</div><div style="margin-top:6px">${ex}</div></div><div style="text-align:right">${precioHtml(a, vista.lista)}</div></div></summary><div style="margin-top:8px">${otras ? `<div class="chico">Otras listas — ${otras}</div>` : ''}${a.costoUsd != null ? `<div class="chico">Costo: $ ${fmt(a.costoUsd)}</div>` : ''}${det}</div></details>`;
  }).join('') || '<p class="nota">No hay artículos con ese texto.</p>';
  if (todos.length > MAX) $('#listaArt').insertAdjacentHTML('beforeend', `<p class="nota">Mostrando ${MAX} de ${todos.length}: escribe más letras para afinar la búsqueda.</p>`);
}

/* ---------- Clientes ---------- */
function vistaClientes() {
  const cs = datos.clientes.slice().sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  const tot = cs.reduce((t, c) => t + (c.porCobrarUsd || 0), 0);
  $('#cuerpo').innerHTML = `<input id="buscarC" type="search" placeholder="Buscar cliente por nombre, RIF o código" value="${esc(vista.qc)}" autocomplete="off"><p class="chico" style="margin-top:8px">${cs.length} cliente(s) · Por cobrar: <b>$ ${fmt(tot)}</b></p><div id="listaCli"></div>`;
  const pintar = () => { const q = norm(vista.qc).trim(); const r = cs.filter(c => !q || norm([c.nombre, c.documento, c.codigo].join(' ')).includes(q));
    $('#listaCli').innerHTML = r.map(c => { const mora = c.pendientes.some(p => p.vencida); return `<div class="tarjeta" data-cli="${esc(c.id)}" role="button"><div class="fila"><div><h3>${esc(c.nombre)}</h3><div class="chico">${esc(c.documento)}${c.codigo ? ' · ' + esc(c.codigo) : ''}</div></div><div style="text-align:right"><div class="precio" style="${c.porCobrarUsd ? '' : 'color:var(--gris)'}">$ ${fmt(c.porCobrarUsd)}</div>${mora ? '<span class="pill mora">Vencido</span>' : ''}</div></div></div>`; }).join('') || '<p class="nota">No hay clientes con ese texto.</p>';
    document.querySelectorAll('[data-cli]').forEach(el => { el.onclick = () => { vista.cli = el.dataset.cli; pantallaPrincipal(); }; }); };
  $('#buscarC').oninput = (e) => { vista.qc = e.target.value; pintar(); }; pintar();
}
function vistaCliente() {
  const c = datos.clientes.find(x => x.id === vista.cli); if (!c) { vista.cli = null; return vistaClientes(); }
  const t = datos.tasa ? datos.tasa.valor : null, lp = (datos.listasPrecio || []).find(l => l.id === c.listaPrecioId);
  const dato = (k, v) => v ? `<div class="fila" style="margin-top:4px"><span class="chico">${k}</span><span style="text-align:right">${v}</span></div>` : '';
  $('#cuerpo').innerHTML = `<button class="atras" id="atras">‹ Clientes</button><div class="tarjeta"><h3>${esc(c.nombre)}</h3><div class="chico">${esc(c.documento)}${c.codigo ? ' · ' + esc(c.codigo) : ''}</div>
    ${dato('Teléfono', c.telefono ? `<a href="tel:${esc(c.telefono)}">${esc(c.telefono)}</a>` : '')}${dato('Correo', c.correo ? `<a href="mailto:${esc(c.correo)}">${esc(c.correo)}</a>` : '')}${dato('Contacto', esc(c.contacto))}${dato('Dirección', esc(c.direccion))}
    ${dato('Condición de pago', c.condicionPago === 'credito' ? `Crédito ${c.diasCredito} días` : c.condicionPago === 'contado' ? 'Contado' : esc(c.condicionPago))}${dato('Límite de crédito', c.limiteCreditoUsd != null ? '$ ' + fmt(c.limiteCreditoUsd) : '')}${dato('Lista de precios', lp ? esc(lp.nombre) : '')}</div>
    <div class="tarjeta"><div class="fila"><h3>Facturas pendientes</h3><span class="precio">$ ${fmt(c.porCobrarUsd)}</span></div>${t ? `<div class="chico">≈ Bs ${fmt(c.porCobrarUsd * t)} a la tasa del día</div>` : ''}${c.aFavorUsd ? `<div class="chico">Saldo a favor del cliente: $ ${fmt(c.aFavorUsd)}</div>` : ''}
    ${c.pendientes.length ? `<table style="margin-top:8px"><thead><tr><th>Doc.</th><th>Vence</th><th class="n">Pendiente $</th></tr></thead><tbody>${c.pendientes.map(p => `<tr><td>${String(p.numero).toUpperCase().startsWith(p.tipoDoc) ? '' : esc(p.tipoDoc) + ' '}${esc(p.numero)}<div class="chico">${esc(fmtFecha(p.fecha))}</div></td><td>${p.vencimiento ? esc(fmtFecha(p.vencimiento)) : '—'}${p.vencida ? `<div><span class="pill mora">${p.diasMora} d. de mora</span></div>` : ''}</td><td class="n">${fmt(p.pendUsd)}</td></tr>`).join('')}</tbody></table>` : '<p class="nota">No tiene facturas pendientes.</p>'}</div>
    <p class="nota">Saldos al ${esc(fmtTS(datos.generado))}; pueden haber cambiado después.</p>`;
  $('#atras').onclick = () => { vista.cli = null; pantallaPrincipal(); };
}

/* ---------- Ajustes ---------- */
function vistaAjustes() {
  $('#cuerpo').innerHTML = `<div class="tarjeta"><h3>Datos</h3><p class="chico">${recibido ? 'Última descarga: ' + esc(fmtTS(recibido)) : 'Sin descargas todavía.'}${datos ? '<br>Generados en la oficina: ' + esc(fmtTS(datos.generado)) : ''}</p>
    <button class="p" id="btnSync">Sincronizar ahora</button>${mensajeFuente()}<button class="s" id="btnArchivo">Abrir archivo…</button><input type="file" id="archivo" style="display:none" accept=".enc,application/json,*/*">
    ${CFG.dropboxAppKey ? `<p class="nota">Dropbox: ${sec.refresh ? 'conectado' : 'no conectado'}.</p><button class="s" id="btnDbx">${sec.refresh ? 'Reconectar Dropbox' : 'Conectar con Dropbox'}</button>` : ''}</div>
    <div class="tarjeta"><h3>Seguridad</h3><button class="s" id="btnBloq">Bloquear ahora</button><button class="s" id="btnNuevoCod">Usar un código de enlace nuevo</button><button class="s peligro" id="btnDesenlazar">Desenlazar este teléfono</button><p class="nota">Al desenlazar se borran del teléfono la clave y los datos. La app se bloquea sola tras 5 minutos sin uso.</p></div>
    <p class="nota">Nexo Movilidad ${VERSION_APP}</p>`;
  $('#btnSync').onclick = () => sincronizar(); $('#btnBloq').onclick = bloquear;
  $('#btnArchivo').onclick = () => $('#archivo').click();
  $('#archivo').onchange = async (e) => { const f = e.target.files[0]; if (f) await importarTexto(await f.text(), 'archivo'); };
  const bd2 = $('#btnDbx'); if (bd2) bd2.onclick = () => iniciarDropbox();
  $('#btnNuevoCod').onclick = () => pantallaEnlace();
  $('#btnDesenlazar').onclick = async () => { if (!confirm('Se borrarán la clave y los datos de este teléfono. ¿Continuar?')) return; await kvDel('cfg'); await kvDel('datos'); cfg = null; pinKey = null; sec = null; datos = null; pintar(); };
}

/* ---------- Obtención de datos ---------- */
async function importarTexto(texto, origen) {
  try {
    const r = await descifrarArchivo(texto, sec.k);
    if (r.enc.n !== cfg.n) { cfg.n = r.enc.n; await kvSet('cfg', cfg); }
    await kvSet('datos', { raw: texto, recibido: new Date().toISOString() }); datos = r.datos; recibido = new Date().toISOString();
    aviso(origen === 'dropbox' ? 'Datos actualizados desde Dropbox' : 'Datos cargados del archivo'); pantallaPrincipal(); return true;
  } catch (e) { aviso(e.message, true); return false; }
}
let sincronizando = false;
async function sincronizar() {
  if (!CFG.dropboxAppKey) { aviso('Dropbox aún no está configurado: usa «Abrir archivo» en Ajustes', true); vista.pest = 'ajustes'; pantallaPrincipal(); return; }
  if (!sec.refresh) { aviso('Conecta primero con Dropbox en Ajustes', true); vista.pest = 'ajustes'; pantallaPrincipal(); return; }
  if (sincronizando) return; sincronizando = true; const b = $('#btnSync'); if (b) b.disabled = true;
  try {
    if (!navigator.onLine) throw new Error('Sin señal: se siguen usando los últimos datos guardados.');
    const tk = await tokenDropbox(); const texto = await descargarDropbox(tk); await importarTexto(texto, 'dropbox');
  } catch (e) { aviso(e.message || 'No se pudo sincronizar', true); } finally { sincronizando = false; const b2 = $('#btnSync'); if (b2) b2.disabled = false; }
}

/* ---------- Dropbox (OAuth con PKCE; sin servidor intermedio) ---------- */
const urlApp = () => location.origin + location.pathname;
async function iniciarDropbox() {
  const verif = b64url.a(crypto.getRandomValues(new Uint8Array(48))), desafio = b64url.a(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verif))));
  sessionStorage.setItem('dbx_verif', verif);
  location.href = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({ client_id: CFG.dropboxAppKey, response_type: 'code', code_challenge: desafio, code_challenge_method: 'S256', token_access_type: 'offline', redirect_uri: urlApp() });
}
(function capturarRetorno() { // al volver de Dropbox: se guarda el código y se limpia la dirección; se canjea al desbloquear
  const p = new URLSearchParams(location.search); const c = p.get('code');
  if (c && sessionStorage.getItem('dbx_verif')) { sessionStorage.setItem('dbx_code', c); history.replaceState(null, '', urlApp()); }
  else if (p.get('error')) { sessionStorage.setItem('dbx_error', p.get('error_description') || p.get('error')); history.replaceState(null, '', urlApp()); }
})();
async function procesarRetornoDropbox() {
  const err = sessionStorage.getItem('dbx_error'); if (err) { sessionStorage.removeItem('dbx_error'); aviso('Dropbox: ' + err, true); }
  const code = sessionStorage.getItem('dbx_code'); if (!code) return;
  sessionStorage.removeItem('dbx_code'); const verif = sessionStorage.getItem('dbx_verif'); sessionStorage.removeItem('dbx_verif');
  try {
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: CFG.dropboxAppKey, code_verifier: verif, redirect_uri: urlApp() }) });
    const j = await r.json(); if (!r.ok || !j.refresh_token) throw new Error(j.error_description || 'no se pudo conectar');
    sec.refresh = j.refresh_token; cfg.sec = await sellar(sec, pinKey); await kvSet('cfg', cfg); tokenCache = { t: j.access_token, hasta: Date.now() + (j.expires_in - 60) * 1000 };
    aviso('Dropbox conectado'); setTimeout(() => sincronizar(), 100);
  } catch (e) { aviso('Dropbox: ' + e.message, true); }
}
let tokenCache = null;
async function tokenDropbox() {
  if (tokenCache && Date.now() < tokenCache.hasta) return tokenCache.t;
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: sec.refresh, client_id: CFG.dropboxAppKey }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(r.status === 400 || r.status === 401 ? 'Dropbox pide volver a conectar (Ajustes > Reconectar Dropbox)' : 'Dropbox no respondió');
  tokenCache = { t: j.access_token, hasta: Date.now() + (j.expires_in - 60) * 1000 }; return tokenCache.t;
}
async function apiDropbox(tk, ruta, cuerpo) {
  const r = await fetch('https://api.dropboxapi.com/2/' + ruta, { method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
  if (!r.ok) throw new Error('Dropbox: ' + r.status + ' ' + (await r.text()).slice(0, 120)); return r.json();
}
async function descargarDropbox(tk) {
  // La carpeta del vendedor se llama como su id: se busca una vez y se recuerda la ruta
  let base = sec.raiz;
  if (!base) {
    const b = await apiDropbox(tk, 'files/search_v2', { query: cfg.s, options: { path: '', max_results: 20, filename_only: true } });
    const m = (b.matches || []).map(x => x.metadata && x.metadata.metadata).find(x => x && x['.tag'] === 'folder' && x.name === cfg.s);
    if (!m) throw new Error('No encuentro tu carpeta en Dropbox. Revisa que la oficina te haya compartido la carpeta de Nexo y que la hayas aceptado.');
    base = m.path_display; sec.raiz = base; cfg.sec = await sellar(sec, pinKey); await kvSet('cfg', cfg);
  }
  const r = await fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Dropbox-API-Arg': JSON.stringify({ path: base + '/salida/datos.json.enc' }) } });
  if (!r.ok) { if (r.status === 409) { sec.raiz = ''; cfg.sec = await sellar(sec, pinKey); await kvSet('cfg', cfg); throw new Error('Todavía no hay datos en tu carpeta: la oficina debe sincronizar primero.'); } throw new Error('Dropbox: ' + r.status); }
  return r.text();
}

/* ---------- Arranque ---------- */
(async function iniciar() {
  try { cfg = (await kvGet('cfg')) || null; } catch (e) { cfg = null; }
  pintar();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* sin sw: funciona igual, pero no sin conexión */ });
  window.addEventListener('online', () => { if (pinKey && CFG.dropboxAppKey && sec && sec.refresh && (!datos || datosViejos())) sincronizar(); });
})();
