/* =======================================================
   MI NEGOCIO FÁCIL - lógica de la aplicación
   Datos guardados en Firestore, uno por cuenta (un negocio por usuario).
   ======================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDlKr1zwsYbA4gH3tGLTE5eAU7pPK_0er0",
  authDomain: "mi-negocio-facil-53295.firebaseapp.com",
  projectId: "mi-negocio-facil-53295",
  storageBucket: "mi-negocio-facil-53295.firebasestorage.app",
  messagingSenderId: "332849354418",
  appId: "1:332849354418:web:3d5aee23f789484155dbab",
  measurementId: "G-ZDDQRWZ429"
};
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = initializeFirestore(firebaseApp, { localCache: persistentLocalCache() });

const STORAGE_KEY = 'mnf_data_v1'; // clave usada por versiones anteriores (localStorage), solo para migrar datos viejos

const CURRENCY_SYMBOLS = {
  COP: '$', USD: 'US$', MXN: 'MX$', PEN: 'S/', CLP: 'CLP$', ARS: 'AR$', EUR: '€'
};

let DB = null;
let currentUser = null;

/* ---------- Persistencia (Firestore, por usuario) ---------- */
function emptyDB(){
  return { negocio: null, productos: [], clientes: [], proveedores: [], ventas: [], compras: [], ajustesInventario: [], gastos: [], metas: [], cambios: [] };
}

async function loadUserDB(uidUsuario){
  const ref = doc(db, 'negocios', uidUsuario);
  const snap = await getDoc(ref);
  // Se combina con emptyDB() para que cuentas creadas antes de agregar un campo nuevo (ej. proveedores) no rompan la app.
  if(snap.exists()) return { ...emptyDB(), ...snap.data() };

  // Cuenta nueva: si este navegador tiene datos de una versión anterior (sin cuentas), los migramos.
  const raw = localStorage.getItem(STORAGE_KEY);
  if(raw){
    try{
      const datosViejos = JSON.parse(raw);
      if(datosViejos && datosViejos.negocio){
        const migrado = { ...emptyDB(), ...datosViejos };
        await setDoc(ref, migrado);
        localStorage.removeItem(STORAGE_KEY);
        return migrado;
      }
    }catch(e){ /* datos corruptos, se ignoran */ }
  }
  return emptyDB();
}

function saveDB(){
  if(!currentUser) return;
  setDoc(doc(db, 'negocios', currentUser.uid), DB).catch(()=>{
    toast('No se pudo sincronizar con la nube. Se reintentará al recuperar conexión ⚠️');
  });
}
function uid(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

/* ---------- Formato ---------- */
function money(n){
  n = Number(n) || 0;
  const sym = CURRENCY_SYMBOLS[DB.negocio?.moneda] || '$';
  return sym + Math.round(n).toLocaleString('es-CO');
}
function fmtDate(d){
  return new Date(d).toLocaleDateString('es-CO', {day:'2-digit', month:'short'});
}
function fmtDateTime(d){
  const fecha = new Date(d);
  const hora = fecha.toLocaleTimeString('es-CO', {hour:'2-digit', minute:'2-digit'});
  return `${fmtDate(fecha)}, ${hora}`;
}
function registrarCambio(modulo, accion, descripcion){
  DB.cambios = DB.cambios || [];
  DB.cambios.unshift({ id: uid(), fecha: new Date().toISOString(), modulo, accion, descripcion });
  if(DB.cambios.length > 300) DB.cambios.length = 300;
}

/* ---------- Fechas / periodos ---------- */
function startOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
function startOfWeek(d){
  const x = startOfDay(d);
  const day = (x.getDay()+6)%7; // lunes=0
  x.setDate(x.getDate()-day);
  return x;
}
function startOfMonth(d){ const x=new Date(d); x.setDate(1); x.setHours(0,0,0,0); return x; }

function inPeriod(dateStr, period){
  const d = new Date(dateStr);
  const now = new Date();
  if(period==='dia') return d >= startOfDay(now);
  if(period==='semana') return d >= startOfWeek(now);
  if(period==='mes') return d >= startOfMonth(now);
  return true;
}

/* ---------- Toast ---------- */
let toastTimer=null;
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ t.hidden = true; }, 2400);
}

/* ---------- Pantallas de nivel superior (cargando / login / onboarding / app) ---------- */
function showView(id){
  ['view-cargando','view-login','view-onboarding','app'].forEach(v=>{
    document.getElementById(v).hidden = (v !== id);
  });
}

/* ---------- Navegación ---------- */
let currentView = 'inicio';
let periods = { inicio:'dia', finanzas:'mes' };

function switchView(name){
  currentView = name;
  document.querySelectorAll('.view').forEach(v=>v.hidden = (v.id !== 'view-'+name));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===name));
  renderAll();
  document.getElementById('views').scrollTo(0,0);
  window.scrollTo(0,0);
}

document.querySelectorAll('.nav-btn').forEach(btn=>{
  btn.addEventListener('click', ()=> switchView(btn.dataset.view));
});

