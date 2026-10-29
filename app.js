/* Nexo Movilidad — app del vendedor (consulta). Sin dependencias.
   - El código de enlace (NEXO1.…) trae la clave de cifrado; se guarda cifrada con el PIN del vendedor.
   - Los datos (datos.json.enc, AES-256-GCM) se guardan tal como llegan y se descifran en memoria al desbloquear.
   - Fuente de datos: Dropbox (si config.js tiene la clave de aplicación) o «Abrir archivo» manual. */
'use strict';
const VERSION_APP = '0.5.0';
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
let pinKey = null, sec = null, datos = null, recibido = null, pedidos = [], visitas = [], msgs = { leidos: {}, acuses: [] }, vista = { pest: 'inicio', lista: '', q: '', cli: null, qc: '', ped: null }, borrador = null;
let ultimoToque = Date.now(); const BLOQUEO_MS = 5 * 60 * 1000;
['click', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, () => { ultimoToque = Date.now(); }, { passive: true }));
setInterval(() => { if (pinKey && Date.now() - ultimoToque > BLOQUEO_MS) bloquear(); }, 15000);
function bloquear() { pinKey = null; sec = null; datos = null; pedidos = []; visitas = []; msgs = { leidos: {}, acuses: [] }; borrador = null; vista = { pest: 'inicio', lista: '', q: '', cli: null, qc: '', ped: null }; pintar(); }

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
  cfg = { empresa: c.e || '', s: c.s, d: typeof c.d === 'string' ? c.d : '', n: c.n || 1, vinculadoEn: new Date().toISOString(), salt: b64.a(salt), sec: await sellar({ k: c.k, refresh: previo && previo.s === c.s && sec ? sec.refresh || '' : '', raiz: sec ? sec.raiz || '' : '' }, ck) };
  await kvSet('cfg', cfg); pinKey = ck; sec = await abrir(cfg.sec, ck); await cargarDatosGuardados(); pintar(); aviso('Teléfono enlazado');
  if (!datos) sincronizar(); // primera descarga
}
function pantallaPin(error) {
  app().innerHTML = `<div class="centro"><h2>Nexo Movilidad</h2><p class="nota">${esc(cfg.empresa)}</p><form id="fPin"><label for="pin">PIN</label><input id="pin" type="password" inputmode="numeric" maxlength="8" autocomplete="current-password" autofocus>${error ? `<p class="err" id="err">${esc(error)}</p>` : ''}<button class="p" id="btnPin">Entrar</button></form><button class="s" id="btnNuevoCodigo">Olvidé mi PIN / tengo un código nuevo</button></div>`;
  $('#btnNuevoCodigo').onclick = () => pantallaEnlace();
  $('#fPin').onsubmit = async (ev) => { ev.preventDefault(); const pin = $('#pin').value; const ck = await claveDePin(pin, b64.d(cfg.salt)); try { sec = await abrir(cfg.sec, ck); pinKey = ck; ultimoToque = Date.now(); await cargarDatosGuardados(); await procesarRetornoDropbox(); pintar(); enviarPendientes(false); } catch (e) { pantallaPin('PIN incorrecto.'); } };
}
async function cargarDatosGuardados() {
  try { const pg = await kvGet('pedidos'); pedidos = pg ? await abrir(pg, pinKey) : []; } catch (e) { pedidos = []; }
  try { const vg = await kvGet('visitas'); visitas = vg ? await abrir(vg, pinKey) : []; } catch (e) { visitas = []; } cerrarVisitasOlvidadas();
  try { const mg = await kvGet('msgs'); msgs = mg ? await abrir(mg, pinKey) : { leidos: {}, acuses: [] }; if (!msgs.leidos) msgs.leidos = {}; if (!Array.isArray(msgs.acuses)) msgs.acuses = []; } catch (e) { msgs = { leidos: {}, acuses: [] }; }
  datos = null; const g = await kvGet('datos'); if (!g) return;
  try { const r = await descifrarArchivo(g.raw, sec.k); datos = r.datos; recibido = g.recibido; } catch (e) { datos = null; }
}
function datosViejos() { return datos && Date.now() - Date.parse(datos.generado) > 24 * 3600 * 1000; }
function cabecera() {
  const t = datos && datos.tasa;
  return `<div class="cab"><h1>${esc(datos ? datos.vendedor.nombre : 'Nexo')} · ${esc(cfg.empresa)}</h1><div class="sub">${datos ? `Datos al ${esc(fmtTS(datos.generado))}${t ? ` · Tasa Bs ${fmt(t.valor, 4)} (${esc(fmtFecha(t.fecha))})` : ''}` : 'Sin datos todavía'}</div>${datosViejos() ? '<div class="viejo">Los datos tienen más de un día: sincroniza cuando tengas señal</div>' : ''}</div>
  <div class="pest">${[['inicio', 'Inicio'], ['articulos', 'Artículos'], ['clientes', 'Clientes'], ['pedidos', 'Pedidos' + (pedidos.filter(p => p.estado === 'pendiente').length ? ' (' + pedidos.filter(p => p.estado === 'pendiente').length + ')' : '')], ['mensajes', 'Mensajes' + (msgNuevos() ? ' (' + msgNuevos() + ')' : '')], ['ajustes', '⚙ Ajustes']].map(([k, n]) => `<button data-p="${k}" class="${vista.pest === k && !(k === 'clientes' && vista.cli) ? 'on' : ''}">${n}</button>`).join('')}</div>`;
}
function pantallaPrincipal() {
  app().innerHTML = cabecera() + '<div class="cuerpo" id="cuerpo"></div>';
  document.querySelectorAll('.pest button').forEach(b => { b.onclick = () => { vista.pest = b.dataset.p; vista.cli = null; vista.ped = null; vista.msg = null; vista.venc = false; vista.visita = null; borrador = null; pantallaPrincipal(); }; });
  if (vista.pest === 'ajustes') return vistaAjustes();
  if (!datos) { $('#cuerpo').innerHTML = `<div class="tarjeta"><p>Aún no hay datos en este teléfono.</p><button class="p" id="btnSync">Sincronizar ahora</button>${mensajeFuente()}</div>`; $('#btnSync').onclick = () => sincronizar(); return; }
  cerrarVisitasOlvidadas(); if (vista.visita) return vistaVisita();
  if (vista.pest === 'clientes') return vista.venc ? vistaVencidas() : vista.cli ? vistaCliente() : vistaClientes();
  if (vista.pest === 'pedidos') return vistaPedidos();
  if (vista.pest === 'mensajes') return vistaMensajes();
  if (vista.pest === 'inicio') return vistaInicio();
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
  $('#cuerpo').innerHTML = `${catalogoBoton()}<input id="buscar" type="search" placeholder="Buscar por código, nombre o código de barras" value="${esc(vista.q)}" autocomplete="off"><label for="lista">Lista de precios</label><select id="lista">${listas.map(l => `<option value="${esc(l.id)}" ${l.id === vista.lista ? 'selected' : ''}>${esc(l.nombre)}</option>`).join('')}</select><div id="listaArt"></div>`;
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
    return `<details class="tarjeta"><summary><div class="fila"><div><h3>${esc(a.descripcion)}</h3><div class="chico">${esc(a.codigo)}${a.categoria ? ' · ' + esc(a.categoria) : ''}${a.unidad ? ' · ' + esc(a.unidad) : ''}</div><div style="margin-top:6px">${ex}</div></div><div style="text-align:right">${precioHtml(a, vista.lista)}</div></div></summary><div style="margin-top:8px">${otras ? `<div class="chico">Otras listas — ${otras}</div>` : ''}${a.costoUsd != null ? `<div class="chico">Costo: $ ${fmt(a.costoUsd)}</div>` : ''}${det}${enlaceArticulo(a)}</div></details>`;
  }).join('') || '<p class="nota">No hay artículos con ese texto.</p>';
  if (todos.length > MAX) $('#listaArt').insertAdjacentHTML('beforeend', `<p class="nota">Mostrando ${MAX} de ${todos.length}: escribe más letras para afinar la búsqueda.</p>`);
}

/* ---------- Clientes ---------- */
function vistaClientes() {
  const cs = datos.clientes.slice().sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  const tot = cs.reduce((t, c) => t + (c.porCobrarUsd || 0), 0);
  $('#cuerpo').innerHTML = `<input id="buscarC" type="search" placeholder="Buscar cliente por nombre, RIF o código" value="${esc(vista.qc)}" autocomplete="off"><p class="chico" style="margin-top:8px">${cs.length} cliente(s) · Por cobrar: <b>$ ${fmt(tot)}</b></p>${nVencidas() ? `<button class="s" id="btnVenc" style="margin-top:0">Facturas vencidas (${nVencidas()})</button>` : ''}<div id="listaCli"></div>`;
  const bv = $('#btnVenc'); if (bv) bv.onclick = () => { vista.venc = true; pantallaPrincipal(); };
  const pintar = () => { const q = norm(vista.qc).trim(); const r = cs.filter(c => !q || norm([c.nombre, c.documento, c.codigo].join(' ')).includes(q));
    $('#listaCli').innerHTML = r.map(c => { const mora = c.pendientes.some(p => p.vencida); return `<div class="tarjeta" data-cli="${esc(c.id)}" role="button"><div class="fila"><div><h3>${esc(c.nombre)}</h3><div class="chico">${esc(c.documento)}${c.codigo ? ' · ' + esc(c.codigo) : ''}</div></div><div style="text-align:right"><div class="precio" style="${c.porCobrarUsd ? '' : 'color:var(--gris)'}">$ ${fmt(c.porCobrarUsd)}</div>${mora ? '<span class="pill mora">Vencido</span>' : ''}</div></div></div>`; }).join('') || '<p class="nota">No hay clientes con ese texto.</p>';
    document.querySelectorAll('[data-cli]').forEach(el => { el.onclick = () => { vista.cli = el.dataset.cli; pantallaPrincipal(); }; }); };
  $('#buscarC').oninput = (e) => { vista.qc = e.target.value; pintar(); }; pintar();
}
function vistaCliente() {
  const c = datos.clientes.find(x => x.id === vista.cli); if (!c) { vista.cli = null; return vistaClientes(); }
  const t = datos.tasa ? datos.tasa.valor : null, lp = (datos.listasPrecio || []).find(l => l.id === c.listaPrecioId);
  const dato = (k, v) => v ? `<div class="fila" style="margin-top:4px"><span class="chico">${k}</span><span style="text-align:right">${v}</span></div>` : '';
  const mc = mensajesVig().filter(m => m.clienteId === c.id); mc.forEach(marcarLeido);
  $('#cuerpo').innerHTML = `<button class="atras" id="atras">‹ Clientes</button>${mc.map(m => `<div class="tarjeta aviso-msg"><div class="chico"><b>Mensaje de la oficina</b> · ${esc(fmtTS(m.creado))}</div><h3>${esc(m.titulo)}</h3><div style="white-space:pre-wrap">${esc(m.texto)}</div></div>`).join('')}<div class="tarjeta"><h3>${esc(c.nombre)}</h3><div class="chico">${esc(c.documento)}${c.codigo ? ' · ' + esc(c.codigo) : ''}</div>
    ${dato('Teléfono', c.telefono ? `<a href="tel:${esc(c.telefono)}">${esc(c.telefono)}</a>` : '')}${dato('Correo', c.correo ? `<a href="mailto:${esc(c.correo)}">${esc(c.correo)}</a>` : '')}${dato('Contacto', esc(c.contacto))}${dato('Dirección', esc(c.direccion))}
    ${dato('Condición de pago', c.condicionPago === 'credito' ? `Crédito ${c.diasCredito} días` : c.condicionPago === 'contado' ? 'Contado' : esc(c.condicionPago))}${dato('Límite de crédito', c.limiteCreditoUsd != null ? '$ ' + fmt(c.limiteCreditoUsd) : '')}${dato('Lista de precios', lp ? esc(lp.nombre) : '')}</div>
    <div class="tarjeta"><div class="fila"><h3>Facturas pendientes</h3><span class="precio">$ ${fmt(c.porCobrarUsd)}</span></div>${t ? `<div class="chico">≈ Bs ${fmt(c.porCobrarUsd * t)} a la tasa del día</div>` : ''}${c.aFavorUsd ? `<div class="chico">Saldo a favor del cliente: $ ${fmt(c.aFavorUsd)}</div>` : ''}
    ${c.pendientes.length ? `<table style="margin-top:8px"><thead><tr><th>Doc.</th><th>Vence</th><th class="n">Pendiente $</th></tr></thead><tbody>${c.pendientes.map(p => `<tr><td>${String(p.numero).toUpperCase().startsWith(p.tipoDoc) ? '' : esc(p.tipoDoc) + ' '}${esc(p.numero)}<div class="chico">${esc(fmtFecha(p.fecha))}</div></td><td>${p.vencimiento ? esc(fmtFecha(p.vencimiento)) : '—'}${p.vencida ? `<div><span class="pill mora">${p.diasMora} d. de mora</span></div>` : ''}</td><td class="n">${fmt(p.pendUsd)}</td></tr>`).join('')}</tbody></table>` : '<p class="nota">No tiene facturas pendientes.</p>'}</div>
    ${bannerVisita(c.id)}
    <button class="p" id="btnPedidoCli">Nuevo pedido para este cliente</button><button class="s" id="btnPresuCli">Hacer un presupuesto</button>${c.pendientes.length ? '<button class="s" id="btnWaCli">Enviar facturas pendientes por WhatsApp</button>' : ''}
    <p class="nota">Saldos al ${esc(fmtTS(datos.generado))}; pueden haber cambiado después.</p>`;
  $('#btnPedidoCli').onclick = () => nuevoPedido(c.id); $('#btnPresuCli').onclick = () => nuevoPedido(c.id, null, 'presupuesto'); enlazarBannerVisita();
  const bw = $('#btnWaCli'); if (bw) bw.onclick = () => enviarWhatsApp(textoEstadoCuenta(c), c.telefono);
  $('#atras').onclick = () => { vista.cli = null; pantallaPrincipal(); };
}

