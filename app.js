/* =======================================================
   MI NEGOCIO FÁCIL - lógica de la aplicación
   Datos guardados en Firestore, uno por cuenta (un negocio por usuario).
   ======================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, deleteUser
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, doc, getDoc, setDoc, deleteDoc
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

// App secundaria de Firebase: se usa solo para crear cuentas de empleados sin
// cerrar la sesión del administrador (crear un usuario con el SDK normalmente
// inicia sesión automáticamente como ese usuario nuevo).
const secondaryApp = initializeApp(firebaseConfig, 'secundaria');
const secondaryAuth = getAuth(secondaryApp);

const STORAGE_KEY = 'mnf_data_v1'; // clave usada por versiones anteriores (localStorage), solo para migrar datos viejos

const CURRENCY_SYMBOLS = {
  COP: '$', USD: 'US$', MXN: 'MX$', PEN: 'S/', CLP: 'CLP$', ARS: 'AR$', EUR: '€'
};

let DB = null;
let currentUser = null;
let negocioId = null; // id del documento negocios/{id} que se está usando (propio o del negocio al que fue invitado)
let rolActual = 'admin'; // 'admin' o 'empleado'

function esAdmin(){ return rolActual !== 'empleado'; }

/* ---------- Persistencia (Firestore, por usuario) ---------- */
function emptyDB(){
  return { negocio: null, productos: [], clientes: [], proveedores: [], ventas: [], compras: [], ajustesInventario: [], gastos: [], metas: [], cambios: [] };
}