document.querySelectorAll('.period-tabs').forEach(group=>{
  group.querySelectorAll('.period-tab').forEach(tab=>{
    tab.addEventListener('click', ()=>{
      group.querySelectorAll('.period-tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      periods[group.dataset.target] = tab.dataset.period;
      renderAll();
    });
  });
});

function wireTabs(tabsId){
  const tabsEl = document.getElementById(tabsId);
  if(!tabsEl) return;
  const scope = tabsEl.closest('section') || document;
  tabsEl.querySelectorAll('.tab').forEach(tab=>{
    tab.addEventListener('click', ()=>{
      tabsEl.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      scope.querySelectorAll('.tab-panel').forEach(p=>p.hidden = (p.id !== 'tab-'+tab.dataset.tab));
    });
  });
}
wireTabs('negocio-tabs');
wireTabs('cuentas-tabs');

/* ---------- Modales ---------- */
const backdrop = document.getElementById('modal-backdrop');
function openModal(id){
  document.querySelectorAll('.modal').forEach(m=>m.hidden = (m.id !== 'modal-'+id));
  backdrop.hidden = false;
  if(id==='venta') prepararModalVenta();
  if(id==='meta') {} // nothing special
}
function closeModals(){
  backdrop.hidden = true;
  document.querySelectorAll('.modal').forEach(m=>m.hidden = true);
}
backdrop.addEventListener('click', (e)=>{ if(e.target===backdrop) closeModals(); });
document.querySelectorAll('.modal-close').forEach(b=>b.addEventListener('click', closeModals));

/* ---------- Vista maestro-detalle (lista + panel a la derecha en escritorio) ---------- */
function isDesktopLayout(){
  return window.matchMedia('(min-width:900px)').matches;
}
function mostrarDetalle(tituloTexto, htmlContenido, panelId){
  // el modal siempre queda sincronizado (aunque quede oculto en escritorio) para que
  // el botón "Imprimir" funcione igual desde el panel lateral o desde el modal en celular.
  document.getElementById('detalle-titulo').textContent = tituloTexto;
  document.getElementById('detalle-body').innerHTML = htmlContenido;
  const panel = document.getElementById(panelId);
  if(panel) panel.innerHTML = htmlContenido;
  if(!isDesktopLayout()){
    openModal('detalle');
  }
}
function marcarSeleccionLista(listaId, id){
  const cont = document.getElementById(listaId);
  if(!cont) return;
  cont.querySelectorAll('.list-item').forEach(el=>el.classList.remove('selected'));
  const btn = cont.querySelector(`[data-id="${id}"]`);
  btn?.closest('.list-item')?.classList.add('selected');
}

document.querySelectorAll('[data-open]').forEach(el=>{
  el.addEventListener('click', ()=>{
    const tipo = el.dataset.open;
    if(tipo==='cliente') return abrirModalCliente(null);
    if(tipo==='proveedor') return abrirModalProveedor(null);
    if(tipo==='producto') return abrirModalProducto();
    if(tipo==='compra') return abrirModalCompra();
    if(tipo==='gasto') return abrirModalGasto(null);
    if(tipo==='ajuste') return abrirModalAjuste();
    openModal(tipo);
  });
});
document.getElementById('btn-nueva-meta').addEventListener('click', ()=> openModal('meta'));

/* ================= ONBOARDING ================= */
document.getElementById('form-onboarding').addEventListener('submit', (e)=>{
  e.preventDefault();
  DB.negocio = {
    propietario: document.getElementById('ob-propietario').value.trim(),
    nombre: document.getElementById('ob-nombre').value.trim() || 'Mi negocio',
    tipo: document.getElementById('ob-tipo').value,
    ciudad: document.getElementById('ob-ciudad').value.trim(),
    moneda: document.getElementById('ob-moneda').value,
    creado: new Date().toISOString()
  };
  saveDB();
  showView('app');
  switchView(currentView);
});

/* ================= PRODUCTOS ================= */
function abrirModalProducto(producto){
  const selPr = document.getElementById('p-proveedor');
  selPr.innerHTML = '<option value="">— Sin proveedor —</option>' +
    DB.proveedores.map(p=>`<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join('');
  document.getElementById('p-id').value = producto?.id || '';
  document.getElementById('p-nombre').value = producto?.nombre || '';
  document.getElementById('p-sku').value = producto?.sku || '';
  document.getElementById('p-categoria').value = producto?.categoria || '';
  document.getElementById('p-unidad').value = producto?.unidadMedida || '';
  document.getElementById('p-cantidad').value = producto?.cantidad ?? 0;
  document.getElementById('p-compra').value = producto?.precioCompra ?? 0;
  document.getElementById('p-venta').value = producto?.precioVenta ?? '';
  document.getElementById('p-iva').value = producto?.ivaPct ?? 19;
  document.getElementById('p-minima').value = producto?.cantidadMinima ?? 2;
  selPr.value = producto?.proveedorId || '';
  document.getElementById('p-estado').value = producto?.estado || 'Activo';
  document.getElementById('producto-modal-titulo').textContent = producto ? '📦 Editar producto' : '📦 Registrar producto';
  document.getElementById('producto-submit-btn').textContent = producto ? 'Guardar cambios' : 'Guardar producto';
  openModal('producto');
}

document.getElementById('form-producto').addEventListener('submit', (e)=>{
  e.preventDefault();
  const id = document.getElementById('p-id').value;
  const datos = {
    nombre: document.getElementById('p-nombre').value.trim(),
    sku: document.getElementById('p-sku').value.trim(),
    categoria: document.getElementById('p-categoria').value.trim(),
    unidadMedida: document.getElementById('p-unidad').value.trim(),
    cantidad: Number(document.getElementById('p-cantidad').value)||0,
    precioCompra: Number(document.getElementById('p-compra').value)||0,
    precioVenta: Number(document.getElementById('p-venta').value)||0,
    ivaPct: Number(document.getElementById('p-iva').value)||0,
    cantidadMinima: Number(document.getElementById('p-minima').value)||0,
    proveedorId: document.getElementById('p-proveedor').value || null,
    estado: document.getElementById('p-estado').value
  };
  if(id){
    const producto = DB.productos.find(p=>p.id===id);
    if(producto) Object.assign(producto, datos);
    registrarCambio('Producto', 'Editar', `Editó el producto "${datos.nombre}"`);
  } else {
    DB.productos.push({ id: uid(), ...datos });
    registrarCambio('Producto', 'Crear', `Registró el producto "${datos.nombre}"`);
  }
  saveDB();
  e.target.reset();
  document.getElementById('p-iva').value = 19;
  document.getElementById('p-minima').value = 2;
  document.getElementById('p-estado').value = 'Activo';
  closeModals();
  toast(id ? 'Producto actualizado ✅' : 'Producto guardado ✅');
  renderAll();
});

function editarProducto(id){
  const producto = DB.productos.find(p=>p.id===id);
  if(producto) abrirModalProducto(producto);
}
function eliminarProducto(id){
  if(!confirm('¿Eliminar este producto?')) return;
  const producto = DB.productos.find(p=>p.id===id);
  DB.productos = DB.productos.filter(p=>p.id!==id);
  registrarCambio('Producto', 'Eliminar', `Eliminó el producto "${producto?.nombre||''}"`);
  saveDB(); renderAll();
}

document.getElementById('lista-productos').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-accion]');
  if(!btn) return;
  const id = btn.dataset.id;
  if(btn.dataset.accion==='editar-producto') editarProducto(id);
  if(btn.dataset.accion==='eliminar-producto') eliminarProducto(id);
});

document.getElementById('buscar-producto').addEventListener('input', renderProductos);

/* ================= CLIENTES ================= */
function actualizarLabelCliente(){
  const esJuridica = document.getElementById('c-tipo-persona').value === 'juridica';
  document.getElementById('c-nombre-label').textContent = esJuridica ? 'Razón social' : 'Nombres y apellidos';
  document.getElementById('c-contacto-wrap').hidden = !esJuridica;
}
document.getElementById('c-tipo-persona').addEventListener('change', actualizarLabelCliente);

function abrirModalCliente(cliente){
  document.getElementById('c-id').value = cliente?.id || '';
  document.getElementById('c-tipo-persona').value = cliente?.tipoPersona || 'natural';
  document.getElementById('c-nombres').value = cliente?.nombres || cliente?.nombre || '';
  document.getElementById('c-contacto').value = cliente?.contacto || '';
  document.getElementById('c-tipo-id').value = cliente?.tipoIdentificacion || 'CC';
  document.getElementById('c-numero-id').value = cliente?.numeroIdentificacion || '';
  document.getElementById('c-direccion').value = cliente?.direccion || '';
  document.getElementById('c-ciudad').value = cliente?.ciudad || '';
  document.getElementById('c-celular').value = cliente?.celular || cliente?.telefono || '';
  document.getElementById('c-correo').value = cliente?.correo || '';
  document.getElementById('c-estado').value = cliente?.estado || 'Activo';
  actualizarLabelCliente();
  document.getElementById('cliente-modal-titulo').textContent = cliente ? '👥 Editar cliente' : '👥 Registrar cliente';
  document.getElementById('cliente-submit-btn').textContent = cliente ? 'Guardar cambios' : 'Guardar cliente';
  openModal('cliente');
}
function editarCliente(id){
  const cliente = DB.clientes.find(c=>c.id===id);
  if(cliente) abrirModalCliente(cliente);
}
function eliminarCliente(id){
  if(!confirm('¿Eliminar este cliente?')) return;
  const cliente = DB.clientes.find(c=>c.id===id);
  DB.clientes = DB.clientes.filter(c=>c.id!==id);
  registrarCambio('Cliente', 'Eliminar', `Eliminó el cliente "${cliente?.nombres||cliente?.nombre||''}"`);
  saveDB(); renderAll();
}

document.getElementById('form-cliente').addEventListener('submit', (e)=>{
  e.preventDefault();
  const id = document.getElementById('c-id').value;
  const datos = {
    tipoPersona: document.getElementById('c-tipo-persona').value,
    nombres: document.getElementById('c-nombres').value.trim(),
    contacto: document.getElementById('c-contacto').value.trim(),
    tipoIdentificacion: document.getElementById('c-tipo-id').value,
    numeroIdentificacion: document.getElementById('c-numero-id').value.trim(),
    direccion: document.getElementById('c-direccion').value.trim(),
    ciudad: document.getElementById('c-ciudad').value.trim(),
    celular: document.getElementById('c-celular').value.trim(),
    correo: document.getElementById('c-correo').value.trim(),
    estado: document.getElementById('c-estado').value
  };
  if(id){
    const cliente = DB.clientes.find(c=>c.id===id);
    if(cliente) Object.assign(cliente, datos);
    registrarCambio('Cliente', 'Editar', `Editó el cliente "${datos.nombres}"`);
  } else {
    DB.clientes.push({ id: uid(), ...datos });
    registrarCambio('Cliente', 'Crear', `Registró el cliente "${datos.nombres}"`);
  }
  saveDB();
  e.target.reset();
  closeModals();
  toast(id ? 'Cliente actualizado ✅' : 'Cliente guardado ✅');
  renderAll();
});

document.getElementById('lista-clientes').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-accion]');
  if(!btn) return;
  const id = btn.dataset.id;
  if(btn.dataset.accion==='editar-cliente') editarCliente(id);
  if(btn.dataset.accion==='eliminar-cliente') eliminarCliente(id);
});

document.getElementById('buscar-cliente').addEventListener('input', renderClientes);

/* ================= PROVEEDORES ================= */
function actualizarLabelProveedor(){
  const esJuridica = document.getElementById('pr-tipo-persona').value === 'juridica';
  document.getElementById('pr-nombre-label').textContent = esJuridica ? 'Nombre de empresa' : 'Nombre y apellido';
  document.getElementById('pr-contacto-wrap').hidden = !esJuridica;
}
document.getElementById('pr-tipo-persona').addEventListener('change', actualizarLabelProveedor);

function abrirModalProveedor(proveedor){
  document.getElementById('pr-id').value = proveedor?.id || '';
  document.getElementById('pr-tipo-persona').value = proveedor?.tipoPersona || 'natural';
  document.getElementById('pr-nombre').value = proveedor?.nombre || '';
  document.getElementById('pr-contacto').value = proveedor?.contacto || '';
  document.getElementById('pr-tipo-id').value = proveedor?.tipoIdentificacion || 'NIT';
  document.getElementById('pr-numero-id').value = proveedor?.numeroIdentificacion || '';
  document.getElementById('pr-direccion').value = proveedor?.direccion || '';
  document.getElementById('pr-ciudad').value = proveedor?.ciudad || '';
  document.getElementById('pr-telefono').value = proveedor?.telefono || '';
  document.getElementById('pr-correo').value = proveedor?.correo || '';
  document.getElementById('pr-estado').value = proveedor?.estado || 'Activo';
  actualizarLabelProveedor();
  document.getElementById('proveedor-modal-titulo').textContent = proveedor ? '🚚 Editar proveedor' : '🚚 Registrar proveedor';
  document.getElementById('proveedor-submit-btn').textContent = proveedor ? 'Guardar cambios' : 'Guardar proveedor';
  openModal('proveedor');
}
function editarProveedor(id){
  const proveedor = DB.proveedores.find(p=>p.id===id);
  if(proveedor) abrirModalProveedor(proveedor);
}
function eliminarProveedor(id){
  if(!confirm('¿Eliminar este proveedor?')) return;
  const proveedor = DB.proveedores.find(p=>p.id===id);
  DB.proveedores = DB.proveedores.filter(p=>p.id!==id);
  registrarCambio('Proveedor', 'Eliminar', `Eliminó el proveedor "${proveedor?.nombre||''}"`);
  saveDB(); renderAll();
}

document.getElementById('form-proveedor').addEventListener('submit', (e)=>{
  e.preventDefault();
  const id = document.getElementById('pr-id').value;
  const datos = {
    tipoPersona: document.getElementById('pr-tipo-persona').value,
    nombre: document.getElementById('pr-nombre').value.trim(),
    contacto: document.getElementById('pr-contacto').value.trim(),
    tipoIdentificacion: document.getElementById('pr-tipo-id').value,
    numeroIdentificacion: document.getElementById('pr-numero-id').value.trim(),
    direccion: document.getElementById('pr-direccion').value.trim(),
    ciudad: document.getElementById('pr-ciudad').value.trim(),
    telefono: document.getElementById('pr-telefono').value.trim(),
    correo: document.getElementById('pr-correo').value.trim(),
    estado: document.getElementById('pr-estado').value
  };
  if(id){
    const proveedor = DB.proveedores.find(p=>p.id===id);
    if(proveedor) Object.assign(proveedor, datos);
    registrarCambio('Proveedor', 'Editar', `Editó el proveedor "${datos.nombre}"`);
  } else {
    DB.proveedores.push({ id: uid(), ...datos });
    registrarCambio('Proveedor', 'Crear', `Registró el proveedor "${datos.nombre}"`);
  }
  saveDB();
  e.target.reset();
  closeModals();
  toast(id ? 'Proveedor actualizado ✅' : 'Proveedor guardado ✅');
  renderAll();
});

document.getElementById('lista-proveedores').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-accion]');
  if(!btn) return;
  const id = btn.dataset.id;
  if(btn.dataset.accion==='editar-proveedor') editarProveedor(id);
  if(btn.dataset.accion==='eliminar-proveedor') eliminarProveedor(id);
});

document.getElementById('buscar-proveedor').addEventListener('input', renderProveedores);

/* ================= VENTAS (factura con carrito multi-producto) ================= */
let carritoVenta = [];

function prepararModalVenta(){
  carritoVenta = [];
  const selP = document.getElementById('v-producto');
  selP.innerHTML = '<option value="">— Sin producto (servicio libre) —</option>' +
    DB.productos.map(p=>`<option value="${p.id}">${escapeHtml(p.nombre)} (disp: ${p.cantidad})</option>`).join('');
  const selC = document.getElementById('v-cliente');
  selC.innerHTML = '<option value="">— Sin cliente —</option>' +
    DB.clientes.map(c=>`<option value="${c.id}">${escapeHtml(c.nombres||c.nombre||'')}</option>`).join('');
  document.getElementById('v-descripcion').value = '';
  document.getElementById('v-cantidad').value = 1;
  document.getElementById('v-precio').value = '';
  document.getElementById('v-item-iva').value = 0;
  document.getElementById('v-cliente').value = '';
  document.getElementById('v-tipo').value = 'contado';
  document.getElementById('v-plazo').value = 30;
  document.getElementById('v-descuento').value = 0;
  actualizarTipoVenta();
  renderCarritoVenta();
}
function actualizarTipoVenta(){
  const esCredito = document.getElementById('v-tipo').value === 'credito';
  document.getElementById('v-pago-label').hidden = esCredito;
  document.getElementById('v-credito-aviso').hidden = !esCredito;
  document.getElementById('v-plazo-label').hidden = !esCredito;
}
document.getElementById('v-tipo').addEventListener('change', actualizarTipoVenta);
document.getElementById('v-producto').addEventListener('change', (e)=>{
  const prod = DB.productos.find(p=>p.id===e.target.value);
  if(prod){
    document.getElementById('v-precio').value = prod.precioVenta;
    document.getElementById('v-descripcion').value = prod.nombre;
    document.getElementById('v-item-iva').value = prod.ivaPct ?? 0;
  }
});

function totalesCarritoVenta(){
  const subtotal = carritoVenta.reduce((a,it)=>a+it.subtotal,0);
  const ivaTotal = carritoVenta.reduce((a,it)=>a+it.ivaValor,0);
  const descPct = Number(document.getElementById('v-descuento').value)||0;
  const descuentoTotal = subtotal * descPct/100;
  const total = subtotal - descuentoTotal + ivaTotal;
  return { subtotal, descPct, descuentoTotal, ivaTotal, total };
}

function renderCarritoVenta(){
  const cont = document.getElementById('v-carrito-lista');
  document.getElementById('v-carrito-columnas').hidden = carritoVenta.length===0;
  cont.innerHTML = carritoVenta.length===0
    ? '<div class="empty-state">Aún no has agregado productos a la factura</div>'
    : carritoVenta.map((it,idx)=>`
      <div class="list-item carrito-item">
        <span class="li-title">${escapeHtml(it.descripcion)}</span>
        <span class="carrito-cant">${it.cantidad}</span>
        <span class="carrito-precio">${money(it.precioUnitario)}</span>
        <span class="li-value">${money(it.total)}</span>
        <button type="button" class="li-quitar" data-idx="${idx}">✕</button>
      </div>`).join('');
  const t = totalesCarritoVenta();
  document.getElementById('v-subtotal').textContent = money(t.subtotal);
  document.getElementById('v-desc-total').textContent = money(t.descuentoTotal);
  document.getElementById('v-iva-total').textContent = money(t.ivaTotal);
  document.getElementById('v-total').textContent = money(t.total);
}
document.getElementById('v-carrito-lista').addEventListener('click', (e)=>{
  const btn = e.target.closest('.li-quitar');
  if(!btn) return;
  carritoVenta.splice(Number(btn.dataset.idx),1);
  renderCarritoVenta();
});
document.getElementById('v-descuento').addEventListener('input', renderCarritoVenta);

document.getElementById('v-agregar-item').addEventListener('click', ()=>{
  const productoId = document.getElementById('v-producto').value;
  const producto = DB.productos.find(p=>p.id===productoId);
  const cantidad = Number(document.getElementById('v-cantidad').value)||0;
  const precio = Number(document.getElementById('v-precio').value)||0;
  const ivaPct = Number(document.getElementById('v-item-iva').value)||0;
  const descripcion = document.getElementById('v-descripcion').value.trim() || (producto?producto.nombre:'');
  if(!descripcion){ toast('Elige un producto o escribe una descripción ⚠️'); return; }
  if(cantidad<=0){ toast('La cantidad debe ser mayor a 0 ⚠️'); return; }
  const subtotal = cantidad*precio;
  const ivaValor = subtotal*ivaPct/100;
  carritoVenta.push({
    productoId: productoId || null,
    codigo: producto?.sku || '',
    descripcion,
    cantidad,
    precioUnitario: precio,
    ivaPct,
    subtotal,
    ivaValor,
    total: subtotal + ivaValor
  });
  document.getElementById('v-producto').value = '';
  document.getElementById('v-descripcion').value = '';
  document.getElementById('v-cantidad').value = 1;
  document.getElementById('v-precio').value = '';
  document.getElementById('v-item-iva').value = 0;
  renderCarritoVenta();
});

document.getElementById('form-venta').addEventListener('submit', (e)=>{
  e.preventDefault();
  if(carritoVenta.length===0){ toast('Agrega al menos un producto a la factura ⚠️'); return; }
  const tipoVenta = document.getElementById('v-tipo').value;
  const clienteId = document.getElementById('v-cliente').value || null;

  if(tipoVenta==='credito' && !clienteId){
    toast('Selecciona un cliente para registrar una venta a crédito ⚠️');
    return;
  }

  for(const it of carritoVenta){
    if(!it.productoId) continue;
    const producto = DB.productos.find(p=>p.id===it.productoId);
    if(producto && producto.cantidad < it.cantidad){
      if(!confirm(`Solo tienes ${producto.cantidad} de "${producto.nombre}" en inventario. ¿Registrar la venta de todos modos?`)) return;
    }
  }
  carritoVenta.forEach(it=>{
    if(!it.productoId) return;
    const producto = DB.productos.find(p=>p.id===it.productoId);
    if(producto) producto.cantidad = Math.max(0, producto.cantidad - it.cantidad);
  });

  const t = totalesCarritoVenta();
  DB.negocio.consecutivoFactura = (DB.negocio.consecutivoFactura||0) + 1;
  let fechaVencimiento = null;
  if(tipoVenta==='credito'){
    const plazoDias = Number(document.getElementById('v-plazo').value)||30;
    const vto = new Date(); vto.setDate(vto.getDate()+plazoDias);
    fechaVencimiento = vto.toISOString();
  }
  const venta = {
    id: uid(),
    numeroFactura: DB.negocio.consecutivoFactura,
    fecha: new Date().toISOString(),
    clienteId,
    tipoVenta,
    metodoPago: tipoVenta==='contado' ? document.getElementById('v-pago').value : null,
    pagada: tipoVenta==='contado',
    fechaVencimiento,
    items: carritoVenta.slice(),
    descuentoPct: t.descPct,
    subtotal: t.subtotal,
    descuentoTotal: t.descuentoTotal,
    ivaTotal: t.ivaTotal,
    total: t.total
  };
  DB.ventas.push(venta);
  registrarCambio('Venta', 'Crear', `Registró la factura de venta No. ${venta.numeroFactura} por ${money(venta.total)}`);
  saveDB();
  closeModals();
  toast('Factura registrada 💰');
  renderAll();
  mostrarFactura(venta.id);
});

/* ================= COMPRAS (entradas de inventario) ================= */
let carritoCompra = [];

function abrirModalCompra(compra){
  carritoCompra = compra ? compra.items.map(it=>({...it})) : [];
  const selP = document.getElementById('co-producto');
  selP.innerHTML = '<option value="">— Elige un producto —</option>' +
    DB.productos.map(p=>`<option value="${p.id}">${escapeHtml(p.nombre)} (disp: ${p.cantidad})</option>`).join('');
  const selPr = document.getElementById('co-proveedor');
  selPr.innerHTML = '<option value="">— Elige un proveedor —</option>' +
    DB.proveedores.map(pr=>`<option value="${pr.id}">${escapeHtml(pr.nombre)}</option>`).join('');
  document.getElementById('co-id').value = compra?.id || '';
  document.getElementById('co-cantidad').value = 1;
  document.getElementById('co-costo').value = '';
  document.getElementById('co-item-iva').value = 0;
  document.getElementById('co-proveedor').value = compra?.proveedorId || '';
  document.getElementById('co-numero-factura').value = compra?.numeroFacturaProveedor || '';
  document.getElementById('co-tipo').value = compra?.tipoCompra || 'contado';
  document.getElementById('co-vencimiento').value = compra?.fechaVencimiento ? compra.fechaVencimiento.slice(0,10) : '';
  actualizarTipoCompra();
  document.getElementById('compra-modal-titulo').textContent = compra ? '🧾 Editar compra' : '🧾 Registrar compra';
  document.getElementById('compra-submit-btn').textContent = compra ? 'Guardar cambios' : 'Guardar compra';
  renderCarritoCompra();
  openModal('compra');
}
function actualizarTipoCompra(){
  const esCredito = document.getElementById('co-tipo').value === 'credito';
  document.getElementById('co-credito-aviso').hidden = !esCredito;
  document.getElementById('co-vencimiento-label').hidden = !esCredito;
}
document.getElementById('co-tipo').addEventListener('change', actualizarTipoCompra);

function renderCarritoCompra(){
  const cont = document.getElementById('co-carrito-lista');
  document.getElementById('co-carrito-columnas').hidden = carritoCompra.length===0;
  cont.innerHTML = carritoCompra.length===0
    ? '<div class="empty-state">Aún no has agregado productos a la compra</div>'
    : carritoCompra.map((it,idx)=>`
      <div class="list-item carrito-item">
        <span class="li-title">${escapeHtml(it.descripcion)}</span>
        <span class="carrito-cant">${it.cantidad}</span>
        <span class="carrito-precio">${money(it.costoUnitario)}</span>
        <span class="li-value">${money(it.total)}</span>
        <button type="button" class="li-quitar" data-idx="${idx}">✕</button>
      </div>`).join('');
  const subtotal = carritoCompra.reduce((a,it)=>a+(it.subtotal ?? it.total),0);
  const ivaTotal = carritoCompra.reduce((a,it)=>a+(it.ivaValor||0),0);
  document.getElementById('co-subtotal').textContent = money(subtotal);
  document.getElementById('co-iva-total').textContent = money(ivaTotal);
  document.getElementById('co-total').textContent = money(subtotal + ivaTotal);
}
document.getElementById('co-carrito-lista').addEventListener('click', (e)=>{
  const btn = e.target.closest('.li-quitar');
  if(!btn) return;
  carritoCompra.splice(Number(btn.dataset.idx),1);
  renderCarritoCompra();
});

document.getElementById('co-producto').addEventListener('change', (e)=>{
  const prod = DB.productos.find(p=>p.id===e.target.value);
  document.getElementById('co-item-iva').value = prod ? (prod.ivaPct ?? 0) : 0;
});

document.getElementById('co-agregar-item').addEventListener('click', ()=>{
  const productoId = document.getElementById('co-producto').value;
  const producto = DB.productos.find(p=>p.id===productoId);
  const cantidad = Number(document.getElementById('co-cantidad').value)||0;
  const costo = Number(document.getElementById('co-costo').value)||0;
  const ivaPct = Number(document.getElementById('co-item-iva').value)||0;
  if(!producto){ toast('Elige un producto ⚠️'); return; }
  if(cantidad<=0){ toast('La cantidad debe ser mayor a 0 ⚠️'); return; }
  const subtotal = cantidad*costo;
  const ivaValor = subtotal*ivaPct/100;
  carritoCompra.push({
    productoId,
    descripcion: producto.nombre,
    cantidad,
    costoUnitario: costo,
    ivaPct,
    subtotal,
    ivaValor,
    total: subtotal + ivaValor
  });
  document.getElementById('co-producto').value = '';
  document.getElementById('co-cantidad').value = 1;
  document.getElementById('co-costo').value = '';
  document.getElementById('co-item-iva').value = 0;
  renderCarritoCompra();
});

document.getElementById('form-compra').addEventListener('submit', (e)=>{
  e.preventDefault();
  if(carritoCompra.length===0){ toast('Agrega al menos un producto a la compra ⚠️'); return; }
  const proveedorId = document.getElementById('co-proveedor').value;
  if(!proveedorId){ toast('Elige un proveedor ⚠️'); return; }

  const id = document.getElementById('co-id').value;
  const tipoCompraForm = document.getElementById('co-tipo').value;
  const vencimientoInput = document.getElementById('co-vencimiento').value;
  const fechaVencimiento = (tipoCompraForm==='credito' && vencimientoInput) ? new Date(vencimientoInput+'T00:00:00').toISOString() : null;
  if(id){
    const compra = DB.compras.find(c=>c.id===id);
    if(!compra) return;
    // revertir el stock que había sumado la versión anterior de esta compra
    compra.items.forEach(it=>{
      const producto = DB.productos.find(p=>p.id===it.productoId);
      if(producto) producto.cantidad = Math.max(0, producto.cantidad - it.cantidad);
    });
    // aplicar el stock de la versión editada
    carritoCompra.forEach(it=>{
      const producto = DB.productos.find(p=>p.id===it.productoId);
      if(producto) producto.cantidad = producto.cantidad + it.cantidad;
    });
    compra.proveedorId = proveedorId;
    compra.numeroFacturaProveedor = document.getElementById('co-numero-factura').value.trim();
    compra.tipoCompra = tipoCompraForm;
    if(compra.tipoCompra==='contado') compra.pagada = true;
    compra.fechaVencimiento = fechaVencimiento;
    compra.items = carritoCompra.slice();
    compra.subtotal = carritoCompra.reduce((a,it)=>a+(it.subtotal ?? it.total),0);
    compra.ivaTotal = carritoCompra.reduce((a,it)=>a+(it.ivaValor||0),0);
    compra.total = compra.subtotal + compra.ivaTotal;
    registrarCambio('Compra', 'Editar', `Editó la compra a "${DB.proveedores.find(p=>p.id===proveedorId)?.nombre||''}" por ${money(compra.total)}`);
  } else {
    carritoCompra.forEach(it=>{
      const producto = DB.productos.find(p=>p.id===it.productoId);
      if(producto) producto.cantidad = producto.cantidad + it.cantidad;
    });
    const subtotal = carritoCompra.reduce((a,it)=>a+(it.subtotal ?? it.total),0);
    const ivaTotal = carritoCompra.reduce((a,it)=>a+(it.ivaValor||0),0);
    const compra = {
      id: uid(),
      fecha: new Date().toISOString(),
      proveedorId,
      numeroFacturaProveedor: document.getElementById('co-numero-factura').value.trim(),
      tipoCompra: tipoCompraForm,
      pagada: tipoCompraForm==='contado',
      fechaVencimiento,
      items: carritoCompra.slice(),
      subtotal,
      ivaTotal,
      total: subtotal + ivaTotal
    };
    DB.compras.push(compra);
    registrarCambio('Compra', 'Crear', `Registró una compra a "${DB.proveedores.find(p=>p.id===proveedorId)?.nombre||''}" por ${money(compra.total)}`);
  }
  saveDB();
  closeModals();
  toast(id ? 'Compra actualizada ✅' : 'Compra registrada 🧾');
  renderAll();
});

function editarCompra(id){
  const compra = DB.compras.find(c=>c.id===id);
  if(compra) abrirModalCompra(compra);
}
function eliminarCompra(id){
  if(!confirm('¿Eliminar esta compra? Se descontará del inventario lo que había sumado.')) return;
  const compra = DB.compras.find(c=>c.id===id);
  if(!compra) return;
  compra.items.forEach(it=>{
    const producto = DB.productos.find(p=>p.id===it.productoId);
    if(producto) producto.cantidad = Math.max(0, producto.cantidad - it.cantidad);
  });
  DB.compras = DB.compras.filter(c=>c.id!==id);
  const proveedor = DB.proveedores.find(p=>p.id===compra.proveedorId);
  registrarCambio('Compra', 'Eliminar', `Eliminó la compra a "${proveedor?.nombre||''}" por ${money(compra.total)}`);
  saveDB(); renderAll();
}

function mostrarCompra(id){
  const compra = DB.compras.find(c=>c.id===id);
  if(!compra) return;
  const proveedor = DB.proveedores.find(p=>p.id===compra.proveedorId);
  const filas = (compra.items||[]).map(it=>`
    <tr>
      <td>${escapeHtml(it.descripcion)}</td>
      <td>${it.cantidad}</td>
      <td>${money(it.costoUnitario)}</td>
      <td>${it.ivaPct||0}%</td>
      <td>${money(it.total)}</td>
    </tr>`).join('');
  const subtotal = compra.subtotal ?? (compra.items||[]).reduce((a,it)=>a+(it.subtotal ?? it.total),0);
  const ivaTotal = compra.ivaTotal ?? (compra.items||[]).reduce((a,it)=>a+(it.ivaValor||0),0);
  const html = `
    <div class="factura-doc">
      <div style="font-size:13px;margin-bottom:10px;">
        <strong>Proveedor:</strong> ${proveedor ? escapeHtml(proveedor.nombre) : 'Proveedor eliminado'}<br>
        ${compra.numeroFacturaProveedor ? `<strong>N.° de factura:</strong> ${escapeHtml(compra.numeroFacturaProveedor)}<br>` : ''}
        <strong>Fecha:</strong> ${fmtDateTime(compra.fecha)}<br>
        <strong>Tipo:</strong> ${compra.tipoCompra==='credito' ? 'Crédito' : 'Contado'}
        ${compra.tipoCompra==='credito' ? ` — ${compra.pagada ? 'Pagada' : 'Pendiente de pago'}` : ''}
        ${compra.fechaVencimiento ? `<br><strong>Vence:</strong> ${fmtDate(compra.fechaVencimiento)}` : ''}
      </div>
      <table>
        <thead><tr><th>Producto</th><th>Cant.</th><th>Vr. unitario</th><th>IVA %</th><th>Vr. total</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>
      <div class="cierre-line" style="margin-top:10px;"><span>Subtotal</span><span>${money(subtotal)}</span></div>
      <div class="cierre-line"><span>IVA</span><span>${money(ivaTotal)}</span></div>
      <div class="modal-total"><span>Total: </span><strong>${money(compra.total)}</strong></div>
    </div>
  `;
  mostrarDetalle('Detalle de compra', html, 'compra-detalle-panel');
  marcarSeleccionLista('lista-compras', id);
}

function renderCompras(){
  const cont = document.getElementById('lista-compras');
  const comprasOrdenadas = DB.compras.slice().sort((a,b)=> new Date(b.fecha) - new Date(a.fecha)).slice(0,20);
  if(comprasOrdenadas.length===0){
    cont.innerHTML = '<div class="empty-state">Aún no has registrado compras</div>';
    return;
  }
  cont.innerHTML = comprasOrdenadas.map(c=>{
    const proveedor = DB.proveedores.find(pr=>pr.id===c.proveedorId);
    const esCreditoPendiente = c.tipoCompra==='credito' && !c.pagada;
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${proveedor ? escapeHtml(proveedor.nombre) : 'Proveedor eliminado'}${c.numeroFacturaProveedor ? ` <span class="li-sub">(${escapeHtml(c.numeroFacturaProveedor)})</span>` : ''}${esCreditoPendiente ? '<span class="badge-estado">Por pagar</span>' : ''}</span>
        <span class="li-sub">${fmtDateTime(c.fecha)} · ${(c.items||[]).length} producto(s)</span>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        <span class="li-value">${money(c.total)}</span>
        <div style="display:flex;gap:6px;">
          <button data-accion="ver-compra" data-id="${c.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Ver</button>
          <button data-accion="editar-compra" data-id="${c.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Editar</button>
          <button data-accion="eliminar-compra" data-id="${c.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Eliminar</button>
        </div>
      </div>
    </div>`;
  }).join('');
}
document.getElementById('lista-compras').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-accion]');
  if(!btn) return;
  const id = btn.dataset.id;
  if(btn.dataset.accion==='ver-compra') mostrarCompra(id);
  if(btn.dataset.accion==='editar-compra') editarCompra(id);
  if(btn.dataset.accion==='eliminar-compra') eliminarCompra(id);
});