/* ---------- Ajustes ---------- */
function vistaAjustes() {
  $('#cuerpo').innerHTML = `<div class="tarjeta"><h3>Datos</h3><p class="chico">${recibido ? 'Última descarga: ' + esc(fmtTS(recibido)) : 'Sin descargas todavía.'}${datos ? '<br>Generados en la oficina: ' + esc(fmtTS(datos.generado)) : ''}</p>
    <button class="p" id="btnSync">Sincronizar ahora</button>${mensajeFuente()}<button class="s" id="btnArchivo">Abrir archivo…</button><input type="file" id="archivo" style="display:none" accept=".enc,application/json,*/*">
    ${CFG.dropboxAppKey ? `<p class="nota">Dropbox: ${sec.refresh ? 'conectado' : 'no conectado'}.</p><button class="s" id="btnDbx">${sec.refresh ? 'Reconectar Dropbox' : 'Conectar con Dropbox'}</button>
    <label for="dbxRuta">Carpeta en Dropbox (solo si no la encuentra sola)</label><input id="dbxRuta" value="${esc(sec.raiz || '')}" placeholder="/Nexo/nexo-movil/…" autocomplete="off" spellcheck="false"><button class="s" id="btnDbxRuta">Guardar carpeta</button><p class="nota">Es la ruta de la carpeta de tu vendedor dentro de Dropbox, la que contiene la subcarpeta «salida».</p>` : ''}</div>
    <div class="tarjeta"><h3>Seguridad</h3><button class="s" id="btnBloq">Bloquear ahora</button><button class="s" id="btnNuevoCod">Usar un código de enlace nuevo</button><button class="s peligro" id="btnDesenlazar">Desenlazar este teléfono</button><p class="nota">Al desenlazar se borran del teléfono la clave y los datos. La app se bloquea sola tras 5 minutos sin uso.</p></div>
    <div class="tarjeta"><h3>Instalar</h3><div id="instalacion"></div></div>
    <p class="nota">Nexo Movilidad ${VERSION_APP}</p>`;
  pintarInstalacion();
  $('#btnSync').onclick = () => sincronizar(); $('#btnBloq').onclick = bloquear;
  $('#btnArchivo').onclick = () => $('#archivo').click();
  $('#archivo').onchange = async (e) => { const f = e.target.files[0]; if (f) await importarTexto(await f.text(), 'archivo'); };
  const bd2 = $('#btnDbx'); if (bd2) bd2.onclick = () => iniciarDropbox();
  const br = $('#btnDbxRuta'); if (br) br.onclick = async () => { let v = $('#dbxRuta').value.trim().replace(/\\/g, '/'); if (v && !v.startsWith('/')) v = '/' + v; sec.raiz = v.replace(/\/+$/, ''); cfg.sec = await sellar(sec, pinKey); await kvSet('cfg', cfg); aviso(v ? 'Carpeta guardada' : 'Carpeta borrada: se buscará sola'); };
  $('#btnNuevoCod').onclick = () => pantallaEnlace();
  $('#btnDesenlazar').onclick = async () => { if (!confirm('Se borrarán la clave y los datos de este teléfono. ¿Continuar?')) return; await kvDel('cfg'); await kvDel('datos'); await kvDel('pedidos'); await kvDel('msgs'); await kvDel('visitas'); cfg = null; pinKey = null; sec = null; datos = null; pintar(); };
}