async function loadUserDB(idNegocio){
  const ref = doc(db, 'negocios', idNegocio);
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
  if(!currentUser || !negocioId) return;
  setDoc(doc(db, 'negocios', negocioId), DB).catch(()=>{
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

/* ---------- Filtro de fecha (desde/hasta) reutilizable en varias secciones ---------- */
let dateFilters = {}; // { prefijo: {desde:'YYYY-MM-DD', hasta:'YYYY-MM-DD'} }

function enRangoFecha(fechaISO, prefijo){
  const f = dateFilters[prefijo];
  if(!f || (!f.desde && !f.hasta)) return true;
  const d = new Date(fechaISO);
  if(f.desde && d < new Date(f.desde+'T00:00:00')) return false;
  if(f.hasta && d > new Date(f.hasta+'T23:59:59')) return false;
  return true;
}
function filtroFechaActivo(prefijo){
  const f = dateFilters[prefijo];
  return !!(f && (f.desde || f.hasta));
}
function wireDateFilter(prefijo, onChange){
  const desde = document.getElementById(prefijo+'-desde');
  const hasta = document.getElementById(prefijo+'-hasta');
  const limpiar = document.getElementById(prefijo+'-limpiar');
  if(!desde || !hasta) return;
  const actualizar = ()=>{
    dateFilters[prefijo] = { desde: desde.value, hasta: hasta.value };
    onChange();
  };
  desde.addEventListener('change', actualizar);
  hasta.addEventListener('change', actualizar);
  if(limpiar) limpiar.addEventListener('click', ()=>{
    desde.value=''; hasta.value='';
    dateFilters[prefijo] = { desde:'', hasta:'' };
    onChange();
  });
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
let periods = { inicio:'dia', finanzas:'mes', dashboardGran:'dia' };

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

wireDateFilter('kardex', renderKardex);
wireDateFilter('cambios', renderCambios);
wireDateFilter('facturas', renderFacturas);
wireDateFilter('gastos', renderGastos);
wireDateFilter('compras', renderCompras);
wireDateFilter('cobros', renderCobrosPagados);
wireDateFilter('pagosprov', renderPagosRealizados);
wireDateFilter('porcobrar', renderDeudores);
wireDateFilter('porpagar', renderPorPagar);
wireDateFilter('resumen', renderResumenCuentas);
wireDateFilter('historial', renderHistorialMensual);
wireDateFilter('dashboard', renderDashboard);
wireDateFilter('abonoscli', renderAbonosClientes);
wireDateFilter('abonosprov', renderAbonosProveedores);

/* ---------- Búsqueda de producto por código de barras / SKU / nombre (al facturar) ---------- */
function buscarProductoPorCodigo(query){
  const q = (query||'').trim();
  if(!q) return null;
  const porBarras = DB.productos.find(p=>p.codigoBarras && p.codigoBarras===q);
  if(porBarras) return porBarras;
  const porSku = DB.productos.find(p=>p.sku && p.sku.toLowerCase()===q.toLowerCase());
  if(porSku) return porSku;
  const qNorm = normalizarTexto(q);
  return DB.productos.find(p=>normalizarTexto(p.nombre||'').includes(qNorm)) || null;
}
function wireBuscarProducto(inputId, selectId){
  const input = document.getElementById(inputId);
  const select = document.getElementById(selectId);
  if(!input || !select) return;
  input.addEventListener('keydown', (e)=>{
    if(e.key !== 'Enter') return;
    e.preventDefault();
    const encontrado = buscarProductoPorCodigo(input.value);
    if(encontrado){
      select.value = encontrado.id;
      select.dispatchEvent(new Event('change'));
      input.value = '';
    } else if(input.value.trim()){
      toast('No se encontró ningún producto con ese código o nombre 🔍');
    }
  });
}
wireBuscarProducto('v-buscar-producto', 'v-producto');
wireBuscarProducto('co-buscar-producto', 'co-producto');

/* ---------- Búsqueda de cliente/proveedor por cédula/NIT o nombre (sin lista desplegable) ---------- */
const buscadoresEntidad = {};
function wireBuscarEntidad(clave, {buscarId, selectId, resultadoId, quitarId, lista, obtenerNombre}){
  const input = document.getElementById(buscarId);
  const select = document.getElementById(selectId);
  const resultado = document.getElementById(resultadoId);
  const quitar = document.getElementById(quitarId);
  if(!input || !select || !resultado) return;
  const texto = resultado.querySelector('.selector-resultado-texto');
  const mostrar = (entidad)=>{
    select.value = entidad.id;
    select.dispatchEvent(new Event('change'));
    const nombre = obtenerNombre(entidad) || '(sin nombre)';
    texto.textContent = `${nombre}${entidad.numeroIdentificacion ? ' · '+entidad.numeroIdentificacion : ''}`;
    resultado.hidden = false;
    input.hidden = true;
  };
  input.addEventListener('keydown', (e)=>{
    if(e.key !== 'Enter') return;
    e.preventDefault();
    const q = input.value.trim();
    if(!q) return;
    const soloDigitos = q.replace(/\D/g,'');
    const qNorm = normalizarTexto(q);
    const encontrada = lista().find(x=>
      (soloDigitos && (x.numeroIdentificacion||'').replace(/\D/g,'')===soloDigitos) ||
      normalizarTexto(obtenerNombre(x)||'').includes(qNorm)
    );
    if(encontrada) mostrar(encontrada);
    else toast('No se encontró ningún registro con esa identificación o nombre 🔍');
  });
  quitar?.addEventListener('click', ()=>{
    select.value = '';
    select.dispatchEvent(new Event('change'));
    resultado.hidden = true;
    input.hidden = false;
    input.value = '';
  });
  buscadoresEntidad[clave] = {
    reset(){ resultado.hidden = true; input.hidden = false; input.value = ''; },
    mostrarPorId(id){
      const entidad = lista().find(x=>x.id===id);
      if(entidad) mostrar(entidad); else this.reset();
    }
  };
}
wireBuscarEntidad('cliente', {
  buscarId:'v-buscar-cliente', selectId:'v-cliente', resultadoId:'v-cliente-resultado', quitarId:'v-cliente-quitar',
  lista: ()=>DB.clientes, obtenerNombre: (c)=> c.nombres||c.nombre
});
wireBuscarEntidad('proveedor', {
  buscarId:'co-buscar-proveedor', selectId:'co-proveedor', resultadoId:'co-proveedor-resultado', quitarId:'co-proveedor-quitar',
  lista: ()=>DB.proveedores, obtenerNombre: (p)=> p.nombre
});

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
    if(tipo==='empleado') return abrirModalEmpleado();
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
  document.getElementById('p-codigo-barras').value = producto?.codigoBarras || '';
  document.getElementById('p-categoria').value = producto?.categoria || '';
  document.getElementById('p-unidad').value = producto?.unidadMedida || '';
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

function generarCodigoBarras(){
  let codigo;
  do{
    codigo = String(Date.now()).slice(-9) + String(Math.floor(Math.random()*90)+10);
  } while(DB.productos.some(p=>p.codigoBarras===codigo));
  return codigo;
}

document.getElementById('form-producto').addEventListener('submit', (e)=>{
  e.preventDefault();
  const id = document.getElementById('p-id').value;
  if(!id && !esAdmin()){ toast('Solo el administrador puede crear productos nuevos ⚠️'); return; }
  const existente = id ? DB.productos.find(p=>p.id===id) : null;
  const codigoIngresado = document.getElementById('p-codigo-barras').value.trim();
  const datos = {
    nombre: document.getElementById('p-nombre').value.trim(),
    sku: document.getElementById('p-sku').value.trim(),
    codigoBarras: codigoIngresado || existente?.codigoBarras || generarCodigoBarras(),
    categoria: document.getElementById('p-categoria').value.trim(),
    unidadMedida: document.getElementById('p-unidad').value.trim(),
    precioCompra: Number(document.getElementById('p-compra').value)||0,
    precioVenta: Number(document.getElementById('p-venta').value)||0,
    ivaPct: Number(document.getElementById('p-iva').value)||0,
    cantidadMinima: Number(document.getElementById('p-minima').value)||0,
    proveedorId: document.getElementById('p-proveedor').value || null,
    estado: document.getElementById('p-estado').value
  };
  if(yaExisteEnLista(DB.productos, id, 'nombre', datos.nombre)){
    toast('Ya existe un producto con ese nombre ⚠️');
    return;
  }
  if(id){
    const producto = DB.productos.find(p=>p.id===id);
    if(producto) Object.assign(producto, datos);
    registrarCambio('Producto', 'Editar', `Editó el producto "${datos.nombre}"`);
  } else {
    DB.productos.push({ id: uid(), cantidad: 0, ...datos });
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
  if(yaExisteEnLista(DB.clientes, id, 'numeroIdentificacion', datos.numeroIdentificacion)){
    toast('Ya existe un cliente con ese número de identificación ⚠️');
    return;
  }
  if(id){
    const cliente = DB.clientes.find(c=>c.id===id);
    if(cliente) Object.assign(cliente, datos);
    registrarCambio('Cliente', 'Editar', `Editó el cliente "${datos.nombres}"`);
  } else {
    DB.clientes.push({ id: uid(), creado: new Date().toISOString(), ...datos });
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
  if(yaExisteEnLista(DB.proveedores, id, 'numeroIdentificacion', datos.numeroIdentificacion)){
    toast('Ya existe un proveedor con ese número de identificación ⚠️');
    return;
  }
  if(id){
    const proveedor = DB.proveedores.find(p=>p.id===id);
    if(proveedor) Object.assign(proveedor, datos);
    registrarCambio('Proveedor', 'Editar', `Editó el proveedor "${datos.nombre}"`);
  } else {
    DB.proveedores.push({ id: uid(), creado: new Date().toISOString(), ...datos });
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
  buscadoresEntidad.cliente?.reset();
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
  if(compra?.proveedorId) buscadoresEntidad.proveedor?.mostrarPorId(compra.proveedorId);
  else buscadoresEntidad.proveedor?.reset();
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
  const limiteC = filtroFechaActivo('compras') ? 200 : 20;
  const comprasOrdenadas = DB.compras.filter(c=>enRangoFecha(c.fecha,'compras')).sort((a,b)=> new Date(b.fecha) - new Date(a.fecha)).slice(0,limiteC);
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
          ${esAdmin() ? `<button data-accion="eliminar-compra" data-id="${c.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Eliminar</button>` : ''}
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
    .filter(c=>c.tipoCompra==='credito' && !c.pagada && enRangoFecha(c.fecha,'porpagar'))
    .sort((a,b)=> new Date(a.fecha) - new Date(b.fecha));
  if(pendientes.length===0){
    cont.innerHTML = '<div class="empty-state">No tienes cuentas por pagar pendientes 🎉</div>';
    return;
  }
  cont.innerHTML = pendientes.map(c=>{
    const proveedor = DB.proveedores.find(pr=>pr.id===c.proveedorId);
    const vencida = c.fechaVencimiento && new Date(c.fechaVencimiento) < new Date();
    const abonado = totalAbonado(c);
    const saldo = saldoFactura(c);
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${proveedor ? escapeHtml(proveedor.nombre) : 'Proveedor eliminado'}</span>
        <span class="li-sub">${fmtDate(c.fecha)}${c.numeroFacturaProveedor ? ` · ${escapeHtml(c.numeroFacturaProveedor)}` : ''}${c.fechaVencimiento ? ` · Vence: ${fmtDate(c.fechaVencimiento)}` : ''}${vencida ? ' ⚠️ Vencida' : ''}</span>
        ${abonado>0 ? `<span class="li-sub">Total ${money(c.total)} · Abonado ${money(abonado)}</span>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        <span class="li-value neg">${money(saldo)}</span>
        <div style="display:flex;gap:6px;">
          <button data-accion="abonar-compra" data-id="${c.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Abonar</button>
          <button data-accion="marcar-compra-pagada" data-id="${c.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Marcar pagada</button>
        </div>
      </div>
    </div>`;
  }).join('');
}
document.getElementById('lista-por-pagar').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-accion]');
  if(!btn) return;
  if(btn.dataset.accion==='marcar-compra-pagada') marcarCompraPagada(btn.dataset.id);
  if(btn.dataset.accion==='abonar-compra') abrirModalAbono('compra', btn.dataset.id);
});

function renderPagosRealizados(){
  const cont = document.getElementById('lista-pagos-realizados');
  const limitePag = filtroFechaActivo('pagosprov') ? 200 : 20;
  const pagadas = DB.compras
    .filter(c=>c.tipoCompra==='credito' && c.pagada && enRangoFecha(c.fechaPago||c.fecha,'pagosprov'))
    .sort((a,b)=> new Date(b.fechaPago||b.fecha) - new Date(a.fechaPago||a.fecha))
    .slice(0,limitePag);
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
    const saldo = saldoFactura(v);
    if(estaVencida){
      vencida += saldo;
      vencidasPorCliente[v.clienteId] = (vencidasPorCliente[v.clienteId]||0) + saldo;
    } else {
      vigente += saldo;
    }
  });
  document.getElementById('cartera-vigente').textContent = money(vigente);
  document.getElementById('cartera-vencida').textContent = money(vencida);
  document.getElementById('cartera-total').textContent = money(vigente+vencida);

  const cont = document.getElementById('lista-cartera-vencida');
  const filas = Object.entries(vencidasPorCliente);
  if(filas.length===0){
    cont.innerHTML = '<div class="empty-state">No tienes cartera vencida 🎉</div>';
  } else {
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
  renderAbonosClientes();
}

function abrirCarteraDetalle(tipo){
  const hoy = new Date();
  const pendientes = DB.ventas.filter(v=>v.tipoVenta==='credito' && !v.pagada && !v.anulada);
  const filas = pendientes.map(v=>{
    const vencida = v.fechaVencimiento && new Date(v.fechaVencimiento) < hoy;
    return { v, vencida, saldo: saldoFactura(v) };
  }).filter(x=> tipo==='vencida' ? x.vencida : !x.vencida)
    .sort((a,b)=> new Date(a.v.fechaVencimiento||a.v.fecha) - new Date(b.v.fechaVencimiento||b.v.fecha));

  const titulo = tipo==='vencida' ? '⚠️ Cartera vencida — detalle' : '✅ Cartera vigente — detalle';
  const html = filas.length ? filas.map(({v,saldo})=>{
    const cliente = DB.clientes.find(c=>c.id===v.clienteId);
    const dias = v.fechaVencimiento ? Math.round((new Date(v.fechaVencimiento)-hoy)/86400000) : null;
    const diasTxt = dias===null ? 'Sin fecha de vencimiento'
      : tipo==='vencida' ? `Vencida hace ${Math.abs(dias)} día(s)`
      : `Vence en ${dias} día(s)`;
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${escapeHtml(cliente?.nombres||cliente?.nombre||'(sin nombre)')} · Factura No. ${v.numeroFactura}</span>
        <span class="li-sub">${fmtDate(v.fecha)} · ${diasTxt}</span>
      </div>
      <span class="li-value ${tipo==='vencida'?'neg':''}">${money(saldo)}</span>
    </div>`;
  }).join('') : '<div class="empty-state">Sin facturas en esta categoría 🎉</div>';

  document.getElementById('detalle-titulo').textContent = titulo;
  document.getElementById('detalle-body').innerHTML = html;
  openModal('detalle');
}
document.getElementById('btn-cartera-vigente').addEventListener('click', ()=> abrirCarteraDetalle('vigente'));
document.getElementById('btn-cartera-vencida').addEventListener('click', ()=> abrirCarteraDetalle('vencida'));

function renderAbonosClientes(){
  const cont = document.getElementById('lista-abonos-clientes');
  if(!cont) return;
  const abonos = [];
  DB.ventas.forEach(v=>{
    (v.abonos||[]).forEach(ab=> abonos.push({ ...ab, venta:v }));
  });
  const filtrados = abonos.filter(a=> enRangoFecha(a.fecha,'abonoscli')).sort((a,b)=> new Date(b.fecha)-new Date(a.fecha));
  if(filtrados.length===0){
    cont.innerHTML = '<div class="empty-state">Todavía no se han registrado abonos de clientes</div>';
    return;
  }
  cont.innerHTML = filtrados.map(a=>{
    const cliente = DB.clientes.find(c=>c.id===a.venta.clienteId);
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${escapeHtml(cliente?.nombres||cliente?.nombre||'(sin nombre)')} · Factura No. ${a.venta.numeroFactura}</span>
        <span class="li-sub">${fmtDateTime(a.fecha)}</span>
      </div>
      <span class="li-value">${money(a.valor)}</span>
    </div>`;
  }).join('');
}

function renderAbonosProveedores(){
  const cont = document.getElementById('lista-abonos-proveedores');
  if(!cont) return;
  const abonos = [];
  DB.compras.forEach(c=>{
    (c.abonos||[]).forEach(ab=> abonos.push({ ...ab, compra:c }));
  });
  const filtrados = abonos.filter(a=> enRangoFecha(a.fecha,'abonosprov')).sort((a,b)=> new Date(b.fecha)-new Date(a.fecha));
  if(filtrados.length===0){
    cont.innerHTML = '<div class="empty-state">Todavía no se han registrado abonos a proveedores</div>';
    return;
  }
  cont.innerHTML = filtrados.map(a=>{
    const proveedor = DB.proveedores.find(p=>p.id===a.compra.proveedorId);
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${proveedor ? escapeHtml(proveedor.nombre) : 'Proveedor eliminado'}${a.compra.numeroFacturaProveedor ? ` · ${escapeHtml(a.compra.numeroFacturaProveedor)}` : ''}</span>
        <span class="li-sub">${fmtDateTime(a.fecha)}</span>
      </div>
      <span class="li-value">${money(a.valor)}</span>
    </div>`;
  }).join('');
}

function renderCuentas(){
  renderDeudores();
  renderCobrosPagados();
  renderPorPagar();
  renderPagosRealizados();
  renderAbonosProveedores();
  renderCartera();
  renderResumenCuentas();
}

/* ================= RESUMEN CUENTAS (tablas estilo Excel) ================= */
function renderResumenCuentas(){
  const contCobrar = document.getElementById('tabla-resumen-cobrar');
  const contPagar = document.getElementById('tabla-resumen-pagar');
  if(!contCobrar || !contPagar) return;

  const porCliente = {};
  DB.ventas.filter(v=>v.tipoVenta==='credito' && !v.pagada && !v.anulada && enRangoFecha(v.fecha,'resumen')).forEach(v=>{
    if(!porCliente[v.clienteId]) porCliente[v.clienteId] = { facturas:0, total:0 };
    porCliente[v.clienteId].facturas++;
    porCliente[v.clienteId].total += saldoFactura(v);
  });
  const filasCobrar = Object.entries(porCliente).map(([clienteId,d])=>{
    const cliente = DB.clientes.find(c=>c.id===clienteId);
    return { nombre: cliente ? (cliente.nombres||cliente.nombre||'(sin nombre)') : '(cliente eliminado)', ...d };
  }).sort((a,b)=> b.total-a.total);

  contCobrar.innerHTML = filasCobrar.length ? `
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Cliente</th><th class="num"># Facturas</th><th class="num">Total adeudado</th></tr></thead>
      <tbody>${filasCobrar.map(f=>`<tr><td>${escapeHtml(f.nombre)}</td><td class="num">${f.facturas}</td><td class="num">${money(f.total)}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="total-row"><td>TOTAL</td><td class="num">${filasCobrar.reduce((a,f)=>a+f.facturas,0)}</td><td class="num">${money(filasCobrar.reduce((a,f)=>a+f.total,0))}</td></tr></tfoot>
    </table></div>` : '<div class="empty-state">No hay cuentas por cobrar pendientes 🎉</div>';

  const porProveedor = {};
  DB.compras.filter(c=>c.tipoCompra==='credito' && !c.pagada && enRangoFecha(c.fecha,'resumen')).forEach(c=>{
    if(!porProveedor[c.proveedorId]) porProveedor[c.proveedorId] = { facturas:0, total:0 };
    porProveedor[c.proveedorId].facturas++;
    porProveedor[c.proveedorId].total += saldoFactura(c);
  });
  const filasPagar = Object.entries(porProveedor).map(([proveedorId,d])=>{
    const proveedor = DB.proveedores.find(p=>p.id===proveedorId);
    return { nombre: proveedor ? proveedor.nombre : '(proveedor eliminado)', ...d };
  }).sort((a,b)=> b.total-a.total);

  contPagar.innerHTML = filasPagar.length ? `
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Proveedor</th><th class="num"># Facturas</th><th class="num">Total a pagar</th></tr></thead>
      <tbody>${filasPagar.map(f=>`<tr><td>${escapeHtml(f.nombre)}</td><td class="num">${f.facturas}</td><td class="num">${money(f.total)}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="total-row"><td>TOTAL</td><td class="num">${filasPagar.reduce((a,f)=>a+f.facturas,0)}</td><td class="num">${money(filasPagar.reduce((a,f)=>a+f.total,0))}</td></tr></tfoot>
    </table></div>` : '<div class="empty-state">No hay cuentas por pagar pendientes 🎉</div>';
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
  const limiteG = filtroFechaActivo('gastos') ? 200 : 20;
  const gastosOrdenados = DB.gastos.filter(g=>enRangoFecha(g.fecha,'gastos')).sort((a,b)=> new Date(b.fecha) - new Date(a.fecha)).slice(0,limiteG);
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
          ${esAdmin() ? `<button data-accion="eliminar-gasto" data-id="${g.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Eliminar</button>` : ''}
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

/* ================= EMPLEADOS (roles) ================= */
function abrirModalEmpleado(){
  document.getElementById('form-empleado').reset();
  document.getElementById('emp-error').hidden = true;
  openModal('empleado');
}

document.getElementById('form-empleado').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const errBox = document.getElementById('emp-error');
  errBox.hidden = true;
  const nombre = document.getElementById('emp-nombre').value.trim();
  const numeroIdentificacion = document.getElementById('emp-identificacion').value.trim();
  const direccion = document.getElementById('emp-direccion').value.trim();
  const telefono = document.getElementById('emp-telefono').value.trim();
  const clave = document.getElementById('emp-clave').value;
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
  if((DB.negocio.empleados||[]).some(emp=>emp.telefono===telefono)){
    errBox.textContent = 'Ya invitaste a un empleado con ese número de celular.';
    errBox.hidden = false;
    return;
  }
  const btn = document.getElementById('emp-submit-btn');
  btn.disabled = true;
  let usuarioCreado = null;
  try{
    const cred = await createUserWithEmailAndPassword(secondaryAuth, telefonoToEmail(telefono), clave);
    usuarioCreado = cred.user;
    await setDoc(doc(db, 'accesos', usuarioCreado.uid), {
      negocioId, rol: 'empleado', nombre, telefono, creado: new Date().toISOString()
    });
    await signOut(secondaryAuth);
    DB.negocio.empleados = DB.negocio.empleados || [];
    DB.negocio.empleados.push({ uid: usuarioCreado.uid, nombre, numeroIdentificacion, direccion, telefono, rol: 'empleado', creado: new Date().toISOString() });
    DB.negocio.empleadosUids = DB.negocio.empleados.map(e=>e.uid);
    registrarCambio('Empleados', 'Crear', `Invitó a "${nombre}" como empleado`);
    saveDB();
    closeModals();
    toast('Empleado agregado ✅');
    renderAll();
  }catch(err){
    // si la cuenta llegó a crearse pero el resto falló (p.ej. faltan permisos en Firestore),
    // se revierte para no dejar una cuenta de acceso huérfana.
    if(usuarioCreado){
      try{ await deleteUser(usuarioCreado); }catch(e2){ /* no se pudo revertir, quedará huérfana */ }
      try{ await signOut(secondaryAuth); }catch(e2){ /* ignorar */ }
    }
    if(err.code==='permission-denied'){
      errBox.textContent = 'Tu negocio necesita que se actualicen las reglas de seguridad de Firestore para poder agregar empleados. Pide ayuda técnica para activar esta función.';
    } else {
      errBox.textContent = authErrorMessage(err);
    }
    errBox.hidden = false;
  }
  btn.disabled = false;
});

async function eliminarEmpleado(uidEmpleado){
  const emp = (DB.negocio.empleados||[]).find(e=>e.uid===uidEmpleado);
  if(!emp) return;
  if(!confirm(`¿Quitar el acceso de "${emp.nombre}"? Ya no podrá iniciar sesión en este negocio.`)) return;
  try{ await deleteDoc(doc(db, 'accesos', uidEmpleado)); }catch(e){ /* sin conexión: igual se quita localmente */ }
  DB.negocio.empleados = DB.negocio.empleados.filter(e=>e.uid!==uidEmpleado);
  DB.negocio.empleadosUids = DB.negocio.empleados.map(e=>e.uid);
  registrarCambio('Empleados', 'Eliminar', `Quitó el acceso de "${emp.nombre}"`);
  saveDB();
  renderAll();
  toast('Acceso eliminado 🗑️');
}

function renderEmpleados(){
  const cont = document.getElementById('lista-empleados');
  if(!cont) return;
  const empleados = DB.negocio?.empleados || [];
  if(empleados.length===0){
    cont.innerHTML = '<div class="empty-state">Todavía no has agregado empleados</div>';
    return;
  }
  cont.innerHTML = empleados.map(emp=>`
    <div class="empleado-row">
      <div class="li-main">
        <span class="li-title">${escapeHtml(emp.nombre)}<span class="rol-tag">Empleado</span></span>
        <span class="li-sub">+57 ${escapeHtml(emp.telefono)}${emp.numeroIdentificacion ? ` · CC ${escapeHtml(emp.numeroIdentificacion)}` : ''}</span>
        ${emp.direccion ? `<span class="li-sub">${escapeHtml(emp.direccion)}</span>` : ''}
      </div>
      <button data-accion="eliminar-empleado" data-id="${emp.uid}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Quitar acceso</button>
    </div>`).join('');
}
document.getElementById('lista-empleados').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-accion="eliminar-empleado"]');
  if(btn) eliminarEmpleado(btn.dataset.id);
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
function yaExisteEnLista(lista, idActual, campo, valor){
  const v = (valor||'').trim();
  if(!v) return false;
  const vNorm = normalizarTexto(v);
  return lista.some(x => x.id !== idActual && normalizarTexto((x[campo]||'').trim()) === vNorm);
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
  document.getElementById('kpi-inventario-valor').textContent = `Valor en venta: ${money(DB.productos.reduce((a,p)=>a+p.cantidad*p.precioVenta,0))}`;

  const nombre = (DB.negocio?.propietario || '').trim();
  document.getElementById('saludo').textContent = `¡Hola${nombre ? ', '+nombre.split(' ')[0] : ''}! 👋`;

  // alertas de stock bajo
  const bajos = DB.productos.filter(p=>p.cantidad <= p.cantidadMinima);
  const box = document.getElementById('alertas-inicio');
  box.innerHTML = bajos.map(p=>`<div class="alert">⚠️ El producto <strong>${escapeHtml(p.nombre)}</strong> está próximo a agotarse (quedan ${p.cantidad}).</div>`).join('');
}

function renderProductos(){
  const cont = document.getElementById('lista-productos');
  document.getElementById('productos-contador').textContent = `📦 Tienes ${DB.productos.length} producto(s) registrado(s)`;
  if(DB.productos.length===0){
    cont.innerHTML = '<div class="empty-state">Aún no tienes productos. Agrega el primero 📦</div>';
    return;
  }
  const filtro = normalizarTexto(document.getElementById('buscar-producto').value.trim());
  const lista = filtro
    ? DB.productos.filter(p=>
        normalizarTexto(p.nombre||'').includes(filtro) ||
        normalizarTexto(p.sku||'').includes(filtro) ||
        normalizarTexto(p.codigoBarras||'').includes(filtro)
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
    const detalles = [p.categoria, p.unidadMedida, `IVA ${p.ivaPct ?? 0}%`, p.codigoBarras ? `Cód. barras: ${p.codigoBarras}` : null].filter(Boolean).join(' · ');
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
          ${esAdmin() ? `<button data-accion="eliminar-producto" data-id="${p.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Eliminar</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

/* ================= CÓDIGOS DE BARRAS (base de datos + etiquetas imprimibles) ================= */
function abrirCodigosBarras(){
  const productos = DB.productos.filter(p=>p.codigoBarras).slice().sort((a,b)=> a.nombre.localeCompare(b.nombre));

  const tablaHtml = productos.length ? `
    <div class="data-table-wrap no-print"><table class="data-table">
      <thead><tr><th>Producto</th><th>Código de barras</th></tr></thead>
      <tbody>${productos.map(p=>`<tr><td>${escapeHtml(p.nombre)}</td><td>${escapeHtml(p.codigoBarras)}</td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty-state no-print">Todavía no tienes productos con código de barras</div>';

  const etiquetasHtml = productos.length ? `
    <div class="etiquetas-grid">
      ${productos.map(p=>`<div class="etiqueta">
        <svg class="etiqueta-barra" data-codigo="${escapeHtml(p.codigoBarras)}"></svg>
        <div class="etiqueta-nombre">${escapeHtml(p.nombre)}</div>
      </div>`).join('')}
    </div>` : '';

  document.getElementById('detalle-titulo').textContent = '🏷️ Códigos de tus productos';
  document.getElementById('detalle-body').innerHTML = `
    <button type="button" class="btn btn-secondary btn-block no-print" onclick="window.print()">🖨️ Imprimir etiquetas / Guardar PDF</button>
    <h4 class="no-print" style="margin-top:14px;font-size:13px;color:var(--azul);">📋 Lista de códigos</h4>
    ${tablaHtml}
    ${etiquetasHtml}
  `;
  if(typeof JsBarcode !== 'undefined'){
    document.querySelectorAll('.etiqueta-barra').forEach(svg=>{
      try{
        JsBarcode(svg, svg.dataset.codigo, { format:'CODE128', displayValue:true, fontSize:12, height:38, margin:4 });
      }catch(e){ svg.outerHTML = `<div class="etiqueta-codigo">${escapeHtml(svg.dataset.codigo)}</div>`; }
    });
  } else {
    document.querySelectorAll('.etiqueta-barra').forEach(svg=>{
      svg.outerHTML = `<div class="etiqueta-codigo">${escapeHtml(svg.dataset.codigo)}</div>`;
    });
  }
  openModal('detalle');
}
document.getElementById('btn-codigos-barras').addEventListener('click', abrirCodigosBarras);

function totalAbonado(doc){
  return (doc.abonos||[]).reduce((a,ab)=>a+ab.valor,0);
}
function saldoFactura(doc){
  return Math.max(0, (doc.total||0) - totalAbonado(doc));
}
function saldoClientePendiente(clienteId){
  return DB.ventas
    .filter(v=>v.clienteId===clienteId && v.tipoVenta==='credito' && !v.pagada && !v.anulada)
    .reduce((a,v)=>a+saldoFactura(v),0);
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
        ${c.numeroIdentificacion ? `<span class="li-sub">${escapeHtml(c.tipoIdentificacion||'ID')}: ${escapeHtml(c.numeroIdentificacion)}</span>` : ''}
        ${(c.direccion||c.ciudad) ? `<span class="li-sub">${[c.direccion,c.ciudad].filter(Boolean).map(escapeHtml).join(', ')}</span>` : ''}
        ${c.correo && (c.celular||c.telefono) ? `<span class="li-sub">${escapeHtml(c.correo)}</span>` : ''}
        ${c.contacto ? `<span class="li-sub">Contacto: ${escapeHtml(c.contacto)}</span>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        ${saldo>0 ? `<span class="li-value neg">Debe ${money(saldo)}</span>` : `<span class="li-value">Al día</span>`}
        <div style="display:flex;gap:6px;">
          <button data-accion="editar-cliente" data-id="${c.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Editar</button>
          ${esAdmin() ? `<button data-accion="eliminar-cliente" data-id="${c.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Eliminar</button>` : ''}
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
        ${p.numeroIdentificacion ? `<span class="li-sub">${escapeHtml(p.tipoIdentificacion||'ID')}: ${escapeHtml(p.numeroIdentificacion)}</span>` : ''}
        ${(p.direccion||p.ciudad) ? `<span class="li-sub">${[p.direccion,p.ciudad].filter(Boolean).map(escapeHtml).join(', ')}</span>` : ''}
        ${p.correo && p.telefono ? `<span class="li-sub">${escapeHtml(p.correo)}</span>` : ''}
        ${p.contacto ? `<span class="li-sub">Contacto: ${escapeHtml(p.contacto)}</span>` : ''}
      </div>
      <div style="display:flex;gap:6px;">
        <button data-accion="editar-proveedor" data-id="${p.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Editar</button>
        ${esAdmin() ? `<button data-accion="eliminar-proveedor" data-id="${p.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Eliminar</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderValorInventario(){
  const contCat = document.getElementById('inv-valor-categorias');
  if(!contCat) return;
  const totalCosto = DB.productos.reduce((a,p)=>a+p.cantidad*p.precioCompra,0);
  const totalVenta = DB.productos.reduce((a,p)=>a+p.cantidad*p.precioVenta,0);
  document.getElementById('inv-valor-costo').textContent = money(totalCosto);
  document.getElementById('inv-valor-venta').textContent = money(totalVenta);

  if(DB.productos.length===0){
    contCat.innerHTML = '<div class="empty-state">Aún no tienes productos registrados</div>';
    document.getElementById('inv-valor-productos').innerHTML = '';
    return;
  }

  const porCategoria = {};
  DB.productos.forEach(p=>{
    const cat = p.categoria || 'Sin categoría';
    if(!porCategoria[cat]) porCategoria[cat] = { productos:0, unidades:0, costo:0, venta:0 };
    porCategoria[cat].productos++;
    porCategoria[cat].unidades += p.cantidad;
    porCategoria[cat].costo += p.cantidad*p.precioCompra;
    porCategoria[cat].venta += p.cantidad*p.precioVenta;
  });
  const filasCat = Object.entries(porCategoria).sort((a,b)=> b[1].venta-a[1].venta);
  contCat.innerHTML = `<div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Categoría</th><th class="num"># Productos</th><th class="num">Unidades</th><th class="num">Valor costo</th><th class="num">Valor venta</th></tr></thead>
      <tbody>${filasCat.map(([cat,d])=>`<tr><td>${escapeHtml(cat)}</td><td class="num">${d.productos}</td><td class="num">${d.unidades}</td><td class="num">${money(d.costo)}</td><td class="num">${money(d.venta)}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="total-row"><td>TOTAL</td><td class="num">${DB.productos.length}</td><td class="num">${DB.productos.reduce((a,p)=>a+p.cantidad,0)}</td><td class="num">${money(totalCosto)}</td><td class="num">${money(totalVenta)}</td></tr></tfoot>
    </table></div>`;

  const filasProd = DB.productos.slice().sort((a,b)=> (b.cantidad*b.precioVenta)-(a.cantidad*a.precioVenta));
  document.getElementById('inv-valor-productos').innerHTML = `<div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Producto</th><th>Categoría</th><th class="num">Cant.</th><th class="num">Costo unit.</th><th class="num">Valor costo</th><th class="num">Precio venta</th><th class="num">Valor venta</th></tr></thead>
      <tbody>${filasProd.map(p=>`<tr><td>${escapeHtml(p.nombre)}</td><td>${escapeHtml(p.categoria||'—')}</td><td class="num">${p.cantidad}</td><td class="num">${money(p.precioCompra)}</td><td class="num">${money(p.cantidad*p.precioCompra)}</td><td class="num">${money(p.precioVenta)}</td><td class="num">${money(p.cantidad*p.precioVenta)}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="total-row"><td colspan="4">TOTAL</td><td class="num">${money(totalCosto)}</td><td></td><td class="num">${money(totalVenta)}</td></tr></tfoot>
    </table></div>`;
}

function renderFinanzas(){
  renderValorInventario();
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
  renderHistorialMensual();
}

/* ================= HISTORIAL MENSUAL (gastos, ventas, compras, clientes y proveedores) ================= */
function mesKey(fechaISO){
  const d = new Date(fechaISO);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function mesLabel(key){
  const [y,m] = key.split('-');
  const d = new Date(Number(y), Number(m)-1, 1);
  const txt = d.toLocaleDateString('es-CO',{month:'long', year:'numeric'});
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}
function renderHistorialMensual(){
  const cont = document.getElementById('tabla-historial-mensual');
  if(!cont) return;
  const meses = {};
  const acumular = (fechaISO, campo, valor)=>{
    if(!fechaISO || !enRangoFecha(fechaISO,'historial')) return;
    const key = mesKey(fechaISO);
    if(!meses[key]) meses[key] = { ventas:0, gastos:0, compras:0, clientesNuevos:0, proveedoresNuevos:0 };
    meses[key][campo] += valor;
  };
  DB.ventas.filter(v=>!v.anulada).forEach(v=> acumular(v.fecha,'ventas', v.total));
  DB.gastos.forEach(g=> acumular(g.fecha,'gastos', g.valor));
  DB.compras.forEach(c=> acumular(c.fecha,'compras', c.total));
  DB.clientes.forEach(c=> acumular(c.creado,'clientesNuevos', 1));
  DB.proveedores.forEach(p=> acumular(p.creado,'proveedoresNuevos', 1));

  let keys = Object.keys(meses).sort().reverse();
  if(!filtroFechaActivo('historial')) keys = keys.slice(0,12);

  if(keys.length===0){
    cont.innerHTML = '<div class="empty-state">Todavía no hay datos suficientes para mostrar un historial mensual</div>';
    return;
  }
  cont.innerHTML = `<div class="data-table-wrap"><table class="data-table">
    <thead><tr><th>Mes</th><th class="num">Ventas</th><th class="num">Gastos</th><th class="num">Compras</th><th class="num">Clientes nuevos</th><th class="num">Proveedores nuevos</th></tr></thead>
    <tbody>${keys.map(k=>{
      const m = meses[k];
      return `<tr><td>${escapeHtml(mesLabel(k))}</td><td class="num">${money(m.ventas)}</td><td class="num">${money(m.gastos)}</td><td class="num">${money(m.compras)}</td><td class="num">${m.clientesNuevos}</td><td class="num">${m.proveedoresNuevos}</td></tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

/* ================= DASHBOARD FINANCIERO (dinámico) ================= */
function claveBucket(fechaISO, gran){
  if(gran==='semana') return startOfWeek(new Date(fechaISO)).toISOString().slice(0,10);
  if(gran==='mes') return mesKey(fechaISO);
  return new Date(fechaISO).toISOString().slice(0,10);
}
function etiquetaBucket(key, gran){
  if(gran==='semana'){
    const ini = new Date(key+'T00:00:00');
    const fin = new Date(ini); fin.setDate(fin.getDate()+6);
    return `${fmtDate(ini)} — ${fmtDate(fin)}`;
  }
  if(gran==='mes') return mesLabel(key);
  return fmtDate(key+'T00:00:00');
}
function etiquetaCortaBucket(key, gran){
  if(gran==='mes'){
    const d = new Date(key+'-01T00:00:00');
    return d.toLocaleDateString('es-CO',{month:'short'});
  }
  const d = new Date(key+'T00:00:00');
  return String(d.getDate());
}

function renderDashboard(){
  const contKpis = document.getElementById('dash-kpis');
  if(!contKpis) return;
  const gran = periods.dashboardGran || 'dia';

  let desde, hasta;
  const f = dateFilters['dashboard'];
  if(f && (f.desde || f.hasta)){
    desde = f.desde ? new Date(f.desde+'T00:00:00') : null;
    hasta = f.hasta ? new Date(f.hasta+'T23:59:59') : null;
  } else {
    hasta = new Date();
    desde = new Date(); desde.setDate(desde.getDate()-29); desde.setHours(0,0,0,0);
  }
  const enRango = (fechaISO)=>{
    const d = new Date(fechaISO);
    if(desde && d<desde) return false;
    if(hasta && d>hasta) return false;
    return true;
  };

  const ventas = DB.ventas.filter(v=>!v.anulada && enRango(v.fecha));
  const gastos = DB.gastos.filter(g=> enRango(g.fecha));
  const compras = DB.compras.filter(c=> enRango(c.fecha));

  const totalVentas = ventas.reduce((a,v)=>a+v.total,0);
  const totalGastos = gastos.reduce((a,g)=>a+g.valor,0);
  const totalCompras = compras.reduce((a,c)=>a+c.total,0);
  const ganancia = totalVentas - totalGastos;
  const ticketProm = ventas.length ? totalVentas/ventas.length : 0;

  contKpis.innerHTML = `
    <div class="card card-green"><span class="card-icon">💰</span><span class="card-label">Ventas</span><span class="card-value">${money(totalVentas)}</span></div>
    <div class="card card-yellow"><span class="card-icon">🧾</span><span class="card-label">Gastos</span><span class="card-value">${money(totalGastos)}</span></div>
    <div class="card card-blue"><span class="card-icon">📈</span><span class="card-label">Ganancia</span><span class="card-value">${money(ganancia)}</span></div>
    <div class="card card-dark"><span class="card-icon">🧾</span><span class="card-label">Compras</span><span class="card-value">${money(totalCompras)}</span></div>
    <div class="card card-green"><span class="card-icon">🧮</span><span class="card-label"># Facturas</span><span class="card-value">${ventas.length}</span></div>
    <div class="card card-blue"><span class="card-icon">🎟️</span><span class="card-label">Ticket promedio</span><span class="card-value">${money(ticketProm)}</span></div>
  `;

  const buckets = {};
  const registrarBucket = (fechaISO, campo, valor)=>{
    const key = claveBucket(fechaISO, gran);
    if(!buckets[key]) buckets[key] = { ventas:0, gastos:0, compras:0 };
    buckets[key][campo] += valor;
  };
  ventas.forEach(v=> registrarBucket(v.fecha,'ventas', v.total));
  gastos.forEach(g=> registrarBucket(g.fecha,'gastos', g.valor));
  compras.forEach(c=> registrarBucket(c.fecha,'compras', c.total));
  const keys = Object.keys(buckets).sort();

  const chart = document.getElementById('dash-chart');
  if(keys.length===0){
    chart.innerHTML = '<div class="empty-state">Sin movimientos en el rango seleccionado</div>';
  } else {
    const max = Math.max(...keys.map(k=>buckets[k].ventas), 1);
    chart.innerHTML = keys.map(k=>{
      const h = Math.max(4, Math.round((buckets[k].ventas/max)*100));
      return `<div class="bar-col"><div class="bar" style="height:${h}%" title="${money(buckets[k].ventas)}"></div><span>${escapeHtml(etiquetaCortaBucket(k,gran))}</span></div>`;
    }).join('');
  }

  const matriz = document.getElementById('dash-matriz');
  matriz.innerHTML = keys.length ? `<div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Periodo</th><th class="num">Ventas</th><th class="num">Gastos</th><th class="num">Compras</th><th class="num">Ganancia</th></tr></thead>
      <tbody>${keys.map(k=>{
        const b = buckets[k];
        return `<tr><td>${escapeHtml(etiquetaBucket(k,gran))}</td><td class="num">${money(b.ventas)}</td><td class="num">${money(b.gastos)}</td><td class="num">${money(b.compras)}</td><td class="num">${money(b.ventas-b.gastos)}</td></tr>`;
      }).join('')}</tbody>
      <tfoot><tr class="total-row"><td>TOTAL</td><td class="num">${money(totalVentas)}</td><td class="num">${money(totalGastos)}</td><td class="num">${money(totalCompras)}</td><td class="num">${money(ganancia)}</td></tr></tfoot>
    </table></div>` : '<div class="empty-state">Sin movimientos en el rango seleccionado</div>';

  const porProducto = {};
  const porCategoria = {};
  ventas.forEach(v=>{
    (v.items||[]).forEach(it=>{
      const nombre = it.descripcion || 'Venta libre';
      if(!porProducto[nombre]) porProducto[nombre] = { cantidad:0, total:0 };
      porProducto[nombre].cantidad += it.cantidad;
      porProducto[nombre].total += it.total;

      const producto = it.productoId ? DB.productos.find(p=>p.id===it.productoId) : null;
      const categoria = producto?.categoria || 'Sin categoría';
      if(!porCategoria[categoria]) porCategoria[categoria] = { cantidad:0, total:0 };
      porCategoria[categoria].cantidad += it.cantidad;
      porCategoria[categoria].total += it.total;
    });
  });
  const topProductos = Object.entries(porProducto).sort((a,b)=>b[1].total-a[1].total).slice(0,10);
  const topCategorias = Object.entries(porCategoria).sort((a,b)=>b[1].total-a[1].total);

  document.getElementById('dash-top-productos').innerHTML = topProductos.length ? `<div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Producto</th><th class="num">Cant.</th><th class="num">Total vendido</th></tr></thead>
      <tbody>${topProductos.map(([n,d])=>`<tr><td>${escapeHtml(n)}</td><td class="num">${d.cantidad}</td><td class="num">${money(d.total)}</td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty-state">Sin ventas en el rango seleccionado</div>';

  document.getElementById('dash-top-categorias').innerHTML = topCategorias.length ? `<div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Categoría</th><th class="num">Cant.</th><th class="num">Total vendido</th></tr></thead>
      <tbody>${topCategorias.map(([n,d])=>`<tr><td>${escapeHtml(n)}</td><td class="num">${d.cantidad}</td><td class="num">${money(d.total)}</td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty-state">Sin ventas en el rango seleccionado</div>';

  const q1 = {}, q2 = {};
  ventas.forEach(v=>{
    const dia = new Date(v.fecha).getDate();
    const destino = dia<=15 ? q1 : q2;
    (v.items||[]).forEach(it=>{
      const producto = it.productoId ? DB.productos.find(p=>p.id===it.productoId) : null;
      const categoria = producto?.categoria || 'Sin categoría';
      destino[categoria] = (destino[categoria]||0) + it.total;
    });
  });
  const topQ1 = Object.entries(q1).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const topQ2 = Object.entries(q2).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const listaQuincena = (lista)=> lista.length ? lista.map(([n,total])=>`
      <div class="list-item"><div class="li-main"><span class="li-title">${escapeHtml(n)}</span></div><span class="li-value">${money(total)}</span></div>
    `).join('') : '<div class="empty-state">Sin ventas en este periodo</div>';
  document.getElementById('dash-quincenas').innerHTML = `
    <div class="resumen-grid">
      <div><h4 style="font-size:13px;color:var(--azul);">Del 1 al 15</h4>${listaQuincena(topQ1)}</div>
      <div><h4 style="font-size:13px;color:var(--azul);">Del 16 al fin de mes</h4>${listaQuincena(topQ2)}</div>
    </div>
  `;
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
function saldoClientePendienteEnRango(clienteId, prefijo){
  return DB.ventas
    .filter(v=>v.clienteId===clienteId && v.tipoVenta==='credito' && !v.pagada && !v.anulada && enRangoFecha(v.fecha,prefijo))
    .reduce((a,v)=>a+saldoFactura(v),0);
}
function renderDeudores(){
  const cont = document.getElementById('lista-deudores');
  const deudores = DB.clientes
    .map(c=>({ cliente:c, saldo: saldoClientePendienteEnRango(c.id,'porcobrar') }))
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
  const limiteCob = filtroFechaActivo('cobros') ? 200 : 20;
  const pagadas = DB.ventas
    .filter(v=>v.tipoVenta==='credito' && v.pagada && !v.anulada && enRangoFecha(v.fechaPago||v.fecha,'cobros'))
    .sort((a,b)=> new Date(b.fechaPago||b.fecha) - new Date(a.fechaPago||a.fecha))
    .slice(0,limiteCob);
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
    const abonado = totalAbonado(v);
    const saldo = saldoFactura(v);
    const historialAbonos = (v.abonos||[]).length ? `
      <div style="margin:4px 0 8px;padding-left:8px;border-left:2px solid var(--borde);">
        ${v.abonos.map(ab=>`<div class="li-sub">💵 ${fmtDate(ab.fecha)} — ${money(ab.valor)}</div>`).join('')}
      </div>` : '';
    return `<div class="list-item" style="flex-direction:column;align-items:stretch;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
        <div class="li-main">
          <span class="li-title">Factura No. ${v.numeroFactura}</span>
          <span class="li-sub">${fmtDateTime(v.fecha)}${v.fechaVencimiento ? ` · Vence: ${fmtDate(v.fechaVencimiento)}` : ''}${vencida ? ' ⚠️ Vencida' : ''}</span>
          ${abonado>0 ? `<span class="li-sub">Total ${money(v.total)} · Abonado ${money(abonado)}</span>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
          <span class="li-value ${vencida?'neg':''}">${money(saldo)}</span>
          <div style="display:flex;gap:6px;">
            <button data-accion="abonar-venta" data-id="${v.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Abonar</button>
            <button data-accion="marcar-pagada" data-id="${v.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Marcar pagada</button>
          </div>
        </div>
      </div>
      ${historialAbonos}
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

/* ================= ABONOS (pagos parciales a cuentas por cobrar/pagar) ================= */
function abrirModalAbono(tipo, docId){
  const doc = tipo==='venta' ? DB.ventas.find(v=>v.id===docId) : DB.compras.find(c=>c.id===docId);
  if(!doc) return;
  document.getElementById('ab-tipo').value = tipo;
  document.getElementById('ab-doc-id').value = docId;
  const saldo = saldoFactura(doc);
  const entidad = tipo==='venta'
    ? (()=>{ const c = DB.clientes.find(x=>x.id===doc.clienteId); return c ? (c.nombres||c.nombre) : 'Consumidor final'; })()
    : (()=>{ const p = DB.proveedores.find(x=>x.id===doc.proveedorId); return p ? p.nombre : 'Proveedor eliminado'; })();
  const numero = tipo==='venta' ? `Factura No. ${doc.numeroFactura}` : (doc.numeroFacturaProveedor ? `Factura ${doc.numeroFacturaProveedor}` : 'Compra sin número de factura');
  document.getElementById('ab-info').innerHTML = `${escapeHtml(entidad)} · ${escapeHtml(numero)}<br>Total: ${money(doc.total)} · Abonado: ${money(totalAbonado(doc))}<br><strong>Saldo pendiente: ${money(saldo)}</strong>`;
  document.getElementById('ab-fecha').value = new Date().toISOString().slice(0,10);
  document.getElementById('ab-valor').value = '';
  document.getElementById('ab-valor').max = saldo;
  openModal('abono');
}

document.getElementById('form-abono').addEventListener('submit', (e)=>{
  e.preventDefault();
  const tipo = document.getElementById('ab-tipo').value;
  const docId = document.getElementById('ab-doc-id').value;
  const doc = tipo==='venta' ? DB.ventas.find(v=>v.id===docId) : DB.compras.find(c=>c.id===docId);
  if(!doc) return;
  const valor = Number(document.getElementById('ab-valor').value)||0;
  const fechaInput = document.getElementById('ab-fecha').value;
  if(valor<=0){ toast('El valor del abono debe ser mayor a 0 ⚠️'); return; }
  const saldo = saldoFactura(doc);
  if(valor > saldo + 1){ toast(`El abono no puede ser mayor al saldo pendiente (${money(saldo)}) ⚠️`); return; }
  const fechaISO = fechaInput ? new Date(fechaInput+'T12:00:00').toISOString() : new Date().toISOString();
  doc.abonos = doc.abonos || [];
  doc.abonos.push({ id: uid(), fecha: fechaISO, valor });

  let mensaje = 'Abono registrado ✅';
  if(saldoFactura(doc) <= 0){
    doc.pagada = true;
    doc.fechaPago = fechaISO;
    mensaje = 'Abono registrado — factura saldada ✅';
  }
  const entidad = tipo==='venta'
    ? (()=>{ const c = DB.clientes.find(x=>x.id===doc.clienteId); return c ? (c.nombres||c.nombre) : 'Consumidor final'; })()
    : (()=>{ const p = DB.proveedores.find(x=>x.id===doc.proveedorId); return p ? p.nombre : 'Proveedor eliminado'; })();
  registrarCambio(tipo==='venta' ? 'Venta' : 'Compra', 'Abono', `Registró un abono de ${money(valor)} a ${entidad}`);
  saveDB();
  closeModals();
  toast(mensaje);
  renderAll();
});

document.getElementById('lista-deudores').addEventListener('click', (e)=>{
  const el = e.target.closest('[data-accion="ver-deuda"]');
  if(el) verDeudaCliente(el.dataset.id);
});

document.getElementById('detalle-body').addEventListener('click', (e)=>{
  const btnPagar = e.target.closest('[data-accion="marcar-pagada"]');
  if(btnPagar) marcarVentaPagada(btnPagar.dataset.id);
  const btnAbonar = e.target.closest('[data-accion="abonar-venta"]');
  if(btnAbonar) abrirModalAbono('venta', btnAbonar.dataset.id);
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

/* ================= INFORME MENSUAL DETALLADO (no consolidado) ================= */
function abrirInformeMensual(){
  const desdeInput = document.getElementById('informe-desde').value;
  const hastaInput = document.getElementById('informe-hasta').value;
  let desde, hasta, etiquetaPeriodo;
  if(desdeInput || hastaInput){
    desde = desdeInput ? new Date(desdeInput+'T00:00:00') : null;
    hasta = hastaInput ? new Date(hastaInput+'T23:59:59') : null;
    etiquetaPeriodo = `Del ${desdeInput ? fmtDate(desde) : '…'} al ${hastaInput ? fmtDate(hasta) : '…'}`;
  } else {
    const hoy = new Date();
    desde = startOfMonth(hoy);
    hasta = new Date(); hasta.setHours(23,59,59,999);
    etiquetaPeriodo = mesLabel(mesKey(hoy));
  }
  const enRango = (fechaISO)=>{
    const d = new Date(fechaISO);
    if(desde && d<desde) return false;
    if(hasta && d>hasta) return false;
    return true;
  };

  const ventas = DB.ventas.filter(v=>!v.anulada && enRango(v.fecha)).sort((a,b)=> new Date(a.fecha)-new Date(b.fecha));
  const gastos = DB.gastos.filter(g=> enRango(g.fecha)).sort((a,b)=> new Date(a.fecha)-new Date(b.fecha));
  const cobros = DB.ventas.filter(v=>v.tipoVenta==='credito' && v.pagada && !v.anulada && enRango(v.fechaPago||v.fecha)).sort((a,b)=> new Date(a.fechaPago||a.fecha)-new Date(b.fechaPago||b.fecha));
  const pagosProv = DB.compras.filter(c=>c.tipoCompra==='credito' && c.pagada && enRango(c.fechaPago||c.fecha)).sort((a,b)=> new Date(a.fechaPago||a.fecha)-new Date(b.fechaPago||b.fecha));

  const totalVentas = ventas.reduce((a,v)=>a+v.total,0);
  const totalGastos = gastos.reduce((a,g)=>a+g.valor,0);
  const totalCobros = cobros.reduce((a,v)=>a+v.total,0);
  const totalPagosProv = pagosProv.reduce((a,c)=>a+c.total,0);

  const filaVenta = (v)=>{
    const cliente = DB.clientes.find(c=>c.id===v.clienteId);
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">Factura No. ${v.numeroFactura}${v.tipoVenta==='credito' ? (v.pagada ? ' · Crédito (pagada)' : ' · Crédito (pendiente)') : ' · Contado'}</span>
        <span class="li-sub">${fmtDateTime(v.fecha)} · ${escapeHtml(cliente ? (cliente.nombres||cliente.nombre) : 'Consumidor final')}</span>
      </div>
      <span class="li-value">${money(v.total)}</span>
    </div>`;
  };
  const filaGasto = (g)=>`<div class="list-item">
      <div class="li-main">
        <span class="li-title">${escapeHtml(g.nombre)}</span>
        <span class="li-sub">${fmtDateTime(g.fecha)} · ${escapeHtml(g.categoria||'')}</span>
      </div>
      <span class="li-value neg">${money(g.valor)}</span>
    </div>`;
  const filaCobro = (v)=>{
    const cliente = DB.clientes.find(c=>c.id===v.clienteId);
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">Cobro · Factura No. ${v.numeroFactura}</span>
        <span class="li-sub">${fmtDateTime(v.fechaPago||v.fecha)} · ${escapeHtml(cliente ? (cliente.nombres||cliente.nombre) : '(sin nombre)')}</span>
      </div>
      <span class="li-value">${money(v.total)}</span>
    </div>`;
  };
  const filaPago = (c)=>{
    const proveedor = DB.proveedores.find(p=>p.id===c.proveedorId);
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">Pago a proveedor${c.numeroFacturaProveedor ? ' · '+escapeHtml(c.numeroFacturaProveedor) : ''}</span>
        <span class="li-sub">${fmtDateTime(c.fechaPago||c.fecha)} · ${escapeHtml(proveedor ? proveedor.nombre : '(proveedor eliminado)')}</span>
      </div>
      <span class="li-value neg">${money(c.total)}</span>
    </div>`;
  };

  const html = `
    <button type="button" class="btn btn-secondary btn-block no-print" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
    <p style="font-size:12px;color:var(--gris-texto);">${escapeHtml(etiquetaPeriodo)}</p>
    <div class="informe-resumen">
      <div class="card card-green"><span class="card-label">Ventas</span><span class="card-value">${money(totalVentas)}</span></div>
      <div class="card card-yellow"><span class="card-label">Gastos</span><span class="card-value">${money(totalGastos)}</span></div>
      <div class="card card-blue"><span class="card-label">Cobros</span><span class="card-value">${money(totalCobros)}</span></div>
      <div class="card card-dark"><span class="card-label">Pagos a prov.</span><span class="card-value">${money(totalPagosProv)}</span></div>
    </div>

    <div class="informe-bloque">
      <h4>💰 Resumen de ventas (${ventas.length})</h4>
      ${ventas.length ? ventas.map(filaVenta).join('') : '<div class="empty-state">Sin ventas en el rango</div>'}
      <div class="informe-subtotal"><span>Subtotal ventas</span><span>${money(totalVentas)}</span></div>
    </div>

    <div class="informe-bloque">
      <h4>💵 Resumen de pagos — cobros a clientes y pagos a proveedores (${cobros.length + pagosProv.length})</h4>
      ${(cobros.length+pagosProv.length) ? [...cobros.map(filaCobro), ...pagosProv.map(filaPago)].join('') : '<div class="empty-state">Sin pagos en el rango</div>'}
      <div class="informe-subtotal"><span>Subtotal cobros a clientes</span><span>${money(totalCobros)}</span></div>
      <div class="informe-subtotal"><span>Subtotal pagos a proveedores</span><span>${money(totalPagosProv)}</span></div>
    </div>

    <div class="informe-bloque">
      <h4>🧾 Resumen de gastos (${gastos.length})</h4>
      ${gastos.length ? gastos.map(filaGasto).join('') : '<div class="empty-state">Sin gastos en el rango</div>'}
      <div class="informe-subtotal"><span>Subtotal gastos</span><span>${money(totalGastos)}</span></div>
    </div>
  `;
  document.getElementById('detalle-titulo').textContent = '📄 Informe mensual detallado';
  document.getElementById('detalle-body').innerHTML = html;
  openModal('detalle');
}
document.getElementById('btn-ver-informe').addEventListener('click', abrirInformeMensual);

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
  const limite = filtroFechaActivo('facturas') ? 200 : 20;
  const ventasOrdenadas = DB.ventas.filter(v=>enRangoFecha(v.fecha,'facturas')).sort((a,b)=> new Date(b.fecha) - new Date(a.fecha)).slice(0,limite);
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
          ${(!v.anulada && esAdmin()) ? `<button data-accion="anular-factura" data-id="${v.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Anular</button>` : ''}
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

/* ================= INVENTARIO: LISTA COMPLETA ================= */
function renderInventarioLista(){
  const cont = document.getElementById('tabla-inventario');
  if(!cont) return;
  if(DB.productos.length===0){
    cont.innerHTML = '<div class="empty-state">Aún no tienes productos registrados</div>';
    return;
  }
  const filtro = normalizarTexto(document.getElementById('buscar-inventario').value.trim());
  const lista = filtro
    ? DB.productos.filter(p=>
        normalizarTexto(p.nombre||'').includes(filtro) ||
        normalizarTexto(p.sku||'').includes(filtro) ||
        normalizarTexto(p.categoria||'').includes(filtro)
      )
    : DB.productos;
  if(lista.length===0){
    cont.innerHTML = '<div class="empty-state">No se encontraron productos con esa búsqueda 🔍</div>';
    return;
  }
  const totalUnidades = lista.reduce((a,p)=>a+p.cantidad,0);
  cont.innerHTML = `<div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Producto</th><th>SKU</th><th>Categoría</th><th class="num">Disponible</th><th class="num">Precio venta</th><th class="num">IVA</th><th>Proveedor</th><th>Estado</th></tr></thead>
      <tbody>${lista.map(p=>{
        const proveedor = DB.proveedores.find(pr=>pr.id===p.proveedorId);
        const bajo = p.cantidad <= p.cantidadMinima;
        return `<tr>
          <td>${escapeHtml(p.nombre)}</td>
          <td>${escapeHtml(p.sku||'—')}</td>
          <td>${escapeHtml(p.categoria||'—')}</td>
          <td class="num${bajo?' neg':''}">${p.cantidad}</td>
          <td class="num">${money(p.precioVenta)}</td>
          <td class="num">${p.ivaPct ?? 0}%</td>
          <td>${proveedor ? escapeHtml(proveedor.nombre) : '—'}</td>
          <td>${escapeHtml(p.estado||'Activo')}</td>
        </tr>`;
      }).join('')}</tbody>
      <tfoot><tr class="total-row"><td>TOTAL: ${lista.length} producto(s)</td><td></td><td></td><td class="num">${totalUnidades}</td><td></td><td></td><td></td><td></td></tr></tfoot>
    </table></div>`;
}
document.getElementById('buscar-inventario').addEventListener('input', renderInventarioLista);

/* ================= KARDEX ================= */
function todosLosMovimientosInventario(){
  const movimientos = [];
  DB.compras.forEach(c=>{
    (c.items||[]).forEach(it=>{
      if(it.productoId) movimientos.push({fecha:c.fecha, productoId:it.productoId, tipo:'Entrada', documento:`Compra${c.numeroFacturaProveedor?' '+c.numeroFacturaProveedor:''}`, cantidad: it.cantidad});
    });
  });
  DB.ventas.forEach(v=>{
    if(v.anulada) return;
    (v.items||[]).forEach(it=>{
      if(it.productoId) movimientos.push({fecha:v.fecha, productoId:it.productoId, tipo:'Salida', documento:`Factura #${v.numeroFactura}`, cantidad: -it.cantidad});
    });
  });
  DB.ajustesInventario.forEach(a=>{
    movimientos.push({fecha:a.fecha, productoId:a.productoId, tipo:'Ajuste', documento:a.motivo||'Ajuste', cantidad: a.tipo==='entrada' ? a.cantidad : -a.cantidad});
  });
  return movimientos;
}

function poblarSelectKardex(){
  const sel = document.getElementById('kardex-producto');
  const actual = sel.value;
  sel.innerHTML = DB.productos.map(p=>`<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join('');
  if(actual && DB.productos.some(p=>p.id===actual)) sel.value = actual;
}

function renderMovimientosInventario(){
  const cont = document.getElementById('tabla-movimientos');
  if(!cont) return;
  const filtro = normalizarTexto(document.getElementById('kardex-buscar-producto').value.trim());
  const movimientos = todosLosMovimientosInventario()
    .filter(m=> enRangoFecha(m.fecha,'kardex'))
    .map(m=>({ ...m, producto: DB.productos.find(p=>p.id===m.productoId) }))
    .filter(m=> !filtro || normalizarTexto(m.producto?.nombre||'').includes(filtro))
    .sort((a,b)=> new Date(b.fecha) - new Date(a.fecha));

  if(movimientos.length===0){
    cont.innerHTML = '<div class="empty-state">Sin movimientos en el rango seleccionado</div>';
    return;
  }
  cont.innerHTML = `<div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Fecha</th><th>Producto</th><th>Documento</th><th class="num">Entrada</th><th class="num">Salida</th></tr></thead>
      <tbody>${movimientos.map(m=>`<tr>
        <td>${fmtDateTime(m.fecha)}</td>
        <td>${escapeHtml(m.producto?.nombre || '(producto eliminado)')}</td>
        <td>${escapeHtml(m.documento)}</td>
        <td class="num">${m.cantidad>0 ? m.cantidad : '—'}</td>
        <td class="num${m.cantidad<0?' neg':''}">${m.cantidad<0 ? Math.abs(m.cantidad) : '—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}
document.getElementById('kardex-buscar-producto').addEventListener('input', renderMovimientosInventario);

function renderKardex(){
  const sel = document.getElementById('kardex-producto');
  renderMovimientosInventario();
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

  const movimientos = todosLosMovimientosInventario()
    .filter(m=>m.productoId===productoId)
    .sort((a,b)=> new Date(a.fecha) - new Date(b.fecha));

  const cont = document.getElementById('kardex-lista');
  if(movimientos.length===0){
    cont.innerHTML = '<div class="empty-state">Sin movimientos registrados todavía para este producto</div>';
    return;
  }
  let saldo = 0;
  const filas = [];
  movimientos.forEach(m=>{
    saldo += m.cantidad;
    if(!enRangoFecha(m.fecha,'kardex')) return;
    const signo = m.cantidad>=0 ? '+' : '';
    filas.push(`<div class="list-item">
      <div class="li-main">
        <span class="li-title">${m.tipo} — ${escapeHtml(m.documento)}</span>
        <span class="li-sub">${fmtDateTime(m.fecha)}</span>
      </div>
      <span class="li-value ${m.cantidad<0?'neg':''}">${signo}${m.cantidad} · Saldo: ${saldo}</span>
    </div>`);
  });
  cont.innerHTML = filas.length ? filas.join('') : '<div class="empty-state">Sin movimientos en el rango de fechas seleccionado</div>';
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
  const rolTxt = rolActual==='empleado' ? ' · Rol: Empleado' : ' · Rol: Administrador';
  document.getElementById('pf-correo-actual').textContent = currentUser?.email ? `Sesión iniciada con el celular ${emailToTelefono(currentUser.email)}${rolTxt}` : '';
  renderEmpleados();
}

/* ================= CAMBIOS EN EL SISTEMA ================= */
function renderCambios(){
  const cont = document.getElementById('lista-cambios');
  if(!DB.cambios || DB.cambios.length===0){
    cont.innerHTML = '<div class="empty-state">Todavía no hay cambios registrados</div>';
    return;
  }
  const filtrados = DB.cambios.filter(c=>enRangoFecha(c.fecha,'cambios'));
  if(filtrados.length===0){
    cont.innerHTML = '<div class="empty-state">Sin cambios en el rango de fechas seleccionado</div>';
    return;
  }
  cont.innerHTML = filtrados.map(c=>`<div class="list-item">
      <div class="li-main">
        <span class="li-title">${escapeHtml(c.modulo)} · ${escapeHtml(c.accion)}</span>
        <span class="li-sub">${escapeHtml(c.descripcion)}</span>
      </div>
      <span class="li-sub">${fmtDateTime(c.fecha)}</span>
    </div>`).join('');
}
document.getElementById('btn-ver-cambios').addEventListener('click', ()=> switchView('cambios'));
document.getElementById('btn-volver-perfil').addEventListener('click', ()=> switchView('perfil'));
document.getElementById('btn-ver-dashboard').addEventListener('click', ()=> switchView('dashboard'));
document.getElementById('btn-volver-finanzas').addEventListener('click', ()=> switchView('finanzas'));

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
  renderInventarioLista();
  renderKardex();
  renderFinanzas();
  renderFacturas();
  renderCuentas();
  renderPerfil();
  renderCambios();
  renderDashboard();
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

    // ¿Esta cuenta es una invitación de empleado? Si existe accesos/{uid}, trabaja
    // sobre el negocio del administrador que lo invitó en lugar de crear uno propio.
    let acceso = null;
    try{
      const accesoSnap = await getDoc(doc(db, 'accesos', user.uid));
      if(accesoSnap.exists()) acceso = accesoSnap.data();
    }catch(e){ /* sin acceso a la colección o sin conexión: se asume cuenta propia */ }

    negocioId = acceso ? acceso.negocioId : user.uid;
    rolActual = acceso ? (acceso.rol || 'empleado') : 'admin';
    document.body.classList.toggle('rol-empleado', rolActual==='empleado');

    DB = await loadUserDB(negocioId);
    if(DB.negocio){
      showView('app');
      switchView(currentView);
    } else if(acceso){
      // el negocio del administrador todavía no tiene onboarding hecho (caso raro)
      toast('Esta cuenta de empleado aún no tiene un negocio configurado ⚠️');
      await signOut(auth);
    } else {
      showView('view-onboarding');
    }
  } else {
    currentUser = null;
    DB = null;
    negocioId = null;
    rolActual = 'admin';
    document.body.classList.remove('rol-empleado');
    showView('view-login');
  }
});