/* ================= CUENTAS POR PAGAR ================= */
function marcarCompraPagada(id){
  const compra = DB.compras.find(c=>c.id===id);
  if(!compra) return;
  compra.pagada = true;
  compra.fechaPago = new Date().toISOString();
  const proveedor = DB.proveedores.find(p=>p.id===compra.proveedorId);
  registrarCambio('Compra', 'Pago', `Marcó como pagada la compra a "${proveedor?.nombre||''}" por ${money(compra.total)}`);
  saveDB();
  renderAll();
  toast('Cuenta marcada como pagada ✅');
}

function renderPorPagar(){
  const cont = document.getElementById('lista-por-pagar');
  const pendientes = DB.compras
    .filter(c=>c.tipoCompra==='credito' && !c.pagada)
    .sort((a,b)=> new Date(a.fecha) - new Date(b.fecha));
  if(pendientes.length===0){
    cont.innerHTML = '<div class="empty-state">No tienes cuentas por pagar pendientes 🎉</div>';
    return;
  }
  cont.innerHTML = pendientes.map(c=>{
    const proveedor = DB.proveedores.find(pr=>pr.id===c.proveedorId);
    const vencida = c.fechaVencimiento && new Date(c.fechaVencimiento) < new Date();
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${proveedor ? escapeHtml(proveedor.nombre) : 'Proveedor eliminado'}</span>
        <span class="li-sub">${fmtDate(c.fecha)}${c.numeroFacturaProveedor ? ` · ${escapeHtml(c.numeroFacturaProveedor)}` : ''}${c.fechaVencimiento ? ` · Vence: ${fmtDate(c.fechaVencimiento)}` : ''}${vencida ? ' ⚠️ Vencida' : ''}</span>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        <span class="li-value neg">${money(c.total)}</span>
        <button data-accion="marcar-compra-pagada" data-id="${c.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Marcar pagada</button>
      </div>
    </div>`;
  }).join('');
}
document.getElementById('lista-por-pagar').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-accion="marcar-compra-pagada"]');
  if(btn) marcarCompraPagada(btn.dataset.id);
});

function renderPagosRealizados(){
  const cont = document.getElementById('lista-pagos-realizados');
  const pagadas = DB.compras
    .filter(c=>c.tipoCompra==='credito' && c.pagada)
    .sort((a,b)=> new Date(b.fechaPago||b.fecha) - new Date(a.fechaPago||a.fecha))
    .slice(0,20);
  if(pagadas.length===0){
    cont.innerHTML = '<div class="empty-state">Todavía no has pagado ninguna cuenta a crédito</div>';
    return;
  }
  cont.innerHTML = pagadas.map(c=>{
    const proveedor = DB.proveedores.find(pr=>pr.id===c.proveedorId);
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${proveedor ? escapeHtml(proveedor.nombre) : 'Proveedor eliminado'}</span>
        <span class="li-sub">${c.fechaPago ? `Pagada el ${fmtDateTime(c.fechaPago)}` : `Comprada el ${fmtDate(c.fecha)}`}</span>
      </div>
      <span class="li-value">${money(c.total)}</span>
    </div>`;
  }).join('');
}