/* ---------- Obtención de datos ---------- */
async function importarTexto(texto, origen) {
  try {
    const r = await descifrarArchivo(texto, sec.k);
    if (r.enc.n !== cfg.n) { cfg.n = r.enc.n; await kvSet('cfg', cfg); }
    await kvSet('datos', { raw: texto, recibido: new Date().toISOString() }); datos = r.datos; recibido = new Date().toISOString();
    aviso(origen === 'dropbox' ? 'Datos actualizados desde Dropbox' : 'Datos cargados del archivo'); pantallaPrincipal(); if (origen === 'dropbox') enviarPendientes(false); return true;
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
const rutaArchivo = (base) => base.replace(/\/+$/, '') + '/salida/datos.json.enc';
async function bajarDe(tk, base) { // texto del archivo, o null si esa carpeta no existe / aún no tiene datos
  const r = await fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Dropbox-API-Arg': JSON.stringify({ path: rutaArchivo(base) }) } });
  if (r.status === 409) return null; if (!r.ok) throw new Error('Dropbox: ' + r.status); return r.text();
}
async function descargarDropbox(tk) {
  // Se prueba, en orden: la carpeta recordada, la que trae el código de enlace (ruta dentro de Dropbox), la carpeta compartida en la raíz y, por último, la búsqueda de Dropbox
  const probados = [], candidatas = [sec.raiz, cfg.d, '/' + cfg.s].filter(x => x);
  const guardar = async (base) => { if (sec.raiz !== base) { sec.raiz = base; cfg.sec = await sellar(sec, pinKey); await kvSet('cfg', cfg); } };
  for (const base of candidatas) { if (probados.includes(base)) continue; probados.push(base); const t = await bajarDe(tk, base); if (t != null) { await guardar(base); return t; } }
  try {
    const b = await apiDropbox(tk, 'files/search_v2', { query: cfg.s, options: { path: '', max_results: 20 } });
    const m = (b.matches || []).map(x => x.metadata && x.metadata.metadata).find(x => x && x['.tag'] === 'folder' && x.name === cfg.s);
    if (m && !probados.includes(m.path_display)) { probados.push(m.path_display); const t = await bajarDe(tk, m.path_display); if (t != null) { await guardar(m.path_display); return t; } }
  } catch (e) { /* la búsqueda es solo el último recurso */ }
  throw new Error('No encuentro los datos en Dropbox (busqué en: ' + probados.join(', ') + '). Si la carpeta está en otra ruta, escríbela en Ajustes > «Carpeta en Dropbox». Si es nueva, la oficina debe sincronizar primero.');
}

/* ---------- Mensajes de la oficina ---------- */
const TIPO_MSG = { aviso: 'Aviso', cliente: 'Cliente', producto: 'Producto', oferta: 'Oferta' };
const mensajesVig = () => ((datos && datos.mensajes) || []).filter(m => !m.vigenteHasta || m.vigenteHasta >= hoyLocal());
const msgLeido = (m) => !!(m.leido || msgs.leidos[m.id]);
const msgNuevos = () => mensajesVig().filter(m => !msgLeido(m)).length;
async function guardarMsgs() { if (pinKey) await kvSet('msgs', await sellar(msgs, pinKey)); }
function marcarLeido(m) { // queda constancia local y se avisa a la oficina cuando hay señal
  if (msgLeido(m)) return; const ts = new Date().toISOString(); msgs.leidos[m.id] = ts;
  msgs.acuses.push({ id: 'LEC-' + ts.replace(/\D/g, '').slice(0, 14) + '-' + [...crypto.getRandomValues(new Uint8Array(3))].map(x => x.toString(16).padStart(2, '0')).join(''), mensajeId: m.id, leidoEn: ts, enviado: false });
  const ids = Object.keys(msgs.leidos); if (ids.length > 300) ids.sort((a, b) => (msgs.leidos[a] < msgs.leidos[b] ? -1 : 1)).slice(0, ids.length - 300).forEach(k => delete msgs.leidos[k]);
  if (msgs.acuses.length > 300) msgs.acuses = msgs.acuses.filter(a => !a.enviado).concat(msgs.acuses.filter(a => a.enviado).slice(-100));
  guardarMsgs().then(() => enviarPendientes(false)); const b = document.querySelector('.pest [data-p=mensajes]'); if (b) b.textContent = 'Mensajes' + (msgNuevos() ? ' (' + msgNuevos() + ')' : '');
}
function vistaMensajes() {
  if (vista.msg) { const m = mensajesVig().find(x => x.id === vista.msg); if (m) return detalleMensaje(m); vista.msg = null; }
  const l = mensajesVig();
  $('#cuerpo').innerHTML = l.map(m => `<div class="tarjeta" data-msg="${esc(m.id)}" role="button"><div class="fila"><div><div class="chico"><span class="pill ${msgLeido(m) ? '' : 'ok'}">${msgLeido(m) ? esc(TIPO_MSG[m.tipo] || m.tipo) : 'Nuevo · ' + esc(TIPO_MSG[m.tipo] || m.tipo)}</span> ${esc(fmtTS(m.creado))}</div><h3 style="margin-top:6px">${esc(m.titulo)}</h3><div class="chico">${esc(m.texto.length > 90 ? m.texto.slice(0, 90) + '…' : m.texto)}</div></div></div></div>`).join('') || '<p class="nota">No hay mensajes de la oficina. Aquí verás avisos, comentarios sobre tus clientes, llegadas de producto y ofertas.</p>';
  document.querySelectorAll('[data-msg]').forEach(el => { el.onclick = () => { vista.msg = el.dataset.msg; pantallaPrincipal(); }; });
}
function detalleMensaje(m) {
  marcarLeido(m); const c = m.clienteId && datos.clientes.find(x => x.id === m.clienteId), a = m.productoId && datos.articulos.find(x => x.id === m.productoId);
  $('#cuerpo').innerHTML = `<button class="atras" id="atras">‹ Mensajes</button><div class="tarjeta"><div class="chico"><span class="pill">${esc(TIPO_MSG[m.tipo] || m.tipo)}</span> ${esc(fmtTS(m.creado))}${m.vigenteHasta ? ' · vigente hasta ' + esc(fmtFecha(m.vigenteHasta)) : ''}</div>
    <h3 style="margin-top:6px">${esc(m.titulo)}</h3><div style="white-space:pre-wrap;margin-top:6px">${esc(m.texto)}</div></div>
    ${c ? `<button class="s" id="verCli">Ver cliente: ${esc(c.nombre)}</button>` : ''}${a ? `<button class="s" id="verArt">Ver artículo: ${esc(a.codigo)} ${esc(a.descripcion)}</button>` : ''}`;
  $('#atras').onclick = () => { vista.msg = null; pantallaPrincipal(); };
  const vc = $('#verCli'); if (vc) vc.onclick = () => { vista.msg = null; vista.pest = 'clientes'; vista.cli = c.id; pantallaPrincipal(); };
  const va = $('#verArt'); if (va) va.onclick = () => { vista.msg = null; vista.pest = 'articulos'; vista.q = a.codigo; pantallaPrincipal(); };
}

/* ---------- Fase B: visitas, inicio, compartir ---------- */
const TIPOS_DOC = { pedido: 'Pedido', presupuesto: 'Presupuesto' };
const PRESUP_DIAS = 3;
const MOTIVOS = { pedido: 'Pedido', existencias: 'Verificar existencias', cobranza: 'Cobranza', otro: 'Otro' };
const RESULTADOS = { pedido: 'Hizo pedido', presupuesto: 'Dejó presupuesto', sin_pedido: 'No hizo pedido', cobro_prometido: 'Cobro prometido', informacion: 'Solo información' };
const sumarDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
const fechaLocalDe = (iso) => new Date(iso).toLocaleDateString('en-CA');
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00') - Date.parse(a + 'T12:00:00')) / 864e5);
const visitaAbierta = () => visitas.find(v => v.estado === 'abierta');
async function guardarVisitas() { if (pinKey) await kvSet('visitas', await sellar(visitas, pinKey)); }
const nuevoIdVisita = () => 'VIS-' + new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '-' + [...crypto.getRandomValues(new Uint8Array(4))].map(x => x.toString(16).padStart(2, '0')).join('');
function cerrarVisitasOlvidadas() { // una visita sin finalizar tras 24 h se cierra sola y queda marcada «sin cierre»
  const lim = Date.now() - 24 * 3600 * 1000; let cambio = false;
  visitas.forEach(v => { if (v.estado === 'abierta' && Date.parse(v.inicio) < lim) { v.estado = 'cerrada'; v.fin = v.inicio; v.resultado = 'sin_cierre'; v.sinCierre = true; v.enviado = false; cambio = true; } });
  if (cambio) guardarVisitas().then(() => enviarPendientes(false));
}
function vincularVisita(p, desde) { // todo pedido/presupuesto pertenece a una visita: la abierta del mismo cliente o una automática
  if (p.visitaId) return; const ab = visitaAbierta(), ahora = new Date().toISOString();
  if (ab && ab.clienteId === p.clienteId) { p.visitaId = ab.id; if (!ab.pedidoIds.includes(p.id)) ab.pedidoIds.push(p.id); return; }
  if (ab) return; const ini = desde || ahora;
  const v = { id: nuevoIdVisita(), clienteId: p.clienteId, fecha: fechaLocalDe(ini), inicio: ini, fin: ahora, motivos: ['pedido'], observacion: '', resultado: p.tipoDoc === 'presupuesto' ? 'presupuesto' : 'pedido', detalle: '', pedidoIds: [p.id], automatica: true, sinCierre: false, estado: 'cerrada', enviado: false };
  visitas.push(v); p.visitaId = v.id;
}
function bannerVisita(clienteId) { // visita en curso: accesos rápidos
  const ab = visitaAbierta(); if (!ab) return clienteId ? '<button class="p" id="btnIniciarVisCli">Iniciar visita a este cliente</button>' : '';
  const c = clienteDe(ab.clienteId), desde = new Date(ab.inicio).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
  if (clienteId && ab.clienteId !== clienteId) return `<div class="tarjeta aviso-msg"><b>Tienes una visita en curso</b> con ${esc(c ? c.nombre : 'otro cliente')}. <button class="s" data-vis-ir="${esc(ab.id)}">Ir a esa visita</button></div>`;
  return `<div class="tarjeta aviso-msg" id="bannerVisita"><div class="chico"><b>Visita en curso</b> · desde las ${esc(desde)}</div><h3>${esc(c ? c.nombre : '(cliente)')}</h3><div class="chico">${ab.motivos.map(m => esc(MOTIVOS[m])).join(' · ')}</div>
    <div class="fila" style="gap:8px;margin-top:8px"><button class="s" data-vis-doc="pedido" style="margin-top:0">+ Pedido</button><button class="s" data-vis-doc="presupuesto" style="margin-top:0">+ Presupuesto</button></div><button class="p" id="btnFinVisita">Finalizar visita</button></div>`;
}
function enlazarBannerVisita() {
  document.querySelectorAll('[data-vis-doc]').forEach(b => { b.onclick = () => nuevoPedido(visitaAbierta().clienteId, null, b.dataset.visDoc); });
  const f = $('#btnFinVisita'); if (f) f.onclick = () => { vista.visita = { modo: 'fin', id: visitaAbierta().id }; pantallaPrincipal(); };
  document.querySelectorAll('[data-vis-ir]').forEach(b => { b.onclick = () => { vista.cli = visitaAbierta().clienteId; vista.pest = 'clientes'; pantallaPrincipal(); }; });
  const i = $('#btnIniciarVisCli'); if (i) i.onclick = () => { vista.visita = { modo: 'inicio', clienteId: vista.cli }; pantallaPrincipal(); };
}
function vistaVisita() {
  const v = vista.visita, cuerpo = $('#cuerpo');
  if (v.modo === 'inicio') {
    if (visitaAbierta()) { vista.visita = null; return pantallaPrincipal(); }
    const cs = datos.clientes.slice().sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    cuerpo.innerHTML = `<button class="atras" id="atras">‹ Volver</button><div class="tarjeta"><h3>Iniciar visita</h3><label for="vCli">Cliente</label><select id="vCli"><option value="">Elige…</option>${cs.map(x => `<option value="${esc(x.id)}" ${x.id === v.clienteId ? 'selected' : ''}>${esc(x.nombre)}</option>`).join('')}</select><div class="chico" id="vCliInfo" style="margin-top:6px"></div>
      <p class="etq" style="margin:12px 0 4px">Motivo de la visita (puedes marcar varios)</p>${Object.entries(MOTIVOS).map(([k, n]) => `<label class="chk"><input type="checkbox" class="vMot" value="${k}"> ${n}</label>`).join('')}
      <label for="vObs">Observación (opcional)</label><textarea id="vObs" rows="2" maxlength="300"></textarea></div><button class="p" id="btnIniciarVis">Iniciar visita</button><p id="errVis" class="err"></p>`;
    const info = () => { const c = clienteDe($('#vCli').value); $('#vCliInfo').innerHTML = c ? `${c.condicionPago === 'credito' ? 'Crédito ' + c.diasCredito + ' días' : 'Contado'} · Por cobrar $ ${fmt(c.porCobrarUsd)}${c.pendientes.some(x => x.vencida) ? ' · <span class="pill mora">Tiene facturas vencidas</span>' : ''}` : ''; }; info(); $('#vCli').onchange = info;
    $('#atras').onclick = () => { vista.visita = null; pantallaPrincipal(); };
    $('#btnIniciarVis').onclick = async () => {
      const cid = $('#vCli').value, mot = [...document.querySelectorAll('.vMot:checked')].map(x => x.value); if (!cid) return ($('#errVis').textContent = 'Elige el cliente.'); if (!mot.length) return ($('#errVis').textContent = 'Marca al menos un motivo.');
      const ini = new Date().toISOString(); visitas.push({ id: nuevoIdVisita(), clienteId: cid, fecha: fechaLocalDe(ini), inicio: ini, fin: '', motivos: mot, observacion: $('#vObs').value.trim(), resultado: '', detalle: '', pedidoIds: [], automatica: false, sinCierre: false, estado: 'abierta', enviado: false });
      await guardarVisitas(); vista.visita = null; vista.pest = 'clientes'; vista.cli = cid; aviso('Visita iniciada'); pantallaPrincipal();
    };
    return;
  }
  const vi = visitas.find(x => x.id === v.id); if (!vi || vi.estado !== 'abierta') { vista.visita = null; return pantallaPrincipal(); }
  const c = clienteDe(vi.clienteId), docs = vi.pedidoIds.map(id => pedidos.find(x => x.id === id)).filter(Boolean), sug = docs.some(d => d.tipoDoc !== 'presupuesto') ? 'pedido' : docs.length ? 'presupuesto' : '';
  cuerpo.innerHTML = `<button class="atras" id="atras">‹ Volver a la visita</button><div class="tarjeta"><h3>Finalizar visita</h3><div class="chico">${esc(c ? c.nombre : '')} · ${vi.motivos.map(m => esc(MOTIVOS[m])).join(' · ')}${docs.length ? ' · ' + docs.length + ' documento(s) en esta visita' : ''}</div>
    <p class="etq" style="margin:12px 0 4px">¿Cómo terminó?</p>${Object.entries(RESULTADOS).map(([k, n]) => `<label class="chk"><input type="radio" name="vRes" value="${k}" ${k === sug ? 'checked' : ''}> ${n}</label>`).join('')}
    <div id="vFechaBox" style="display:none"><label for="vFechaProm">Fecha en que promete pagar</label><input type="date" id="vFechaProm" min="${hoyLocal()}"></div>
    <label for="vDet">Detalle (por ejemplo, por qué no pidió)</label><input id="vDet" maxlength="150" autocomplete="off"><label for="vObs">Observación</label><textarea id="vObs" rows="2" maxlength="300">${esc(vi.observacion)}</textarea></div>
    <button class="p" id="btnFinalizarVis">Finalizar visita</button><p id="errVis" class="err"></p>`;
  const mostrar = () => { const r = (document.querySelector('input[name=vRes]:checked') || {}).value; $('#vFechaBox').style.display = r === 'cobro_prometido' ? '' : 'none'; }; document.querySelectorAll('input[name=vRes]').forEach(r => { r.onchange = mostrar; }); mostrar();
  $('#atras').onclick = () => { vista.visita = null; vista.pest = 'clientes'; vista.cli = vi.clienteId; pantallaPrincipal(); };
  $('#btnFinalizarVis').onclick = async () => {
    const r = (document.querySelector('input[name=vRes]:checked') || {}).value; if (!r) return ($('#errVis').textContent = 'Elige cómo terminó la visita.');
    let det = $('#vDet').value.trim(); if (r === 'cobro_prometido') { const f = $('#vFechaProm').value; if (!f) return ($('#errVis').textContent = 'Indica la fecha en que promete pagar.'); det = ('Promete pagar el ' + fmtFecha(f) + (det ? ' · ' + det : '')).slice(0, 200); }
    Object.assign(vi, { estado: 'cerrada', fin: new Date().toISOString(), resultado: r, detalle: det, observacion: $('#vObs').value.trim(), enviado: false }); await guardarVisitas(); vista.visita = null; vista.pest = 'inicio'; vista.cli = null; aviso('Visita finalizada'); pantallaPrincipal(); enviarPendientes(false);
  };
}
function estadisticas() {
  const hoy = hoyLocal(), mes = hoy.slice(0, 7), rs = datos.resumen && datos.resumen.mes === mes ? datos.resumen : { docs: [], visitas: [] }, ids = new Set(rs.docs.map(d => d.id)), vids = new Set(rs.visitas.map(v => v.id));
  const locales = pedidos.filter(p => ['pendiente', 'enviado'].includes(p.estado) && !ids.has(p.id) && !['rechazado', 'invalido'].includes((ackDe(p) || {}).estado)).map(p => ({ id: p.id, fecha: p.fecha, tipoDoc: p.tipoDoc || 'pedido', estado: 'enviado', montoUsd: totalesPedido(p).total, aprobUsd: null }));
  const docs = rs.docs.concat(locales).filter(d => String(d.fecha).startsWith(mes)), vis = rs.visitas.concat(visitas.filter(v => !vids.has(v.id)).map(v => ({ id: v.id, fecha: v.fecha, clienteId: v.clienteId }))).filter(v => String(v.fecha).startsWith(mes));
  const sum = (a) => Math.round(a.reduce((t, x) => t + (x || 0), 0) * 100) / 100, ped = docs.filter(d => d.tipoDoc !== 'presupuesto'), pres = docs.filter(d => d.tipoDoc === 'presupuesto'), hoyP = ped.filter(d => d.fecha === hoy), vHoy = vis.filter(v => v.fecha === hoy);
  const ult = Object.assign({}, (datos.resumen && datos.resumen.ultimaVisita) || {}); visitas.forEach(v => { if (!ult[v.clienteId] || v.fecha > ult[v.clienteId]) ult[v.clienteId] = v.fecha; });
  const lim = datos.diasSinVisita || 30, sin = datos.clientes.map(c => ({ c, dias: ult[c.id] ? diasEntre(ult[c.id], hoy) : null })).filter(x => x.dias === null || x.dias > lim).sort((a, b) => (b.dias === null ? 1e9 : b.dias) - (a.dias === null ? 1e9 : a.dias));
  return { pedHoy: hoyP.length, montoHoy: sum(hoyP.map(d => d.montoUsd)), presHoy: pres.filter(d => d.fecha === hoy).length, cliHoy: new Set(vHoy.map(v => v.clienteId)).size, pedMes: ped.length, montoMes: sum(ped.map(d => d.montoUsd)), aprobMes: sum(ped.filter(d => d.estado === 'aprobado').map(d => d.aprobUsd)), presMes: pres.length, visMes: vis.length, cliMes: new Set(vis.map(v => v.clienteId)).size, sin, lim };
}
function vistaInicio() {
  const e = estadisticas(), m = datos.metas || {}, barra = (v, meta, txt) => meta ? `<div class="barra"><div style="width:${Math.min(100, Math.round(v / meta * 100))}%"></div></div><div class="chico">${txt} · ${Math.round(v / meta * 100)}%</div>` : '';
  $('#cuerpo').innerHTML = `${bannerVisita()}${visitaAbierta() ? '' : '<button class="p" id="btnIniVis" style="margin-top:0">Iniciar visita</button>'}<button class="${visitaAbierta() ? 'p' : 's'}" id="btnPedIni" ${visitaAbierta() ? 'style="margin-top:0"' : ''}>+ Nuevo pedido</button>
    <h3 class="sec">Hoy</h3><div class="kpis"><div class="kpi"><div class="chico">Pedidos</div><div class="kn" id="kPedHoy">${e.pedHoy}</div><div class="chico" id="kMontoHoy">$ ${fmt(e.montoHoy)}</div></div><div class="kpi"><div class="chico">Clientes visitados</div><div class="kn" id="kCliHoy">${e.cliHoy}</div>${e.presHoy ? `<div class="chico">${e.presHoy} presupuesto(s)</div>` : '<div class="chico">&nbsp;</div>'}</div></div>
    <h3 class="sec">Este mes</h3><div class="kpis"><div class="kpi"><div class="chico">Pedidos</div><div class="kn" id="kPedMes">${e.pedMes}</div><div class="chico" id="kMontoMes">$ ${fmt(e.montoMes)}</div><div class="chico" id="kAprobMes">Aprobado $ ${fmt(e.aprobMes)}</div></div><div class="kpi"><div class="chico">Visitas</div><div class="kn" id="kVisMes">${e.visMes}</div><div class="chico">${e.cliMes} cliente(s) distinto(s)</div>${e.presMes ? `<div class="chico">${e.presMes} presupuesto(s)</div>` : ''}</div></div>
    ${m.montoMensualUsd || m.visitasMensuales ? `<div class="tarjeta" id="metas"><h3>Metas del mes</h3>${barra(e.montoMes, m.montoMensualUsd, `$ ${fmt(e.montoMes)} de $ ${fmt(m.montoMensualUsd)}`)}${barra(e.visMes, m.visitasMensuales, `${e.visMes} de ${m.visitasMensuales} visitas`)}</div>` : ''}
    <details class="tarjeta" id="sinVisita"><summary><div class="fila"><h3>Sin visitar hace más de ${e.lim} días</h3><span class="precio">${e.sin.length}</span></div></summary>${e.sin.map(x => `<div class="fila" style="margin-top:6px" data-cli-ir="${esc(x.c.id)}" role="button"><span>${esc(x.c.nombre)}</span><span class="chico">${x.dias === null ? 'sin visitas registradas' : x.dias + ' días'}</span></div>`).join('') || '<p class="nota">Todos tus clientes tienen una visita reciente.</p>'}</details>
    <p class="nota">Incluye lo que aún no se ha sincronizado con la oficina. Los pedidos se cuentan al enviarlos.</p>`;
  const iv = $('#btnIniVis'); if (iv) iv.onclick = () => { vista.visita = { modo: 'inicio', clienteId: '' }; pantallaPrincipal(); }; $('#btnPedIni').onclick = () => nuevoPedido('');
  document.querySelectorAll('[data-cli-ir]').forEach(el => { el.onclick = () => { vista.pest = 'clientes'; vista.cli = el.dataset.cliIr; pantallaPrincipal(); }; }); enlazarBannerVisita();
}
/* Facturas vencidas (solo pantalla) */
const vencidasDe = () => { const r = []; datos.clientes.forEach(c => c.pendientes.filter(d => d.vencida).forEach(d => r.push({ c, d }))); return r.sort((a, b) => b.d.diasMora - a.d.diasMora); };
const nVencidas = () => vencidasDe().length;
function vistaVencidas() {
  const todas = vencidasDe(), tasa = datos.tasa ? datos.tasa.valor : null;
  $('#cuerpo').innerHTML = `<button class="atras" id="atras">‹ Clientes</button><div class="tarjeta"><h3>Facturas vencidas</h3><div id="vencResumen"></div></div><input id="buscarV" type="search" placeholder="Filtrar por cliente" value="${esc(vista.qv || '')}" autocomplete="off"><div id="listaVenc"></div><p class="nota">Saldos al ${esc(fmtTS(datos.generado))}; pueden haber cambiado después.</p>`;
  const pintar = () => { const q = norm(vista.qv || '').trim(), r = todas.filter(x => !q || norm(x.c.nombre + ' ' + x.c.documento).includes(q)), tot = Math.round(r.reduce((t, x) => t + x.d.pendUsd, 0) * 100) / 100;
    $('#vencResumen').innerHTML = `<div class="fila"><span>${r.length} factura(s) · ${new Set(r.map(x => x.c.id)).size} cliente(s)</span><span class="precio" id="vencTotal">$ ${fmt(tot)}</span></div>${tasa ? `<div class="chico" style="text-align:right">≈ Bs ${fmt(tot * tasa)}</div>` : ''}`;
    $('#listaVenc').innerHTML = r.map(x => `<div class="tarjeta" data-cli-ir="${esc(x.c.id)}" role="button"><div class="fila"><div><h3>${esc(x.c.nombre)}</h3><div class="chico">${esc(x.d.tipoDoc)} ${esc(x.d.numero)} · vence ${esc(fmtFecha(x.d.vencimiento))}</div><div style="margin-top:6px"><span class="pill mora">${x.d.diasMora} día(s) vencida</span></div></div><div class="precio">$ ${fmt(x.d.pendUsd)}</div></div></div>`).join('') || '<p class="nota">No hay facturas vencidas con ese filtro.</p>';
    document.querySelectorAll('[data-cli-ir]').forEach(el => { el.onclick = () => { vista.venc = false; vista.cli = el.dataset.cliIr; pantallaPrincipal(); }; }); };
  $('#buscarV').oninput = (e) => { vista.qv = e.target.value; pintar(); }; $('#atras').onclick = () => { vista.venc = false; pantallaPrincipal(); }; pintar();
}
/* Catálogo digital */
const urlSegura = (u) => /^https?:\/\/[^\s]+$/i.test(u || '');
const catalogoBoton = () => (datos.catalogo && urlSegura(datos.catalogo.url)) ? `<a class="boton-enlace" id="lnkCatalogo" href="${esc(datos.catalogo.url)}" target="_blank" rel="noopener noreferrer">Ver catálogo digital</a>` : '';
const enlaceArticulo = (a) => { const pl = datos.catalogo && datos.catalogo.plantilla; if (!pl || !pl.includes('{codigo}') || !a.codigo) return ''; const u = pl.split('{codigo}').join(encodeURIComponent(a.codigo)); return urlSegura(u) ? `<a class="lnk-art" href="${esc(u)}" target="_blank" rel="noopener noreferrer">Ver ficha o foto del artículo</a>` : ''; };
/* Texto para compartir */
const telWa = (t) => { const d = String(t || '').replace(/\D/g, ''); if (d.startsWith('58') && d.length >= 12) return d; if (d.startsWith('0') && d.length === 11) return '58' + d.slice(1); if (d.length === 10) return '58' + d; return ''; };
function enviarWhatsApp(texto, tel) { window.open('https://wa.me/' + telWa(tel) + '?text=' + encodeURIComponent(texto), '_blank', 'noopener'); }
async function compartirTexto(texto) {
  if (navigator.share) { try { await navigator.share({ text: texto }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(texto); aviso('Texto copiado: pégalo donde quieras enviarlo'); } catch (e) { aviso('No se pudo compartir el texto', true); }
}
const montoTxt = (usd) => { const t = datos.tasa ? datos.tasa.valor : null; return `$ ${fmt(usd)}` + (t ? ` (Bs ${fmt(usd * t)})` : ''); };
function textoPresupuesto(p) {
  const c = clienteDe(p.clienteId), t = totalesPedido(p), lp = t.lista, ack = ackDe(p), num = ack && ack.numero ? ack.numero : '', l = ['*PRESUPUESTO*' + (num ? ' ' + num : ''), cfg.empresa, '', 'Cliente: ' + (c ? c.nombre : ''), `Fecha: ${fmtFecha(p.fecha)} · Vigente hasta: ${fmtFecha(p.vigenteHasta)}`, ''];
  p.lineas.forEach((x, i) => { const a = artDe(x.productoId), pr = a && a.precios ? a.precios[lp] : null, iva = a && a.alicuota ? a.alicuota : 0; l.push(`${i + 1}. ${a ? a.descripcion : '(artículo)'} (${a ? a.codigo : ''})`, `   ${fmt(x.cantidad, x.cantidad % 1 ? 2 : 0)} x $ ${pr == null ? '—' : fmt(pr)}${iva ? ' + IVA ' + iva + '%' : ''} = $ ${pr == null ? '—' : fmt(x.cantidad * pr * (1 + iva / 100))}`); });
  l.push('', `Base: $ ${fmt(t.base)}`, `IVA: $ ${fmt(t.iva)}`, `*Total: ${montoTxt(t.total)}*`, '', num ? 'Sujeto a confirmación de existencia y precios.' : `Ref. ${p.id.slice(-8).toUpperCase()} · Presupuesto referencial, sujeto a confirmación de existencia y precios.`, 'Atiende: ' + datos.vendedor.nombre);
  return l.join('\n');
}
function textoPedidoAprobado(p, ack) {
  const c = clienteDe(p.clienteId), ap = ack.aprobado, l = ['*PEDIDO ' + (ack.numero || '') + '*', cfg.empresa, '', 'Cliente: ' + (c ? c.nombre : ''), `Fecha: ${fmtFecha(ap.fecha || p.fecha)}${p.fechaEntrega ? ' · Entrega: ' + fmtFecha(p.fechaEntrega) : ''}`, ''];
  ap.lineas.forEach((x, i) => l.push(`${i + 1}. ${x.descripcion} (${x.codigo})`, `   ${fmt(x.cantidad, x.cantidad % 1 ? 2 : 0)} x $ ${fmt(x.precioUsd)} = $ ${fmt(x.totalUsd)}`));
  l.push('', `Base: $ ${fmt(ap.baseUsd)}`, `IVA: $ ${fmt(ap.ivaUsd)}`, `*Total: $ ${fmt(ap.totalUsd)} (Bs ${fmt(ap.totalBs)})*`, '', 'Atiende: ' + datos.vendedor.nombre);
  return l.join('\n');
}
function textoEstadoCuenta(c) {
  const hoy = hoyLocal(), tot = Math.round(c.pendientes.reduce((t, d) => t + d.pendUsd, 0) * 100) / 100, venc = Math.round(c.pendientes.filter(d => d.vencida).reduce((t, d) => t + d.pendUsd, 0) * 100) / 100;
  const l = ['*Estado de cuenta*', cfg.empresa, '', 'Cliente: ' + c.nombre, 'Saldos al ' + fmtTS(datos.generado), ''];
  c.pendientes.forEach(d => l.push(`• ${d.tipoDoc} ${d.numero}: emitida ${fmtFecha(d.fecha)}, vence ${fmtFecha(d.vencimiento)}${d.vencida ? ` (vencida hace ${d.diasMora} día${d.diasMora === 1 ? '' : 's'})` : ''} — $ ${fmt(d.pendUsd)}`));
  l.push('', `*Total por cobrar: ${montoTxt(tot)}*`); if (venc) l.push(`Vencido: $ ${fmt(venc)}`); l.push('', 'Si ya realizó el pago, por favor envíenos el comprobante. Gracias.', 'Atiende: ' + datos.vendedor.nombre);
  return l.join('\n');
}

/* ---- Documento en imagen (PNG): se comparte por WhatsApp, correo o cualquier app, o se descarga ---- */
function modeloDocumento(p, ack) {
  const c = clienteDe(p.clienteId), presu = p.tipoDoc === 'presupuesto';
  if (!presu && ack && ack.aprobado) { const ap = ack.aprobado; return { titulo: 'PEDIDO ' + (ack.numero || ''), cliente: c, fecha: ap.fecha || p.fecha, extra: p.fechaEntrega ? 'Entrega: ' + fmtFecha(p.fechaEntrega) : '', lineas: ap.lineas.map(x => ({ d: x.descripcion, k: x.codigo, c: x.cantidad, pr: x.precioUsd, t: x.totalUsd })), base: ap.baseUsd, iva: ap.ivaUsd, total: ap.totalUsd, bs: ap.totalBs, nota: '' }; }
  const t = totalesPedido(p), lp = t.lista, num = ack && ack.numero ? ack.numero : '';
  return { titulo: 'PRESUPUESTO' + (num ? ' ' + num : ''), cliente: c, fecha: p.fecha, extra: 'Vigente hasta: ' + fmtFecha(p.vigenteHasta),
    lineas: p.lineas.map(x => { const a = artDe(x.productoId), pr = a && a.precios ? a.precios[lp] : null; return { d: a ? a.descripcion : '(artículo)', k: a ? a.codigo : '', c: x.cantidad, pr, t: pr == null ? null : Math.round(Number(x.cantidad) * pr * 100) / 100 }; }),
    base: t.base, iva: t.iva, total: t.total, bs: datos.tasa ? Math.round(t.total * datos.tasa.valor * 100) / 100 : null, nota: 'Presupuesto sujeto a confirmación de existencia y precios.' };
}
function dibujarDocumento(m) {
  const W = 800, M = 36, cv = document.createElement('canvas'), medir = cv.getContext('2d'); medir.font = '15px sans-serif';
  const partir = (txt, ancho) => { const pal = String(txt).split(' '), out = []; let cur = ''; pal.forEach(w => { const prueba = cur ? cur + ' ' + w : w; if (medir.measureText(prueba).width > ancho && cur) { out.push(cur); cur = w; } else cur = prueba; }); if (cur) out.push(cur); return out; };
  const cols = { cant: W - M - 300, pr: W - M - 170, tot: W - M }, anchoDesc = cols.cant - M - 60;
  const filas = m.lineas.map(l => ({ l, txt: partir(l.d, anchoDesc) })), altoFilas = filas.reduce((t, f) => t + 24 + f.txt.length * 20, 0);
  cv.width = W; cv.height = 250 + altoFilas + 190 + (m.nota ? 30 : 0);
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, cv.height);
  g.fillStyle = '#0f766e'; g.fillRect(0, 0, W, 78); g.fillStyle = '#fff'; g.font = 'bold 24px sans-serif'; g.fillText(m.titulo, M, 36); g.font = '15px sans-serif'; g.fillText(cfg.empresa || '', M, 62);
  g.fillStyle = '#0f172a'; g.font = 'bold 18px sans-serif'; g.fillText('Cliente: ' + (m.cliente ? m.cliente.nombre : ''), M, 112);
  g.font = '15px sans-serif'; g.fillStyle = '#475569'; g.fillText('Fecha: ' + fmtFecha(m.fecha) + (m.extra ? ' · ' + m.extra : ''), M, 136); if (m.cliente && m.cliente.documento) g.fillText('RIF / C.I.: ' + m.cliente.documento, M, 158);
  let y = 184; g.fillStyle = '#e2e8f0'; g.fillRect(M, y, W - 2 * M, 26); g.fillStyle = '#334155'; g.font = 'bold 14px sans-serif'; g.fillText('Artículo', M + 8, y + 18); g.textAlign = 'right'; g.fillText('Cant.', cols.cant, y + 18); g.fillText('Precio $', cols.pr, y + 18); g.fillText('Total $', cols.tot - 6, y + 18); g.textAlign = 'left'; y += 26;
  filas.forEach(f => { g.fillStyle = '#0f172a'; g.font = '15px sans-serif'; f.txt.forEach((t, i) => g.fillText(t, M + 8, y + 22 + i * 20));
    const yy = y + 22; g.textAlign = 'right'; g.fillText(fmt(f.l.c, f.l.c % 1 ? 2 : 0), cols.cant, yy); g.fillText(f.l.pr == null ? '—' : fmt(f.l.pr), cols.pr, yy); g.fillText(f.l.t == null ? '—' : fmt(f.l.t), cols.tot - 6, yy); g.textAlign = 'left';
    const h = 24 + f.txt.length * 20 - 20 + 4; g.fillStyle = '#64748b'; g.font = '12px sans-serif'; g.fillText(f.l.k || '', M + 8, y + 22 + f.txt.length * 20 - 4 + 0); y += 24 + f.txt.length * 20; g.strokeStyle = '#e2e8f0'; g.beginPath(); g.moveTo(M, y); g.lineTo(W - M, y); g.stroke(); });
  y += 24; g.textAlign = 'right'; g.fillStyle = '#334155'; g.font = '16px sans-serif'; g.fillText('Base: $ ' + fmt(m.base), W - M - 6, y); y += 24; g.fillText('IVA: $ ' + fmt(m.iva), W - M - 6, y); y += 32;
  g.fillStyle = '#0f766e'; g.font = 'bold 22px sans-serif'; g.fillText('Total: $ ' + fmt(m.total), W - M - 6, y); if (m.bs != null) { y += 26; g.font = '16px sans-serif'; g.fillText('Bs ' + fmt(m.bs), W - M - 6, y); }
  g.textAlign = 'left'; y += 40; g.fillStyle = '#475569'; g.font = '14px sans-serif'; if (m.nota) { g.fillText(m.nota, M, y); y += 26; } g.fillText('Atiende: ' + datos.vendedor.nombre, M, y);
  return cv;
}
const nombreArchivoDoc = (m) => (m.titulo.replace(/[^\w-]+/g, '-').replace(/-+$/, '') + '-' + (m.cliente ? m.cliente.nombre.replace(/[^\w]+/g, '-').slice(0, 20) : '')).replace(/-+$/, '') + '.png';
function imagenDocumento(p, ack) { const m = modeloDocumento(p, ack), cv = dibujarDocumento(m); return new Promise(res => cv.toBlob(b => res({ blob: b, nombre: nombreArchivoDoc(m), titulo: m.titulo }), 'image/png')); }
async function compartirImagen(p, ack) {
  const im = await imagenDocumento(p, ack); if (!im.blob) { aviso('No se pudo generar la imagen', true); return; }
  const f = new File([im.blob], im.nombre, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [f] })) { try { await navigator.share({ files: [f], title: im.titulo }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  descargarImagen(im);
}
function descargarImagen(im) { const a = document.createElement('a'); a.href = URL.createObjectURL(im.blob); a.download = im.nombre; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); aviso('Imagen guardada en descargas'); }

/* ---------- Pedidos ---------- */
const hoyLocal = () => new Date().toLocaleDateString('en-CA');
const lista_de = (c) => { const ls = datos.listasPrecio || []; return (ls.find(l => l.id === (c && c.listaPrecioId)) || ls[0] || {}).id || ''; };
const clienteDe = (id) => datos.clientes.find(c => c.id === id);
const artDe = (id) => datos.articulos.find(a => a.id === id);
function totalesPedido(p) {
  const c = clienteDe(p.clienteId), lp = lista_de(c); let base = 0, iva = 0, sinPrecio = 0;
  p.lineas.forEach(l => { const a = artDe(l.productoId); const pr = a && a.precios ? a.precios[lp] : null; if (pr == null || pr === '') { sinPrecio++; return; } const b = Math.round(Number(l.cantidad) * pr * 100) / 100; base += b; iva += Math.round(b * (a.alicuota || 0)) / 100; });
  base = Math.round(base * 100) / 100; iva = Math.round(iva * 100) / 100; return { base, iva, total: Math.round((base + iva) * 100) / 100, sinPrecio, lista: lp };
}
async function guardarPedidos() { await kvSet('pedidos', await sellar(pedidos, pinKey)); }
const ackDe = (p) => (datos && datos.pedidos || []).find(x => x.id === p.id);
function estadoPedido(p) { // lo que ve el vendedor: primero lo que dice la oficina, si ya lo recibió
  const a = p.estado === 'enviado' ? ackDe(p) : null;
  if (a) return { k: a.estado, txt: { recibido: 'Recibido por la oficina', aprobado: 'Aprobado' + (a.numero ? ' · ' + a.numero : ''), registrado: 'Presupuesto registrado' + (a.numero ? ' · ' + a.numero : ''), rechazado: 'Rechazado', invalido: 'No válido' }[a.estado] || a.estado, motivo: a.motivo };
  return { k: p.estado, txt: { borrador: 'Borrador', pendiente: 'Pendiente de envío', enviado: 'Enviado, esperando a la oficina' }[p.estado] || p.estado };
}
const PILL_PED = { borrador: '', pendiente: 'mora', enviado: '', recibido: '', aprobado: 'ok', registrado: 'ok', rechazado: 'mora', invalido: 'mora' };
function nuevoPedido(clienteId, desde, tipoDoc) {
  const ab = visitaAbierta(); if (!clienteId && ab) clienteId = ab.clienteId;
  borrador = { id: '', tipoDoc: tipoDoc || 'pedido', inicio: new Date().toISOString(), origenPresupuesto: desde && desde.tipoDoc === 'presupuesto' && (tipoDoc || 'pedido') === 'pedido' ? desde.id : '', clienteId: clienteId || '', fecha: hoyLocal(), fechaEntrega: '', observacion: '', lineas: desde ? desde.lineas.map(l => ({ productoId: l.productoId, cantidad: l.cantidad })) : [], picker: false, q: '' };
  vista.pest = 'pedidos'; vista.ped = 'editor'; pantallaPrincipal();
}
function vistaPedidos() {
  if (vista.ped === 'editor' && borrador) return vistaEditorPedido();
  if (vista.ped && vista.ped !== 'editor') return vistaDetallePedido(pedidos.find(p => p.id === vista.ped));
  const ord = pedidos.slice().sort((a, b) => (a.creado < b.creado ? 1 : -1));
  $('#cuerpo').innerHTML = `<div class="fila" style="gap:8px"><button class="p" id="btnNuevoPed" style="margin-top:0">+ Pedido</button><button class="s" id="btnNuevoPresu" style="margin-top:0">+ Presupuesto</button></div>
    ${ord.map(p => { const c = clienteDe(p.clienteId), e = estadoPedido(p), t = totalesPedido(p); return `<div class="tarjeta" data-ped="${esc(p.id)}" role="button"><div class="fila"><div><h3>${esc(c ? c.nombre : '(cliente)')}</h3><div class="chico">${p.tipoDoc === 'presupuesto' ? '<b>Presupuesto</b> · ' : ''}${esc(fmtFecha(p.fecha))} · ${p.lineas.length} artículo(s)</div><div style="margin-top:6px"><span class="pill ${PILL_PED[e.k] || ''}">${esc(e.txt)}</span></div></div><div class="precio">$ ${fmt(t.total)}</div></div></div>`; }).join('') || '<p class="nota">Aún no has hecho pedidos. Los pedidos se guardan en el teléfono y se envían a la oficina cuando hay señal; allí los revisan y los aprueban.</p>'}`;
  $('#btnNuevoPed').onclick = () => nuevoPedido(''); $('#btnNuevoPresu').onclick = () => nuevoPedido('', null, 'presupuesto');
  document.querySelectorAll('[data-ped]').forEach(el => { el.onclick = () => { vista.ped = el.dataset.ped; pantallaPrincipal(); }; });
}
function vistaEditorPedido() {
  const b = borrador, c = clienteDe(b.clienteId), t = totalesPedido(b), cs = datos.clientes.slice().sort((x, y) => x.nombre.localeCompare(y.nombre, 'es')), cuerpo = $('#cuerpo');
  if (b.picker) return pintarSelectorArticulo();
  cuerpo.innerHTML = `<button class="atras" id="atras">‹ Pedidos</button><div class="tarjeta"><h3>${b.id ? 'Editar' : 'Nuevo'} ${esc(TIPOS_DOC[b.tipoDoc].toLowerCase())}</h3>
    <div class="seg" role="radiogroup" aria-label="Tipo de documento">${Object.entries(TIPOS_DOC).map(([k, n]) => `<label class="${b.tipoDoc === k ? 'on' : ''}"><input type="radio" name="pTipo" value="${k}" ${b.tipoDoc === k ? 'checked' : ''}> ${n}</label>`).join('')}</div>
    <label for="pCli">Cliente</label><select id="pCli"><option value="">Elige…</option>${cs.map(x => `<option value="${esc(x.id)}" ${x.id === b.clienteId ? 'selected' : ''}>${esc(x.nombre)}</option>`).join('')}</select>
    ${c ? `<div class="chico" style="margin-top:6px">${c.condicionPago === 'credito' ? `Crédito ${c.diasCredito} días` : 'Contado'} · Por cobrar $ ${fmt(c.porCobrarUsd)}${c.limiteCreditoUsd != null ? ' de $ ' + fmt(c.limiteCreditoUsd) : ''}${c.pendientes.some(x => x.vencida) ? ' · <span class="pill mora">Tiene facturas vencidas</span>' : ''}</div>` : ''}
    <div class="fila" style="gap:10px"><div style="flex:1"><label for="pFecha">Fecha del ${b.tipoDoc === 'presupuesto' ? 'presupuesto' : 'pedido'}</label><input type="date" id="pFecha" max="${hoyLocal()}" value="${esc(b.fecha)}"></div>${b.tipoDoc === 'presupuesto' ? `<div style="flex:1"><label>Vigente hasta</label><div class="chico" id="pVig" style="padding:12px 0"><b>${esc(fmtFecha(sumarDias(b.fecha, PRESUP_DIAS)))}</b> (${PRESUP_DIAS} días)</div></div>` : `<div style="flex:1"><label for="pEntrega">Fecha de entrega</label><input type="date" id="pEntrega" min="${esc(b.fecha)}" value="${esc(b.fechaEntrega)}"></div>`}</div>
    ${b.tipoDoc === 'presupuesto' ? '<p class="nota" style="margin-top:0">El presupuesto no reserva mercancía y los precios pueden cambiar. La oficina lo registra solo, sin aprobación.</p>' : ''}${(() => { const ab = visitaAbierta(); return ab && clienteDe(ab.clienteId) ? `<p class="chico">Visita en curso: ${esc(clienteDe(ab.clienteId).nombre)}</p>` : ''; })()}
    <label for="pObs">Observación</label><textarea id="pObs" rows="2" maxlength="300">${esc(b.observacion)}</textarea></div>
  <div class="tarjeta"><div class="fila"><h3>Artículos</h3><span class="chico">Lista: ${esc(((datos.listasPrecio || []).find(l => l.id === t.lista) || {}).nombre || '')}</span></div><div id="lineasPed">${b.lineas.map((l, i) => lineaEditor(l, i, t.lista)).join('') || '<p class="nota">Aún no hay artículos.</p>'}</div>
    <button class="s" id="btnAddArt">+ Agregar artículo</button></div>
  <div class="tarjeta" id="totPed"></div>
  <button class="p" id="btnEnviarPed">Enviar ${esc(TIPOS_DOC[b.tipoDoc].toLowerCase())}</button><button class="s" id="btnGuardarBorr">Guardar borrador</button><button class="s peligro" id="btnCancelarPed">Cancelar</button><p id="errPed" class="err"></p>`;
  const leer = () => { b.clienteId = $('#pCli').value; b.fecha = $('#pFecha').value || hoyLocal(); const pe = $('#pEntrega'); if (pe) b.fechaEntrega = pe.value; b.observacion = $('#pObs').value.trim(); };
  $('#pCli').onchange = () => { leer(); vistaEditorPedido(); }; ['pFecha', 'pEntrega', 'pObs'].forEach(id => { const e = $('#' + id); if (e) { e.onchange = id === 'pFecha' ? () => { leer(); vistaEditorPedido(); } : leer; e.oninput = leer; } });
  document.querySelectorAll('input[name=pTipo]').forEach(r => { r.onchange = () => { leer(); b.tipoDoc = r.value; if (b.tipoDoc === 'presupuesto') b.fechaEntrega = ''; vistaEditorPedido(); }; });
  $('#atras').onclick = () => { leer(); salirEditor(); };
  document.querySelectorAll('.qPed').forEach(inp => { inp.oninput = () => { const v = Number(String(inp.value).replace(',', '.')); b.lineas[Number(inp.dataset.i)].cantidad = v; actualizarTotalesPedido(); avisoExistencia(inp); }; });
  document.querySelectorAll('.delPed').forEach(bt => { bt.onclick = () => { leer(); b.lineas.splice(Number(bt.dataset.i), 1); vistaEditorPedido(); }; });
  $('#btnAddArt').onclick = () => { leer(); b.picker = true; b.q = ''; vistaEditorPedido(); };
  $('#btnGuardarBorr').onclick = async () => { leer(); const e = validarPedido(b, true); if (e) return ($('#errPed').textContent = e); await guardarBorrador('borrador'); aviso('Borrador guardado'); salirEditor(); };
  $('#btnEnviarPed').onclick = async () => { leer(); const e = validarPedido(b, false); if (e) return ($('#errPed').textContent = e); const p = await guardarBorrador('pendiente'); salirEditor(); await enviarPendientes(true); };
  $('#btnCancelarPed').onclick = () => { if (!b.lineas.length || confirm('Se descartarán los cambios. ¿Continuar?')) salirEditor(); };
  actualizarTotalesPedido();
}
function lineaEditor(l, i, lp) {
  const a = artDe(l.productoId); if (!a) return '';
  const pr = a.precios ? a.precios[lp] : null, ex = a.manejaInventario ? a.existencia : null;
  return `<div style="border-top:1px solid var(--borde);padding:8px 0"><div class="fila"><div><b>${esc(a.descripcion)}</b><div class="chico">${esc(a.codigo)} · ${pr == null ? '<span style="color:var(--rojo)">sin precio en esta lista</span>' : '$ ' + fmt(pr) + (a.alicuota ? ' + IVA ' + a.alicuota + '%' : '')}</div></div>
    <div style="display:flex;gap:6px;align-items:center"><input class="qPed" data-i="${i}" inputmode="decimal" value="${esc(String(l.cantidad).replace('.', ','))}" style="width:5.5rem;text-align:right" aria-label="Cantidad de ${esc(a.codigo)}"><button class="atras delPed" data-i="${i}" aria-label="Quitar" style="color:var(--rojo)">✕</button></div></div>
    <div class="chico avisoEx" data-i="${i}" style="color:var(--ambar)">${ex != null && Number(l.cantidad) > ex ? `Existencia ${fmt(ex, 0)}: el pedido supera lo disponible` : ''}</div></div>`;
}
function avisoExistencia(inp) { const i = Number(inp.dataset.i), l = borrador.lineas[i], a = artDe(l.productoId), el = document.querySelector(`.avisoEx[data-i="${i}"]`); if (el) el.textContent = a && a.manejaInventario && Number(l.cantidad) > a.existencia ? `Existencia ${fmt(a.existencia, 0)}: el pedido supera lo disponible` : ''; }
function actualizarTotalesPedido() {
  const t = totalesPedido(borrador), tasa = datos.tasa ? datos.tasa.valor : null, el = $('#totPed'); if (!el) return;
  el.innerHTML = `<div class="fila"><span>Base</span><span>$ ${fmt(t.base)}</span></div><div class="fila"><span>IVA</span><span>$ ${fmt(t.iva)}</span></div><div class="fila total"><span>Total</span><span class="precio">$ ${fmt(t.total)}</span></div>${tasa ? `<div class="chico" style="text-align:right">≈ Bs ${fmt(t.total * tasa)}</div>` : ''}<div class="nota">Los precios son los de la lista del cliente y no se pueden cambiar. La oficina los confirma al aprobar.</div>`;
}
function validarPedido(b, borr) {
  if (!b.clienteId) return 'Elige el cliente.'; if (!b.lineas.length) return 'Agrega al menos un artículo.';
  if (b.lineas.some(l => !(Number(l.cantidad) > 0))) return 'Todas las cantidades deben ser mayores que cero.';
  if (b.tipoDoc !== 'presupuesto' && b.fechaEntrega && b.fechaEntrega < b.fecha) return 'La fecha de entrega no puede ser anterior a la del pedido.';
  const ab = visitaAbierta(); if (!borr && ab && ab.clienteId !== b.clienteId) { const vc = clienteDe(ab.clienteId); return `Tienes una visita abierta con ${vc ? vc.nombre : 'otro cliente'}: finalízala antes de enviar un documento para otro cliente.`; }
  if (!borr && totalesPedido(b).sinPrecio) return 'Hay artículos sin precio en la lista del cliente: quítalos para enviar.'; return '';
}
async function guardarBorrador(estado) {
  const b = borrador; let p = b.id && pedidos.find(x => x.id === b.id);
  const presu = b.tipoDoc === 'presupuesto', datosP = { tipoDoc: b.tipoDoc || 'pedido', vigenteHasta: presu ? sumarDias(b.fecha, PRESUP_DIAS) : '', origenPresupuesto: b.origenPresupuesto || '', clienteId: b.clienteId, fecha: b.fecha, fechaEntrega: presu ? '' : b.fechaEntrega, observacion: b.observacion, lineas: b.lineas.map(l => ({ productoId: l.productoId, cantidad: Number(l.cantidad) })), estado, error: '' };
  if (p) Object.assign(p, datosP); else { p = Object.assign({ id: nuevoIdPedido(), creado: new Date().toISOString() }, datosP); pedidos.push(p); }
  b.id = p.id; if (estado === 'pendiente') { vincularVisita(p, b.inicio); await guardarVisitas(); } await guardarPedidos(); return p;
}
function nuevoIdPedido() { const d = new Date(), z = (n) => String(n).padStart(2, '0'), r = [...crypto.getRandomValues(new Uint8Array(4))].map(x => x.toString(16).padStart(2, '0')).join(''); return `PED-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}-${r}`; }
function salirEditor() { borrador = null; vista.ped = null; pantallaPrincipal(); }
function pintarSelectorArticulo() {
  const b = borrador, t = totalesPedido(b); $('#cuerpo').innerHTML = `<button class="atras" id="atrasSel">‹ Volver al pedido</button><input id="selQ" type="search" placeholder="Buscar artículo por código o nombre" value="${esc(b.q)}" autocomplete="off"><div id="selLista"></div>`;
  const pintar = () => { const q = norm(b.q).trim(); const r = datos.articulos.filter(a => (!q || norm([a.codigo, a.descripcion, a.codigoBarras].join(' ')).includes(q))).slice(0, 60);
    $('#selLista').innerHTML = r.map(a => { const pr = a.precios ? a.precios[t.lista] : null, ya = b.lineas.find(l => l.productoId === a.id); return `<div class="tarjeta" data-art="${esc(a.id)}" role="button"><div class="fila"><div><h3>${esc(a.descripcion)}</h3><div class="chico">${esc(a.codigo)}${a.manejaInventario ? ' · existencia ' + fmt(a.existencia, 0) : ''}${ya ? ' · <b>ya agregado (' + ya.cantidad + ')</b>' : ''}</div></div><div class="precio">${pr == null ? '—' : '$ ' + fmt(pr)}</div></div></div>`; }).join('') || '<p class="nota">No hay artículos con ese texto.</p>';
    document.querySelectorAll('[data-art]').forEach(el => { el.onclick = () => { const l = b.lineas.find(x => x.productoId === el.dataset.art); if (l) l.cantidad = Number(l.cantidad) + 1; else b.lineas.push({ productoId: el.dataset.art, cantidad: 1 }); aviso('Agregado'); pintar(); }; }); };
  $('#selQ').oninput = (e) => { b.q = e.target.value; pintar(); }; $('#atrasSel').onclick = () => { b.picker = false; vistaEditorPedido(); }; pintar();
}
function vistaDetallePedido(p) {
  if (!p) { vista.ped = null; return vistaPedidos(); }
  const c = clienteDe(p.clienteId), e = estadoPedido(p), t = totalesPedido(p), editable = p.estado === 'borrador' || p.estado === 'pendiente', lp = t.lista, presu = p.tipoDoc === 'presupuesto', ack = p.estado === 'enviado' ? ackDe(p) : null, ap = ack && ack.aprobado, vencido = presu && p.vigenteHasta && p.vigenteHasta < hoyLocal(), nombreDoc = presu ? 'Presupuesto' : 'Pedido';
  $('#cuerpo').innerHTML = `<button class="atras" id="atras">‹ Pedidos</button><div class="tarjeta"><div class="fila"><h3>${esc(c ? c.nombre : '(cliente)')}</h3><span class="pill ${PILL_PED[e.k] || ''}">${esc(e.txt)}</span></div>
    <div class="chico">${nombreDoc} del ${esc(fmtFecha(p.fecha))}${presu ? ' · vigente hasta ' + esc(fmtFecha(p.vigenteHasta)) + (vencido ? ' <span class="pill mora">Vencido</span>' : '') : p.fechaEntrega ? ' · entrega ' + esc(fmtFecha(p.fechaEntrega)) : ''}</div>${p.observacion ? `<div class="chico">Observación: ${esc(p.observacion)}</div>` : ''}${e.motivo ? `<p class="err">Motivo: ${esc(e.motivo)}</p>` : ''}${p.error ? `<p class="err">${esc(p.error)}</p>` : ''}
    <table style="margin-top:8px"><thead><tr><th>${ap ? 'Lo que pediste' : 'Artículo'}</th><th class="n">Cant.</th><th class="n">Total $</th></tr></thead><tbody>${p.lineas.map(l => { const a = artDe(l.productoId), pr = a && a.precios ? a.precios[lp] : null; return `<tr><td>${esc(a ? a.descripcion : '(artículo)')}<div class="chico">${esc(a ? a.codigo : '')}</div></td><td class="n">${fmt(l.cantidad, l.cantidad % 1 ? 2 : 0)}</td><td class="n">${pr == null ? '—' : fmt(l.cantidad * pr * (1 + ((a.alicuota || 0) / 100)))}</td></tr>`; }).join('')}</tbody></table>
    <div class="fila total" style="margin-top:6px"><span>Total</span><span class="precio">$ ${fmt(t.total)}</span></div></div>
  ${ap ? `<div class="tarjeta aviso-msg"><h3>Aprobado por la oficina${ap.editado ? ' (con cambios)' : ''}</h3><table><thead><tr><th>Artículo</th><th class="n">Cant.</th><th class="n">Precio</th><th class="n">Total $</th></tr></thead><tbody>${ap.lineas.map(l => `<tr><td>${esc(l.descripcion)}<div class="chico">${esc(l.codigo)}</div></td><td class="n">${fmt(l.cantidad, l.cantidad % 1 ? 2 : 0)}</td><td class="n">${fmt(l.precioUsd)}</td><td class="n">${fmt(l.totalUsd)}</td></tr>`).join('')}</tbody></table>
    <div class="fila total" style="margin-top:6px"><span>Total ${esc(ack.numero || '')}</span><span class="precio">$ ${fmt(ap.totalUsd)}</span></div><div class="chico" style="text-align:right">Bs ${fmt(ap.totalBs)}</div></div>` : ''}
  ${p.estado === 'pendiente' ? '<button class="p" id="btnReenviar">Enviar ahora</button>' : ''}
  ${presu || ap ? '<button class="p" id="btnWaDoc">Enviar por WhatsApp al cliente</button><button class="s" id="btnCompDoc">Compartir texto…</button><button class="p" id="btnImgDoc">Compartir como imagen (WhatsApp, correo…)</button><button class="s" id="btnImgBajar">Descargar imagen</button>' : ''}${presu ? '<button class="s" id="btnConvertir">Convertir en pedido</button>' : ''}
  ${editable ? '<button class="s" id="btnEditarPed">Editar</button>' : ''}<button class="s" id="btnDuplicar">Hacer un ${presu ? 'presupuesto' : 'pedido'} nuevo igual</button>${editable || ['rechazado', 'invalido'].includes(e.k) ? '<button class="s peligro" id="btnEliminarPed">Eliminar del teléfono</button>' : ''}`;
  $('#atras').onclick = () => { vista.ped = null; pantallaPrincipal(); };
  const r = $('#btnReenviar'); if (r) r.onclick = () => enviarPendientes(true);
  const texto = () => presu ? textoPresupuesto(p) : textoPedidoAprobado(p, ack);
  const bw = $('#btnWaDoc'); if (bw) bw.onclick = () => enviarWhatsApp(texto(), c && c.telefono); const bc = $('#btnCompDoc'); if (bc) bc.onclick = () => compartirTexto(texto());
  const bi = $('#btnImgDoc'); if (bi) bi.onclick = () => compartirImagen(p, ack); const bb = $('#btnImgBajar'); if (bb) bb.onclick = async () => descargarImagen(await imagenDocumento(p, ack));
  const cv = $('#btnConvertir'); if (cv) cv.onclick = () => { if (vencido) aviso('El presupuesto está vencido: el pedido tomará los precios de hoy'); nuevoPedido(p.clienteId, p, 'pedido'); };
  const ed = $('#btnEditarPed'); if (ed) ed.onclick = () => { borrador = { id: p.id, tipoDoc: p.tipoDoc || 'pedido', inicio: p.creado, origenPresupuesto: p.origenPresupuesto || '', clienteId: p.clienteId, fecha: p.fecha, fechaEntrega: p.fechaEntrega, observacion: p.observacion, lineas: p.lineas.map(l => ({ productoId: l.productoId, cantidad: l.cantidad })), picker: false, q: '' }; vista.ped = 'editor'; pantallaPrincipal(); };
  $('#btnDuplicar').onclick = () => nuevoPedido(p.clienteId, p, p.tipoDoc || 'pedido');
  const el = $('#btnEliminarPed'); if (el) el.onclick = async () => { if (!confirm('¿Eliminar este documento del teléfono?')) return; pedidos = pedidos.filter(x => x.id !== p.id); await guardarPedidos(); vista.ped = null; pantallaPrincipal(); };
}

/* ---- Envío de pedidos: archivo cifrado a la carpeta «entrada» del vendedor en Dropbox ---- */
async function cifrarPedido(p) {
  return cifrarObjeto({ formato: 1, id: p.id, vm: cfg.s, creado: p.creado, fecha: p.fecha, fechaEntrega: p.fechaEntrega || '', tipoDoc: p.tipoDoc || 'pedido', vigenteHasta: p.vigenteHasta || '', visitaId: p.visitaId || '', origenPresupuesto: p.origenPresupuesto || '', clienteId: p.clienteId, listaPrecioId: totalesPedido(p).lista, observacion: p.observacion || '', datosDel: datos ? datos.generado : '',
    lineas: p.lineas.map(l => { const a = artDe(l.productoId), lp = totalesPedido(p).lista; return { productoId: l.productoId, cantidad: Number(l.cantidad), precioUsd: a && a.precios && a.precios[lp] != null ? a.precios[lp] : null }; }) });
}
async function cifrarObjeto(obj) {
  const k = await crypto.subtle.importKey('raw', hexA(sec.k), 'AES-GCM', false, ['encrypt']), iv = crypto.getRandomValues(new Uint8Array(12));
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify(obj)))), tag = cifrado.slice(-16), cuerpo = cifrado.slice(0, -16);
  return enc.encode(JSON.stringify({ f: 1, n: cfg.n, iv: b64.a(iv), t: b64.a(tag), d: b64.a(cuerpo) }));
}
async function baseParaSubir(tk) {
  if (sec.raiz) return sec.raiz;
  for (const base of [cfg.d, '/' + cfg.s].filter(Boolean)) { const r = await fetch('https://api.dropboxapi.com/2/files/get_metadata', { method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: base }) }); if (r.ok) { sec.raiz = base; cfg.sec = await sellar(sec, pinKey); await kvSet('cfg', cfg); return base; } }
  try { await descargarDropbox(tk); } catch (e) { /* solo para descubrir la carpeta */ } if (sec.raiz) return sec.raiz;
  throw new Error('No encuentro tu carpeta en Dropbox: sincroniza primero o escribe la carpeta en Ajustes.');
}
async function subirPedido(p, tk) { return subirArchivo(p.id, await cifrarPedido(p), tk); }
async function subirArchivo(id, buf, tk) {
  const base = await baseParaSubir(tk);
  const r = await fetch('https://content.dropboxapi.com/2/files/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path: base.replace(/\/+$/, '') + '/entrada/' + id + '.json.enc', mode: 'add', autorename: false, mute: true }) }, body: buf });
  if (r.ok) return true; const t = await r.text();
  if (r.status === 409 && /conflict/.test(t) && !/no_write_permission|insufficient/.test(t)) return true; // ya estaba subido: no se duplica
  if (/missing_scope|files\.content\.write/.test(t)) throw new Error('Falta el permiso «files.content.write» de la app en Dropbox. Pídeselo a la oficina y luego usa Ajustes > Reconectar Dropbox.');
  if (/no_write_permission|insufficient_space|disallowed/.test(t)) throw new Error('No tienes permiso de escritura en tu carpeta de Dropbox: la oficina debe compartírtela con permiso de edición.');
  throw new Error('Dropbox: ' + r.status + ' ' + t.slice(0, 100));
}
let enviando = false;
async function enviarPendientes(manual) {
  const cola = pedidos.filter(p => p.estado === 'pendiente'), acs = msgs.acuses.filter(a => !a.enviado), vis = visitas.filter(v => v.estado === 'cerrada' && !v.enviado); if ((!cola.length && !acs.length && !vis.length) || enviando) return;
  if (!CFG.dropboxAppKey || !sec.refresh) { if (manual && cola.length) { aviso('Conecta primero con Dropbox en Ajustes para enviar pedidos', true); vista.pest = 'ajustes'; vista.ped = null; pantallaPrincipal(); } return; }
  if (!navigator.onLine) { if (manual && cola.length) aviso('Sin señal: el pedido queda guardado y se enviará solo cuando vuelva la conexión'); return; }
  enviando = true; let n = 0;
  try { const tk = await tokenDropbox(); for (const p of cola) { try { await subirPedido(p, tk); p.estado = 'enviado'; p.error = ''; p.enviadoEn = new Date().toISOString(); n++; } catch (e) { p.error = e.message; if (manual) aviso(e.message, true); break; } }
    for (const v of vis) { try { await subirArchivo(v.id, await cifrarObjeto({ formato: 1, tipo: 'visita', id: v.id, vm: cfg.s, clienteId: v.clienteId, fecha: v.fecha, inicio: v.inicio, fin: v.fin, motivos: v.motivos, observacion: v.observacion || '', resultado: v.resultado, detalle: v.detalle || '', pedidoIds: v.pedidoIds, automatica: !!v.automatica, sinCierre: !!v.sinCierre }), tk); v.enviado = true; } catch (e) { break; } }
    for (const a of acs) { try { await subirArchivo(a.id, await cifrarObjeto({ formato: 1, tipo: 'lectura', id: a.id, vm: cfg.s, mensajeId: a.mensajeId, leidoEn: a.leidoEn }), tk); a.enviado = true; } catch (e) { break; } } }
  catch (e) { if (manual) aviso(e.message, true); } finally { enviando = false; await guardarPedidos(); await guardarMsgs(); await guardarVisitas(); }
  if (n) aviso(n === 1 ? 'Pedido enviado a la oficina' : `${n} pedidos enviados`); if (cfg && pinKey) pantallaPrincipal();
}

/* ---------- Instalación como app ---------- */
let pedidoInstalar = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); pedidoInstalar = e; if (cfg && pinKey && vista.pest === 'ajustes') pantallaPrincipal(); });
window.addEventListener('appinstalled', () => { pedidoInstalar = null; aviso('App instalada'); });
const instalada = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
async function diagnosticoInstalacion() { // comprueba lo que Chrome exige para ofrecer «Instalar aplicación»
  const r = [];
  const ok = async (u) => { try { return (await fetch(u, { cache: 'no-store' })).ok; } catch (e) { return false; } };
  r.push(['Dirección segura (HTTPS)', window.isSecureContext]);
  r.push(['Archivo manifest.webmanifest', await ok('manifest.webmanifest')]); r.push(['Íconos (icons/icon-192.png y icon-512.png)', (await ok('icons/icon-192.png')) && (await ok('icons/icon-512.png'))]); r.push(['Archivo sw.js', await ok('sw.js')]);
  let sw = false; try { const g = await navigator.serviceWorker.getRegistration(); sw = !!(g && (g.active || g.waiting || g.installing)); } catch (e) { /* sin soporte */ }
  r.push(['Service worker registrado', sw]); return r;
}
function pintarInstalacion() {
  const el = $('#instalacion'); if (!el) return;
  if (instalada()) { el.innerHTML = '<p class="nota">Ya estás usando la app instalada.</p>'; return; }
  el.innerHTML = (pedidoInstalar ? '<button class="p" id="btnInstalar">Instalar como app</button>' : '<p class="nota">Si el menú ⋮ de Chrome no ofrece «Instalar aplicación», revisa el diagnóstico de abajo. Si antes creaste un acceso directo, bórralo primero.</p>') + '<button class="s" id="btnDiag">Diagnóstico de instalación</button><div id="diag"></div>';
  const bi = $('#btnInstalar'); if (bi) bi.onclick = async () => { pedidoInstalar.prompt(); await pedidoInstalar.userChoice; pedidoInstalar = null; pintarInstalacion(); };
  $('#btnDiag').onclick = async () => { $('#diag').innerHTML = '<p class="nota">Comprobando…</p>'; const r = await diagnosticoInstalacion(); $('#diag').innerHTML = '<table>' + r.map(([n, v]) => `<tr><td>${esc(n)}</td><td class="n" style="color:${v ? '#065f46' : '#be123c'}">${v ? 'Correcto' : 'FALLA'}</td></tr>`).join('') + '</table>' + (r.every(x => x[1]) ? '<p class="nota">Todo está en orden. En Chrome: menú ⋮ > Instalar aplicación. Si no aparece, cierra Chrome por completo y ábrelo de nuevo.</p>' : '<p class="nota">Lo que falla no está publicado en GitHub: súbelo de nuevo (Add file > Upload files), incluida la carpeta icons.</p>'); };
}

/* ---------- Arranque ---------- */
(async function iniciar() {
  try { cfg = (await kvGet('cfg')) || null; } catch (e) { cfg = null; }
  pintar();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* sin sw: funciona igual, pero no sin conexión */ });
  window.addEventListener('online', () => { if (pinKey && CFG.dropboxAppKey && sec && sec.refresh) { enviarPendientes(false); if (!datos || datosViejos()) sincronizar(); } });
})();