/* ================= CARTERA ================= */
function renderCartera(){
  const hoy = new Date();
  let vigente = 0, vencida = 0;
  const vencidasPorCliente = {};
  DB.ventas.filter(v=>v.tipoVenta==='credito' && !v.pagada && !v.anulada).forEach(v=>{
    const estaVencida = v.fechaVencimiento && new Date(v.fechaVencimiento) < hoy;
    if(estaVencida){
      vencida += v.total;
      vencidasPorCliente[v.clienteId] = (vencidasPorCliente[v.clienteId]||0) + v.total;
    } else {
      vigente += v.total;
    }
  });
  document.getElementById('cartera-vigente').textContent = money(vigente);
  document.getElementById('cartera-vencida').textContent = money(vencida);
  document.getElementById('cartera-total').textContent = money(vigente+vencida);

  const cont = document.getElementById('lista-cartera-vencida');
  const filas = Object.entries(vencidasPorCliente);
  if(filas.length===0){
    cont.innerHTML = '<div class="empty-state">No tienes cartera vencida 🎉</div>';
    return;
  }
  cont.innerHTML = filas.map(([clienteId,saldo])=>{
    const cliente = DB.clientes.find(c=>c.id===clienteId);
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${escapeHtml(cliente?.nombres || cliente?.nombre || '(sin nombre)')}</span>
      </div>
      <span class="li-value neg">${money(saldo)}</span>
    </div>`;
  }).join('');
}

function renderCuentas(){
  renderDeudores();
  renderCobrosPagados();
  renderPorPagar();
  renderPagosRealizados();
  renderCartera();
}

/* ================= AJUSTES DE INVENTARIO ================= */
function abrirModalAjuste(){
  const sel = document.getElementById('aj-producto');
  sel.innerHTML = '<option value="">— Elige un producto —</option>' +
    DB.productos.map(p=>`<option value="${p.id}">${escapeHtml(p.nombre)} (disp: ${p.cantidad})</option>`).join('');
  document.getElementById('aj-tipo').value = 'entrada';
  document.getElementById('aj-cantidad').value = 1;
  document.getElementById('aj-motivo').value = '';
  openModal('ajuste');
}

document.getElementById('form-ajuste').addEventListener('submit', (e)=>{
  e.preventDefault();
  const productoId = document.getElementById('aj-producto').value;
  const producto = DB.productos.find(p=>p.id===productoId);
  if(!producto){ toast('Elige un producto ⚠️'); return; }
  const tipo = document.getElementById('aj-tipo').value;
  const cantidad = Number(document.getElementById('aj-cantidad').value)||0;
  const motivo = document.getElementById('aj-motivo').value.trim();
  if(cantidad<=0){ toast('La cantidad debe ser mayor a 0 ⚠️'); return; }

  producto.cantidad = tipo==='entrada' ? producto.cantidad + cantidad : Math.max(0, producto.cantidad - cantidad);
  DB.ajustesInventario.push({
    id: uid(),
    productoId,
    tipo,
    cantidad,
    motivo,
    fecha: new Date().toISOString()
  });
  registrarCambio('Inventario', 'Ajuste', `Registró un ajuste de ${tipo} de ${cantidad} unidad(es) de "${producto.nombre}" (${motivo})`);
  saveDB();
  closeModals();
  toast('Ajuste registrado ⚖️');
  renderAll();
});

/* ================= GASTOS ================= */
function abrirModalGasto(gasto){
  document.getElementById('g-id').value = gasto?.id || '';
  document.getElementById('g-nombre').value = gasto?.nombre || '';
  document.getElementById('g-categoria').value = gasto?.categoria || 'Mercancía';
  document.getElementById('g-valor').value = gasto?.valor ?? '';
  document.getElementById('g-descripcion').value = gasto?.descripcion || '';
  document.getElementById('gasto-modal-titulo').textContent = gasto ? '🧾 Editar gasto' : '🧾 Registrar gasto';
  document.getElementById('gasto-submit-btn').textContent = gasto ? 'Guardar cambios' : 'Guardar gasto';
  openModal('gasto');
}

document.getElementById('form-gasto').addEventListener('submit', (e)=>{
  e.preventDefault();
  const id = document.getElementById('g-id').value;
  const datos = {
    nombre: document.getElementById('g-nombre').value.trim(),
    categoria: document.getElementById('g-categoria').value,
    valor: Number(document.getElementById('g-valor').value)||0,
    descripcion: document.getElementById('g-descripcion').value.trim()
  };
  if(id){
    const gasto = DB.gastos.find(g=>g.id===id);
    if(gasto) Object.assign(gasto, datos);
    registrarCambio('Gasto', 'Editar', `Editó el gasto "${datos.nombre}" por ${money(datos.valor)}`);
  } else {
    DB.gastos.push({ id: uid(), fecha: new Date().toISOString(), ...datos });
    registrarCambio('Gasto', 'Crear', `Registró el gasto "${datos.nombre}" por ${money(datos.valor)}`);
  }
  saveDB();
  e.target.reset();
  closeModals();
  toast(id ? 'Gasto actualizado ✅' : 'Gasto registrado 🧾');
  renderAll();
});

function editarGasto(id){
  const gasto = DB.gastos.find(g=>g.id===id);
  if(gasto) abrirModalGasto(gasto);
}
function eliminarGasto(id){
  if(!confirm('¿Eliminar este gasto?')) return;
  const gasto = DB.gastos.find(g=>g.id===id);
  DB.gastos = DB.gastos.filter(g=>g.id!==id);
  registrarCambio('Gasto', 'Eliminar', `Eliminó el gasto "${gasto?.nombre||''}"`);
  saveDB(); renderAll();
}

function renderGastos(){
  const cont = document.getElementById('lista-gastos');
  const gastosOrdenados = DB.gastos.slice().sort((a,b)=> new Date(b.fecha) - new Date(a.fecha)).slice(0,20);
  if(gastosOrdenados.length===0){
    cont.innerHTML = '<div class="empty-state">Aún no has registrado gastos</div>';
    return;
  }
  cont.innerHTML = gastosOrdenados.map(g=>`<div class="list-item">
      <div class="li-main">
        <span class="li-title">${escapeHtml(g.nombre)}</span>
        <span class="li-sub">${fmtDateTime(g.fecha)} · ${escapeHtml(g.categoria||'')}</span>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        <span class="li-value neg">${money(g.valor)}</span>
        <div style="display:flex;gap:6px;">
          <button data-accion="editar-gasto" data-id="${g.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Editar</button>
          <button data-accion="eliminar-gasto" data-id="${g.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Eliminar</button>
        </div>
      </div>
    </div>`).join('');
}
document.getElementById('lista-gastos').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-accion]');
  if(!btn) return;
  const id = btn.dataset.id;
  if(btn.dataset.accion==='editar-gasto') editarGasto(id);
  if(btn.dataset.accion==='eliminar-gasto') eliminarGasto(id);
});

/* ================= METAS ================= */
document.getElementById('form-meta').addEventListener('submit', (e)=>{
  e.preventDefault();
  DB.metas.push({
    id: uid(),
    tipo: document.getElementById('m-tipo').value,
    periodo: document.getElementById('m-periodo').value,
    valor: Number(document.getElementById('m-valor').value)||0,
    creado: new Date().toISOString()
  });
  saveDB();
  e.target.reset();
  closeModals();
  toast('Meta guardada 🎯');
  renderAll();
});
function eliminarMeta(id){
  DB.metas = DB.metas.filter(m=>m.id!==id);
  saveDB(); renderAll();
}

document.getElementById('lista-metas').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-accion]');
  if(!btn) return;
  if(btn.dataset.accion==='eliminar-meta') eliminarMeta(btn.dataset.id);
});

/* ================= PERFIL ================= */
document.getElementById('btn-guardar-perfil').addEventListener('click', ()=>{
  DB.negocio.propietario = document.getElementById('pf-propietario').value.trim();
  DB.negocio.nombre = document.getElementById('pf-nombre').value.trim() || DB.negocio.nombre;
  DB.negocio.tipo = document.getElementById('pf-tipo').value;
  DB.negocio.ciudad = document.getElementById('pf-ciudad').value.trim();
  DB.negocio.moneda = document.getElementById('pf-moneda').value;
  saveDB();
  toast('Datos del negocio actualizados ✅');
  renderAll();
});

document.getElementById('btn-guardar-facturacion').addEventListener('click', ()=>{
  DB.negocio.nit = document.getElementById('pf-nit').value.trim();
  DB.negocio.direccionNegocio = document.getElementById('pf-direccion-negocio').value.trim();
  DB.negocio.telefonoNegocio = document.getElementById('pf-telefono-negocio').value.trim();
  DB.negocio.resolucionDian = document.getElementById('pf-resolucion-dian').value.trim();
  DB.negocio.rangoDesde = document.getElementById('pf-rango-desde').value.trim();
  DB.negocio.rangoHasta = document.getElementById('pf-rango-hasta').value.trim();
  DB.negocio.ciiu = document.getElementById('pf-ciiu').value.trim();
  DB.negocio.agenteIva = document.getElementById('pf-agente-iva').value;
  saveDB();
  toast('Datos de facturación actualizados ✅');
  renderAll();
});

document.getElementById('btn-exportar').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(DB, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fecha = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `respaldo-mi-negocio-facil-${fecha}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Respaldo descargado ⬇️');
});

document.getElementById('input-importar').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const data = JSON.parse(reader.result);
      if(!data.negocio){ toast('El archivo no parece un respaldo válido ❌'); return; }
      if(confirm('Esto reemplazará la información actual con la del respaldo. ¿Continuar?')){
        DB = { ...emptyDB(), ...data };
        saveDB();
        showView('app');
        switchView(currentView);
        toast('Respaldo restaurado ✅');
      }
    }catch(err){
      toast('No se pudo leer el archivo ❌');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

/* ================= CUENTA (login / registro / cerrar sesión) ================= */
document.querySelectorAll('#login-tabs .tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    document.querySelectorAll('#login-tabs .tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('form-signin').hidden = tab.dataset.logintab !== 'signin';
    document.getElementById('form-signup').hidden = tab.dataset.logintab !== 'signup';
    document.getElementById('olvide-mensaje').hidden = true;
  });
});

/* Firebase Auth no tiene un proveedor nativo de "teléfono + contraseña", así que
   simulamos uno: el teléfono se convierte en un correo sintético interno y se
   usa el proveedor de correo/contraseña por debajo. El usuario nunca ve esto. */
const PHONE_PREFIX = '57';
const PHONE_DOMAIN = 'phone.minegociofacil.local';

function telefonoToEmail(telefono){
  return `${PHONE_PREFIX}${telefono.replace(/\D/g,'')}@${PHONE_DOMAIN}`;
}
function emailToTelefono(email){
  const local = (email||'').split('@')[0];
  const digits = local.startsWith(PHONE_PREFIX) ? local.slice(PHONE_PREFIX.length) : local;
  return `+${PHONE_PREFIX} ${digits}`;
}
function validarTelefono(telefono){
  return /^\d{10}$/.test(telefono.replace(/\D/g,''));
}
function validarPin(pin){
  return /^\d{6}$/.test(pin);
}

function authErrorMessage(err){
  const mensajes = {
    'auth/invalid-email': 'Ese número de celular no es válido.',
    'auth/user-not-found': 'No existe una cuenta con ese número de celular.',
    'auth/wrong-password': 'Contraseña incorrecta.',
    'auth/invalid-credential': 'Número o contraseña incorrectos.',
    'auth/email-already-in-use': 'Ya existe una cuenta con ese número de celular.',
    'auth/weak-password': 'La contraseña debe tener 6 dígitos.'
  };
  return mensajes[err.code] || 'Ocurrió un error. Intenta de nuevo.';
}

document.getElementById('form-signin').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const errBox = document.getElementById('si-error');
  errBox.hidden = true;
  const telefono = document.getElementById('si-telefono').value.trim();
  const clave = document.getElementById('si-clave').value;
  if(!validarTelefono(telefono)){
    errBox.textContent = 'Ingresa un número de celular válido (10 dígitos).';
    errBox.hidden = false;
    return;
  }
  if(!validarPin(clave)){
    errBox.textContent = 'La contraseña debe tener 6 dígitos.';
    errBox.hidden = false;
    return;
  }
  try{
    await signInWithEmailAndPassword(auth, telefonoToEmail(telefono), clave);
  }catch(err){
    errBox.textContent = authErrorMessage(err);
    errBox.hidden = false;
  }
});

document.getElementById('form-signup').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const errBox = document.getElementById('su-error');
  errBox.hidden = true;
  const telefono = document.getElementById('su-telefono').value.trim();
  const clave = document.getElementById('su-clave').value;
  const clave2 = document.getElementById('su-clave2').value;
  if(!validarTelefono(telefono)){
    errBox.textContent = 'Ingresa un número de celular válido (10 dígitos).';
    errBox.hidden = false;
    return;
  }
  if(!validarPin(clave)){
    errBox.textContent = 'La contraseña debe tener 6 dígitos.';
    errBox.hidden = false;
    return;
  }
  if(clave !== clave2){
    errBox.textContent = 'Las contraseñas no coinciden.';
    errBox.hidden = false;
    return;
  }
  try{
    await createUserWithEmailAndPassword(auth, telefonoToEmail(telefono), clave);
  }catch(err){
    errBox.textContent = authErrorMessage(err);
    errBox.hidden = false;
  }
});

document.getElementById('btn-olvide-clave').addEventListener('click', ()=>{
  document.getElementById('olvide-mensaje').hidden = false;
});

document.getElementById('btn-cerrar-sesion').addEventListener('click', async ()=>{
  if(confirm('¿Cerrar sesión?')){
    await signOut(auth);
    document.getElementById('form-signin').reset();
    document.getElementById('form-signup').reset();
    document.getElementById('olvide-mensaje').hidden = true;
    document.querySelectorAll('#login-tabs .tab').forEach(t=>t.classList.toggle('active', t.dataset.logintab==='signin'));
    document.getElementById('form-signin').hidden = false;
    document.getElementById('form-signup').hidden = true;
  }
});

/* ================= RENDER ================= */
function escapeHtml(s){
  return String(s||'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function normalizarTexto(s){
  return String(s||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
}

function ventasDelPeriodo(period){
  return DB.ventas.filter(v=>!v.anulada && inPeriod(v.fecha, period));
}
function gastosDelPeriodo(period){
  return DB.gastos.filter(g=>inPeriod(g.fecha, period));
}

function renderInicio(){
  const period = periods.inicio;
  const vs = ventasDelPeriodo(period);
  const gs = gastosDelPeriodo(period);
  const totalVentas = vs.reduce((a,v)=>a+v.total,0);
  const totalGastos = gs.reduce((a,g)=>a+g.valor,0);
  document.getElementById('kpi-ventas').textContent = money(totalVentas);
  document.getElementById('kpi-gastos').textContent = money(totalGastos);
  document.getElementById('kpi-ganancia').textContent = money(totalVentas-totalGastos);
  document.getElementById('kpi-inventario').textContent = DB.productos.reduce((a,p)=>a+p.cantidad,0);

  const nombre = (DB.negocio?.propietario || '').trim();
  document.getElementById('saludo').textContent = `¡Hola${nombre ? ', '+nombre.split(' ')[0] : ''}! 👋`;

  // alertas de stock bajo
  const bajos = DB.productos.filter(p=>p.cantidad <= p.cantidadMinima);
  const box = document.getElementById('alertas-inicio');
  box.innerHTML = bajos.map(p=>`<div class="alert">⚠️ El producto <strong>${escapeHtml(p.nombre)}</strong> está próximo a agotarse (quedan ${p.cantidad}).</div>`).join('');
}

function renderProductos(){
  const cont = document.getElementById('lista-productos');
  if(DB.productos.length===0){
    cont.innerHTML = '<div class="empty-state">Aún no tienes productos. Agrega el primero 📦</div>';
    return;
  }
  const filtro = normalizarTexto(document.getElementById('buscar-producto').value.trim());
  const lista = filtro
    ? DB.productos.filter(p=>
        normalizarTexto(p.nombre||'').includes(filtro) ||
        normalizarTexto(p.sku||'').includes(filtro)
      )
    : DB.productos;
  if(lista.length===0){
    cont.innerHTML = '<div class="empty-state">No se encontraron productos con esa búsqueda 🔍</div>';
    return;
  }
  cont.innerHTML = lista.map(p=>{
    const bajo = p.cantidad <= p.cantidadMinima;
    const proveedor = DB.proveedores.find(pr=>pr.id===p.proveedorId);
    const estado = p.estado || 'Activo';
    const detalles = [p.categoria, p.unidadMedida, `IVA ${p.ivaPct ?? 0}%`].filter(Boolean).join(' · ');
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${escapeHtml(p.nombre)}${p.sku ? ` <span class="li-sub">(${escapeHtml(p.sku)})</span>` : ''}${estado!=='Activo' ? `<span class="badge-estado">${escapeHtml(estado)}</span>` : ''}</span>
        <span class="li-sub ${bajo?'stock-low':''}">Disponible: ${p.cantidad}${bajo?' ⚠️ ¡próximo a agotarse!':''}</span>
        ${detalles ? `<span class="li-sub">${escapeHtml(detalles)}</span>` : ''}
        ${proveedor ? `<span class="li-sub">🚚 ${escapeHtml(proveedor.nombre)}</span>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        <span class="li-value">${money(p.precioVenta)}</span>
        <div style="display:flex;gap:6px;">
          <button data-accion="editar-producto" data-id="${p.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Editar</button>
          <button data-accion="eliminar-producto" data-id="${p.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Eliminar</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function saldoClientePendiente(clienteId){
  return DB.ventas
    .filter(v=>v.clienteId===clienteId && v.tipoVenta==='credito' && !v.pagada && !v.anulada)
    .reduce((a,v)=>a+v.total,0);
}

function renderClientes(){
  const cont = document.getElementById('lista-clientes');
  if(DB.clientes.length===0){
    cont.innerHTML = '<div class="empty-state">Aún no tienes clientes registrados 👥</div>';
    return;
  }
  const filtro = normalizarTexto(document.getElementById('buscar-cliente').value.trim());
  const lista = filtro
    ? DB.clientes.filter(c=>
        normalizarTexto(c.nombres||c.nombre||'').includes(filtro) ||
        normalizarTexto(c.numeroIdentificacion||'').includes(filtro)
      )
    : DB.clientes;
  if(lista.length===0){
    cont.innerHTML = '<div class="empty-state">No se encontraron clientes con ese nombre 🔍</div>';
    return;
  }
  cont.innerHTML = lista.map(c=>{
    const nombre = c.nombres || c.nombre || '(sin nombre)';
    const saldo = saldoClientePendiente(c.id);
    const estado = c.estado || 'Activo';
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${escapeHtml(nombre)}${estado!=='Activo' ? `<span class="badge-estado">${escapeHtml(estado)}</span>` : ''}</span>
        <span class="li-sub">${escapeHtml(c.celular||c.telefono||c.correo||'Sin datos de contacto')}</span>
        ${c.contacto ? `<span class="li-sub">Contacto: ${escapeHtml(c.contacto)}</span>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        ${saldo>0 ? `<span class="li-value neg">Debe ${money(saldo)}</span>` : `<span class="li-value">Al día</span>`}
        <div style="display:flex;gap:6px;">
          <button data-accion="editar-cliente" data-id="${c.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Editar</button>
          <button data-accion="eliminar-cliente" data-id="${c.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Eliminar</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderProveedores(){
  const cont = document.getElementById('lista-proveedores');
  if(DB.proveedores.length===0){
    cont.innerHTML = '<div class="empty-state">Aún no tienes proveedores registrados 🚚</div>';
    return;
  }
  const filtro = normalizarTexto(document.getElementById('buscar-proveedor').value.trim());
  const lista = filtro
    ? DB.proveedores.filter(p=>
        normalizarTexto(p.nombre||'').includes(filtro) ||
        normalizarTexto(p.numeroIdentificacion||'').includes(filtro)
      )
    : DB.proveedores;
  if(lista.length===0){
    cont.innerHTML = '<div class="empty-state">No se encontraron proveedores con esa búsqueda 🔍</div>';
    return;
  }
  cont.innerHTML = lista.map(p=>{
    const tipoTxt = p.tipoPersona==='juridica' ? 'Persona jurídica' : 'Persona natural';
    const estado = p.estado || 'Activo';
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${escapeHtml(p.nombre)}${estado!=='Activo' ? `<span class="badge-estado">${escapeHtml(estado)}</span>` : ''}</span>
        <span class="li-sub">${tipoTxt} · ${escapeHtml(p.telefono||p.correo||'Sin datos')}</span>
        ${p.contacto ? `<span class="li-sub">Contacto: ${escapeHtml(p.contacto)}</span>` : ''}
      </div>
      <div style="display:flex;gap:6px;">
        <button data-accion="editar-proveedor" data-id="${p.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Editar</button>
        <button data-accion="eliminar-proveedor" data-id="${p.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Eliminar</button>
      </div>
    </div>`;
  }).join('');
}

function renderFinanzas(){
  const period = periods.finanzas;
  const vs = ventasDelPeriodo(period);
  const gs = gastosDelPeriodo(period);
  const totalVentas = vs.reduce((a,v)=>a+v.total,0);
  const totalGastos = gs.reduce((a,g)=>a+g.valor,0);
  document.getElementById('fin-entro').textContent = money(totalVentas);
  document.getElementById('fin-salio').textContent = money(totalGastos);
  document.getElementById('fin-gano').textContent = money(totalVentas-totalGastos);

  // gráfico últimos 7 días
  const dias = [];
  for(let i=6;i>=0;i--){
    const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-i);
    dias.push(d);
  }
  const totalesDia = dias.map(d=>{
    const next = new Date(d); next.setDate(next.getDate()+1);
    return DB.ventas.filter(v=>{ const f=new Date(v.fecha); return !v.anulada && f>=d && f<next; })
                    .reduce((a,v)=>a+v.total,0);
  });
  const max = Math.max(...totalesDia, 1);
  const chart = document.getElementById('chart-semana');
  chart.innerHTML = dias.map((d,i)=>{
    const h = Math.max(4, Math.round((totalesDia[i]/max)*100));
    return `<div class="bar-col"><div class="bar" style="height:${h}%" title="${money(totalesDia[i])}"></div><span>${d.toLocaleDateString('es-CO',{weekday:'narrow'})}</span></div>`;
  }).join('');

  // top productos (del mes)
  const ventasMes = ventasDelPeriodo('mes');
  const agrupado = {};
  ventasMes.forEach(v=>{
    (v.items||[]).forEach(it=>{
      const key = it.descripcion || 'Venta';
      agrupado[key] = (agrupado[key]||0) + it.cantidad;
    });
  });
  const top = Object.entries(agrupado).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const topCont = document.getElementById('top-productos');
  topCont.innerHTML = top.length ? top.map(([nombre,cant])=>`
    <div class="list-item">
      <div class="li-main"><span class="li-title">${escapeHtml(nombre)}</span></div>
      <span class="li-value">${cant} vendidos</span>
    </div>`).join('') : '<div class="empty-state">Todavía no hay ventas este mes</div>';

  renderMetas();
  renderGastos();
  renderCompras();
}

function renderMetas(){
  const cont = document.getElementById('lista-metas');
  if(DB.metas.length===0){
    cont.innerHTML = '<div class="empty-state">No tienes metas todavía. ¡Crea una! 🎯</div>';
    return;
  }
  cont.innerHTML = DB.metas.map(m=>{
    const vs = ventasDelPeriodo(m.periodo);
    const gs = gastosDelPeriodo(m.periodo);
    const totalVentas = vs.reduce((a,v)=>a+v.total,0);
    const totalGastos = gs.reduce((a,g)=>a+g.valor,0);
    const valorActual = m.tipo==='ventas' ? totalVentas : (totalVentas-totalGastos);
    const pct = Math.min(100, Math.round((valorActual/(m.valor||1))*100));
    const label = m.tipo==='ventas' ? 'Meta de ventas' : 'Meta de ganancia';
    const periodoTxt = m.periodo==='mes' ? 'este mes' : 'esta semana';
    let msg = `Has alcanzado el ${pct}% de tu meta.`;
    if(pct>=100) msg = '¡Meta cumplida! 🎉';
    else if(pct>=70) msg += ' ¡Sigue así! 🚀';
    return `<div class="goal-item">
      <div class="goal-top"><span>${label} (${periodoTxt})</span>
        <button data-accion="eliminar-meta" data-id="${m.id}" style="background:none;border:none;color:#d9534f;font-weight:700;cursor:pointer;">✕</button>
      </div>
      <div class="goal-bar-bg"><div class="goal-bar-fill" style="width:${pct}%"></div></div>
      <div class="goal-msg">${money(valorActual)} de ${money(m.valor)} — ${msg}</div>
    </div>`;
  }).join('');
}

/* ================= CUENTAS POR COBRAR ================= */
function renderDeudores(){
  const cont = document.getElementById('lista-deudores');
  const deudores = DB.clientes
    .map(c=>({ cliente:c, saldo: saldoClientePendiente(c.id) }))
    .filter(d=>d.saldo>0);
  if(deudores.length===0){
    cont.innerHTML = '<div class="empty-state">No tienes clientes con deudas pendientes 🎉</div>';
    return;
  }
  cont.innerHTML = deudores.map(d=>`
    <div class="list-item" data-accion="ver-deuda" data-id="${d.cliente.id}" style="cursor:pointer;">
      <div class="li-main">
        <span class="li-title">${escapeHtml(d.cliente.nombres||d.cliente.nombre||'(sin nombre)')}</span>
        <span class="li-sub">${escapeHtml(d.cliente.celular||d.cliente.telefono||'')}</span>
      </div>
      <span class="li-value neg">${money(d.saldo)}</span>
    </div>`).join('');
}

function renderCobrosPagados(){
  const cont = document.getElementById('lista-cobros-pagados');
  const pagadas = DB.ventas
    .filter(v=>v.tipoVenta==='credito' && v.pagada && !v.anulada)
    .sort((a,b)=> new Date(b.fechaPago||b.fecha) - new Date(a.fechaPago||a.fecha))
    .slice(0,20);
  if(pagadas.length===0){
    cont.innerHTML = '<div class="empty-state">Todavía no has cobrado ninguna venta a crédito</div>';
    return;
  }
  cont.innerHTML = pagadas.map(v=>{
    const cliente = DB.clientes.find(c=>c.id===v.clienteId);
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${escapeHtml(cliente ? (cliente.nombres||cliente.nombre) : '(sin nombre)')} · Factura No. ${v.numeroFactura}</span>
        <span class="li-sub">${v.fechaPago ? `Cobrada el ${fmtDateTime(v.fechaPago)}` : `Vendida el ${fmtDate(v.fecha)}`}</span>
      </div>
      <span class="li-value">${money(v.total)}</span>
    </div>`;
  }).join('');
}

function verDeudaCliente(clienteId){
  const cliente = DB.clientes.find(c=>c.id===clienteId);
  if(!cliente) return;
  const ventasCredito = DB.ventas.filter(v=>v.clienteId===clienteId && v.tipoVenta==='credito' && !v.pagada && !v.anulada);
  document.getElementById('detalle-titulo').textContent = `Deuda de ${cliente.nombres||cliente.nombre||''}`;
  document.getElementById('detalle-body').innerHTML = ventasCredito.length ? ventasCredito.map(v=>{
    const vencida = v.fechaVencimiento && new Date(v.fechaVencimiento) < new Date();
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">Factura No. ${v.numeroFactura}</span>
        <span class="li-sub">${fmtDateTime(v.fecha)}${v.fechaVencimiento ? ` · Vence: ${fmtDate(v.fechaVencimiento)}` : ''}${vencida ? ' ⚠️ Vencida' : ''}</span>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        <span class="li-value ${vencida?'neg':''}">${money(v.total)}</span>
        <button data-accion="marcar-pagada" data-id="${v.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Marcar pagada</button>
      </div>
    </div>`;
  }).join('') : '<div class="empty-state">Sin deudas pendientes</div>';
  openModal('detalle');
}

function anularVenta(ventaId){
  const venta = DB.ventas.find(v=>v.id===ventaId);
  if(!venta || venta.anulada) return;
  if(!confirm('¿Anular esta factura? Se devolverá el inventario descontado y dejará de contar en tus totales y cuentas por cobrar.')) return;
  (venta.items||[]).forEach(it=>{
    if(!it.productoId) return;
    const producto = DB.productos.find(p=>p.id===it.productoId);
    if(producto) producto.cantidad = producto.cantidad + it.cantidad;
  });
  venta.anulada = true;
  registrarCambio('Venta', 'Anular', `Anuló la factura de venta No. ${venta.numeroFactura}`);
  saveDB();
  renderAll();
  toast('Factura anulada 🚫');
}

function marcarVentaPagada(ventaId){
  const venta = DB.ventas.find(v=>v.id===ventaId);
  if(!venta) return;
  venta.pagada = true;
  venta.fechaPago = new Date().toISOString();
  registrarCambio('Venta', 'Pago', `Marcó como pagada la factura de venta No. ${venta.numeroFactura}`);
  saveDB();
  renderAll();
  closeModals();
  toast('Cuenta marcada como pagada ✅');
}

document.getElementById('lista-deudores').addEventListener('click', (e)=>{
  const el = e.target.closest('[data-accion="ver-deuda"]');
  if(el) verDeudaCliente(el.dataset.id);
});

document.getElementById('detalle-body').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-accion="marcar-pagada"]');
  if(btn) marcarVentaPagada(btn.dataset.id);
});

/* ================= CIERRE DE CAJA ================= */
function abrirCierreCaja(){
  const ventasHoy = ventasDelPeriodo('dia');
  const contado = ventasHoy.filter(v=>v.tipoVenta!=='credito');
  const credito = ventasHoy.filter(v=>v.tipoVenta==='credito');
  const totalContado = contado.reduce((a,v)=>a+v.total,0);
  const totalCredito = credito.reduce((a,v)=>a+v.total,0);

  const porMetodo = {};
  contado.forEach(v=>{
    const m = v.metodoPago || 'Otro';
    porMetodo[m] = (porMetodo[m]||0) + v.total;
  });
  const lineasMetodo = Object.entries(porMetodo).map(([m,val])=>
    `<div class="cierre-line"><span>${escapeHtml(m)}</span><span>${money(val)}</span></div>`
  ).join('') || '<div class="cierre-line"><span>Sin ventas</span></div>';

  document.getElementById('detalle-titulo').textContent = '📋 Cierre de caja de hoy';
  document.getElementById('detalle-body').innerHTML = `
    <div class="cierre-split">
      <div class="cierre-col">
        <h4>💵 Contado</h4>
        <div class="cierre-total">${money(totalContado)}</div>
        ${lineasMetodo}
      </div>
      <div class="cierre-col">
        <h4>🧾 Crédito</h4>
        <div class="cierre-total">${money(totalCredito)}</div>
        <div class="cierre-line"><span>${credito.length} venta(s)</span></div>
      </div>
    </div>`;
  openModal('detalle');
}
document.getElementById('btn-cierre-caja').addEventListener('click', abrirCierreCaja);

/* ================= FACTURA IMPRIMIBLE ================= */
function mostrarFactura(ventaId){
  const venta = DB.ventas.find(v=>v.id===ventaId);
  if(!venta) return;
  const cliente = DB.clientes.find(c=>c.id===venta.clienteId);
  const n = DB.negocio || {};
  const fecha = new Date(venta.fecha);
  const dd = String(fecha.getDate()).padStart(2,'0');
  const mm = String(fecha.getMonth()+1).padStart(2,'0');
  const aaaa = fecha.getFullYear();

  const filasItems = venta.items.map(it=>`
    <tr>
      <td>${escapeHtml(it.codigo||'')}</td>
      <td>${escapeHtml(it.descripcion)}</td>
      <td>${money(it.precioUnitario)}</td>
      <td>${it.cantidad}</td>
      <td>${venta.descuentoPct||0}%</td>
      <td>${it.ivaPct||0}%</td>
      <td>${money(it.total)}</td>
    </tr>`).join('');

  const titulo = `Factura de venta No. ${venta.numeroFactura}${venta.anulada ? ' — ANULADA' : ''}`;
  const html = `
    <button type="button" class="btn btn-secondary btn-block no-print" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
    <div class="factura-doc">
      <div class="factura-header">
        <div>
          <strong>${escapeHtml(n.nombre||'')}</strong><br>
          NIT: ${escapeHtml(n.nit||'')}<br>
          Dirección: ${escapeHtml(n.direccionNegocio||'')}<br>
          Teléfono: ${escapeHtml(n.telefonoNegocio||'')} &nbsp; Ciudad: ${escapeHtml(n.ciudad||'')}
        </div>
        <div class="num-box">
          FACTURA DE VENTA<br>No. ${venta.numeroFactura}${venta.anulada ? '<br><span style="color:#d9534f;">ANULADA</span>' : ''}
        </div>
      </div>
      <div style="font-size:11px;margin-bottom:8px;">
        Resolución de autorización DIAN No. ${escapeHtml(n.resolucionDian||'(pendiente de trámite)')}
        ${n.rangoDesde ? ` — Del No. ${escapeHtml(n.rangoDesde)} al No. ${escapeHtml(n.rangoHasta||'')}` : ''}
        <br>Fecha de factura: ${dd}/${mm}/${aaaa}
        ${n.agenteIva==='Sí' ? '<br>Calidad de agente retenedor de IVA: Sí' : ''}
        ${n.ciiu ? `<br>Código CIIU / Tarifa ICA: ${escapeHtml(n.ciiu)}` : ''}
      </div>
      <div style="font-size:11px;margin-bottom:8px;border-top:1px solid #333;padding-top:6px;">
        <strong>Vendido a:</strong> ${escapeHtml(cliente ? (cliente.nombres||cliente.nombre) : 'Consumidor final')}<br>
        ${cliente ? `${escapeHtml(cliente.tipoIdentificacion||'')}: ${escapeHtml(cliente.numeroIdentificacion||'')}<br>` : ''}
        ${cliente ? `Dirección: ${escapeHtml(cliente.direccion||'')} &nbsp; Ciudad: ${escapeHtml(cliente.ciudad||'')}<br>` : ''}
        ${cliente ? `Teléfono: ${escapeHtml(cliente.celular||cliente.telefono||'')}` : ''}
      </div>
      <table>
        <thead><tr><th>Código</th><th>Descripción</th><th>Vr. Unitario</th><th>Cantidad</th><th>Dcto %</th><th>IVA %</th><th>Vr. Total</th></tr></thead>
        <tbody>${filasItems}</tbody>
      </table>
      <div class="factura-totales">
        <div class="cierre-line"><span>Total sin IVA</span><span>${money(venta.subtotal - venta.descuentoTotal)}</span></div>
        <div class="cierre-line"><span>Descuento</span><span>${money(venta.descuentoTotal)}</span></div>
        <div class="cierre-line"><span>IVA</span><span>${money(venta.ivaTotal)}</span></div>
        <div class="cierre-line" style="font-weight:800;font-size:14px;"><span>Valor total</span><span>${money(venta.total)}</span></div>
      </div>
      <div style="font-size:11px;margin-top:10px;">
        <strong>Forma de pago:</strong> ${venta.tipoVenta==='credito' ? 'Crédito' : `Contado (${escapeHtml(venta.metodoPago||'')})`}
      </div>
      <div class="factura-firmas">
        <div>Firma autorizada del emisor</div>
        <div>Firma de recibido del comprador</div>
      </div>
    </div>
  `;
  mostrarDetalle(titulo, html, 'factura-detalle-panel');
  marcarSeleccionLista('lista-facturas', ventaId);
}

function renderFacturas(){
  const cont = document.getElementById('lista-facturas');
  const ventasOrdenadas = DB.ventas.slice().sort((a,b)=> new Date(b.fecha) - new Date(a.fecha)).slice(0,20);
  if(ventasOrdenadas.length===0){
    cont.innerHTML = '<div class="empty-state">Aún no has registrado facturas</div>';
    return;
  }
  cont.innerHTML = ventasOrdenadas.map(v=>{
    const cliente = DB.clientes.find(c=>c.id===v.clienteId);
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">Factura No. ${v.numeroFactura}${v.anulada ? '<span class="badge-estado">Anulada</span>' : ''}</span>
        <span class="li-sub">${fmtDateTime(v.fecha)} · ${escapeHtml(cliente ? (cliente.nombres||cliente.nombre) : 'Consumidor final')}</span>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        <span class="li-value">${money(v.total)}</span>
        <div style="display:flex;gap:6px;">
          <button data-accion="ver-factura" data-id="${v.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Ver</button>
          ${v.anulada ? '' : `<button data-accion="anular-factura" data-id="${v.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Anular</button>`}
        </div>
      </div>
    </div>`;
  }).join('');
}
document.getElementById('lista-facturas').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-accion]');
  if(!btn) return;
  if(btn.dataset.accion==='ver-factura') mostrarFactura(btn.dataset.id);
  if(btn.dataset.accion==='anular-factura') anularVenta(btn.dataset.id);
});

/* ================= KARDEX ================= */
function poblarSelectKardex(){
  const sel = document.getElementById('kardex-producto');
  const actual = sel.value;
  sel.innerHTML = DB.productos.map(p=>`<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join('');
  if(actual && DB.productos.some(p=>p.id===actual)) sel.value = actual;
}

function renderKardex(){
  const sel = document.getElementById('kardex-producto');
  if(DB.productos.length===0){
    sel.innerHTML = '';
    document.getElementById('kardex-lista').innerHTML = '<div class="empty-state">Agrega productos para ver su Kardex</div>';
    document.getElementById('kardex-saldo-actual').textContent = '0';
    return;
  }
  poblarSelectKardex();
  const productoId = sel.value;
  const producto = DB.productos.find(p=>p.id===productoId);
  document.getElementById('kardex-saldo-actual').textContent = producto ? producto.cantidad : '0';

  const movimientos = [];
  DB.compras.forEach(c=>{
    (c.items||[]).forEach(it=>{
      if(it.productoId===productoId) movimientos.push({fecha:c.fecha, tipo:'Entrada', documento:`Compra${c.numeroFacturaProveedor?' '+c.numeroFacturaProveedor:''}`, cantidad: it.cantidad});
    });
  });
  DB.ventas.forEach(v=>{
    if(v.anulada) return;
    (v.items||[]).forEach(it=>{
      if(it.productoId===productoId) movimientos.push({fecha:v.fecha, tipo:'Salida', documento:`Factura #${v.numeroFactura}`, cantidad: -it.cantidad});
    });
  });
  DB.ajustesInventario.forEach(a=>{
    if(a.productoId===productoId) movimientos.push({fecha:a.fecha, tipo:'Ajuste', documento:a.motivo||'Ajuste', cantidad: a.tipo==='entrada' ? a.cantidad : -a.cantidad});
  });
  movimientos.sort((a,b)=> new Date(a.fecha) - new Date(b.fecha));

  const cont = document.getElementById('kardex-lista');
  if(movimientos.length===0){
    cont.innerHTML = '<div class="empty-state">Sin movimientos registrados todavía para este producto</div>';
    return;
  }
  let saldo = 0;
  cont.innerHTML = movimientos.map(m=>{
    saldo += m.cantidad;
    const signo = m.cantidad>=0 ? '+' : '';
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${m.tipo} — ${escapeHtml(m.documento)}</span>
        <span class="li-sub">${fmtDateTime(m.fecha)}</span>
      </div>
      <span class="li-value ${m.cantidad<0?'neg':''}">${signo}${m.cantidad} · Saldo: ${saldo}</span>
    </div>`;
  }).join('');
}
document.getElementById('kardex-producto').addEventListener('change', renderKardex);

function renderPerfil(){
  if(!DB.negocio) return;
  document.getElementById('pf-propietario').value = DB.negocio.propietario||'';
  document.getElementById('pf-nombre').value = DB.negocio.nombre||'';
  document.getElementById('pf-tipo').value = DB.negocio.tipo||'';
  document.getElementById('pf-ciudad').value = DB.negocio.ciudad||'';
  document.getElementById('pf-moneda').value = DB.negocio.moneda||'COP';
  document.getElementById('pf-nit').value = DB.negocio.nit||'';
  document.getElementById('pf-direccion-negocio').value = DB.negocio.direccionNegocio||'';
  document.getElementById('pf-telefono-negocio').value = DB.negocio.telefonoNegocio||'';
  document.getElementById('pf-resolucion-dian').value = DB.negocio.resolucionDian||'';
  document.getElementById('pf-rango-desde').value = DB.negocio.rangoDesde||'';
  document.getElementById('pf-rango-hasta').value = DB.negocio.rangoHasta||'';
  document.getElementById('pf-ciiu').value = DB.negocio.ciiu||'';
  document.getElementById('pf-agente-iva').value = DB.negocio.agenteIva||'No';
  document.getElementById('pf-correo-actual').textContent = currentUser?.email ? `Sesión iniciada con el celular ${emailToTelefono(currentUser.email)}` : '';
}

/* ================= CAMBIOS EN EL SISTEMA ================= */
function renderCambios(){
  const cont = document.getElementById('lista-cambios');
  if(!DB.cambios || DB.cambios.length===0){
    cont.innerHTML = '<div class="empty-state">Todavía no hay cambios registrados</div>';
    return;
  }
  cont.innerHTML = DB.cambios.map(c=>`<div class="list-item">
      <div class="li-main">
        <span class="li-title">${escapeHtml(c.modulo)} · ${escapeHtml(c.accion)}</span>
        <span class="li-sub">${escapeHtml(c.descripcion)}</span>
      </div>
      <span class="li-sub">${fmtDateTime(c.fecha)}</span>
    </div>`).join('');
}
document.getElementById('btn-ver-cambios').addEventListener('click', ()=> switchView('cambios'));
document.getElementById('btn-volver-perfil').addEventListener('click', ()=> switchView('perfil'));

function renderTopbar(){
  const nombreNegocio = DB.negocio?.nombre || 'Mi negocio';
  document.getElementById('tb-negocio').textContent = nombreNegocio;
  document.getElementById('tb-fecha').textContent = new Date().toLocaleDateString('es-CO', {weekday:'long', day:'numeric', month:'long'});
  document.getElementById('nav-label-registrar').textContent = DB.negocio?.nombre || 'Registrar';
  document.getElementById('registrar-titulo').textContent = DB.negocio?.nombre || 'Registrar';
}

function renderAll(){
  if(!DB.negocio) return;
  renderTopbar();
  renderInicio();
  renderProductos();
  renderClientes();
  renderProveedores();
  renderKardex();
  renderFinanzas();
  renderFacturas();
  renderCuentas();
  renderPerfil();
  renderCambios();
}

/* ================= INSTALAR APP (PWA) ================= */
function isStandalone(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIos(){
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById('install-card').hidden = false;
});
document.getElementById('btn-instalar').addEventListener('click', async ()=>{
  if(!deferredPrompt) { toast('Abre el menú de tu navegador y elige "Agregar a pantalla de inicio"'); return; }
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  document.getElementById('install-card').hidden = true;
});

if(isIos() && !isStandalone()){
  document.getElementById('install-card').hidden = false;
  document.getElementById('btn-instalar').hidden = true;
  document.getElementById('install-steps-ios').hidden = false;
}

if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  });
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    window.location.reload();
  });
}

document.getElementById('btn-actualizar-app').addEventListener('click', async ()=>{
  toast('Buscando actualizaciones… 🔄');
  try{
    if('serviceWorker' in navigator){
      const reg = await navigator.serviceWorker.getRegistration();
      if(reg) await reg.update();
    }
  }catch(e){ /* si falla, igual recargamos abajo */ }
  setTimeout(()=> window.location.reload(), 600);
});

/* ================= BOOT ================= */
onAuthStateChanged(auth, async (user)=>{
  if(user){
    currentUser = user;
    showView('view-cargando');
    DB = await loadUserDB(user.uid);
    if(DB.negocio){
      showView('app');
      switchView(currentView);
    } else {
      showView('view-onboarding');
    }
  } else {
    currentUser = null;
    DB = null;
    showView('view-login');
  }
});
