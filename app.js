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
  return { negocio: null, productos: [], clientes: [], proveedores: [], ventas: [], gastos: [], metas: [] };
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

document.querySelectorAll('#negocio-tabs .tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    document.querySelectorAll('#negocio-tabs .tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p=>p.hidden = (p.id !== 'tab-'+tab.dataset.tab));
  });
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

document.querySelectorAll('[data-open]').forEach(el=>{
  el.addEventListener('click', ()=>{
    const tipo = el.dataset.open;
    if(tipo==='cliente') return abrirModalCliente(null);
    if(tipo==='proveedor') return abrirModalProveedor(null);
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
document.getElementById('form-producto').addEventListener('submit', (e)=>{
  e.preventDefault();
  DB.productos.push({
    id: uid(),
    nombre: document.getElementById('p-nombre').value.trim(),
    cantidad: Number(document.getElementById('p-cantidad').value)||0,
    precioCompra: Number(document.getElementById('p-compra').value)||0,
    precioVenta: Number(document.getElementById('p-venta').value)||0,
    cantidadMinima: Number(document.getElementById('p-minima').value)||0
  });
  saveDB();
  e.target.reset();
  document.getElementById('p-minima').value = 2;
  closeModals();
  toast('Producto guardado ✅');
  renderAll();
});

function eliminarProducto(id){
  if(!confirm('¿Eliminar este producto?')) return;
  DB.productos = DB.productos.filter(p=>p.id!==id);
  saveDB(); renderAll();
}

document.getElementById('lista-productos').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-accion]');
  if(!btn) return;
  if(btn.dataset.accion==='eliminar-producto') eliminarProducto(btn.dataset.id);
});

/* ================= CLIENTES ================= */
function abrirModalCliente(cliente){
  document.getElementById('c-id').value = cliente?.id || '';
  document.getElementById('c-nombre').value = cliente?.nombre || '';
  document.getElementById('c-telefono').value = cliente?.telefono || '';
  document.getElementById('c-correo').value = cliente?.correo || '';
  document.getElementById('c-saldo').value = cliente?.saldoPendiente || 0;
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
  DB.clientes = DB.clientes.filter(c=>c.id!==id);
  saveDB(); renderAll();
}

document.getElementById('form-cliente').addEventListener('submit', (e)=>{
  e.preventDefault();
  const id = document.getElementById('c-id').value;
  const datos = {
    nombre: document.getElementById('c-nombre').value.trim(),
    telefono: document.getElementById('c-telefono').value.trim(),
    correo: document.getElementById('c-correo').value.trim(),
    saldoPendiente: Number(document.getElementById('c-saldo').value)||0
  };
  if(id){
    const cliente = DB.clientes.find(c=>c.id===id);
    if(cliente) Object.assign(cliente, datos);
  } else {
    DB.clientes.push({ id: uid(), ...datos });
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

/* ================= PROVEEDORES ================= */
function abrirModalProveedor(proveedor){
  document.getElementById('pr-id').value = proveedor?.id || '';
  document.getElementById('pr-nombre').value = proveedor?.nombre || '';
  document.getElementById('pr-provee').value = proveedor?.provee || '';
  document.getElementById('pr-telefono').value = proveedor?.telefono || '';
  document.getElementById('pr-correo').value = proveedor?.correo || '';
  document.getElementById('pr-saldo').value = proveedor?.saldoPendiente || 0;
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
  DB.proveedores = DB.proveedores.filter(p=>p.id!==id);
  saveDB(); renderAll();
}

document.getElementById('form-proveedor').addEventListener('submit', (e)=>{
  e.preventDefault();
  const id = document.getElementById('pr-id').value;
  const datos = {
    nombre: document.getElementById('pr-nombre').value.trim(),
    provee: document.getElementById('pr-provee').value.trim(),
    telefono: document.getElementById('pr-telefono').value.trim(),
    correo: document.getElementById('pr-correo').value.trim(),
    saldoPendiente: Number(document.getElementById('pr-saldo').value)||0
  };
  if(id){
    const proveedor = DB.proveedores.find(p=>p.id===id);
    if(proveedor) Object.assign(proveedor, datos);
  } else {
    DB.proveedores.push({ id: uid(), ...datos });
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

/* ================= VENTAS ================= */
function prepararModalVenta(){
  const selP = document.getElementById('v-producto');
  selP.innerHTML = '<option value="">— Sin producto (servicio libre) —</option>' +
    DB.productos.map(p=>`<option value="${p.id}">${escapeHtml(p.nombre)} (disp: ${p.cantidad})</option>`).join('');
  const selC = document.getElementById('v-cliente');
  selC.innerHTML = '<option value="">— Sin cliente —</option>' +
    DB.clientes.map(c=>`<option value="${c.id}">${escapeHtml(c.nombre)}</option>`).join('');
  document.getElementById('form-venta').reset();
  document.getElementById('v-cantidad').value = 1;
  actualizarTotalVenta();
}
function actualizarTotalVenta(){
  const cant = Number(document.getElementById('v-cantidad').value)||0;
  const precio = Number(document.getElementById('v-precio').value)||0;
  document.getElementById('v-total').textContent = money(cant*precio);
}
document.getElementById('v-cantidad').addEventListener('input', actualizarTotalVenta);
document.getElementById('v-precio').addEventListener('input', actualizarTotalVenta);
document.getElementById('v-producto').addEventListener('change', (e)=>{
  const prod = DB.productos.find(p=>p.id===e.target.value);
  if(prod){
    document.getElementById('v-precio').value = prod.precioVenta;
    document.getElementById('v-descripcion').value = prod.nombre;
    actualizarTotalVenta();
  }
});

document.getElementById('form-venta').addEventListener('submit', (e)=>{
  e.preventDefault();
  const productoId = document.getElementById('v-producto').value;
  const producto = DB.productos.find(p=>p.id===productoId);
  const cantidad = Number(document.getElementById('v-cantidad').value)||1;
  const precio = Number(document.getElementById('v-precio').value)||0;
  const descripcion = document.getElementById('v-descripcion').value.trim() || (producto?producto.nombre:'Venta');

  if(producto){
    if(producto.cantidad < cantidad){
      if(!confirm(`Solo tienes ${producto.cantidad} de "${producto.nombre}" en inventario. ¿Registrar la venta de todos modos?`)) return;
    }
    producto.cantidad = Math.max(0, producto.cantidad - cantidad);
  }

  DB.ventas.push({
    id: uid(),
    productoId: productoId || null,
    descripcion,
    cantidad,
    precio,
    total: cantidad*precio,
    fecha: new Date().toISOString(),
    clienteId: document.getElementById('v-cliente').value || null,
    metodoPago: document.getElementById('v-pago').value
  });
  saveDB();
  closeModals();
  toast('Venta registrada 💰');
  renderAll();
});

/* ================= GASTOS ================= */
document.getElementById('form-gasto').addEventListener('submit', (e)=>{
  e.preventDefault();
  DB.gastos.push({
    id: uid(),
    nombre: document.getElementById('g-nombre').value.trim(),
    categoria: document.getElementById('g-categoria').value,
    valor: Number(document.getElementById('g-valor').value)||0,
    descripcion: document.getElementById('g-descripcion').value.trim(),
    fecha: new Date().toISOString()
  });
  saveDB();
  e.target.reset();
  closeModals();
  toast('Gasto registrado 🧾');
  renderAll();
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

function ventasDelPeriodo(period){
  return DB.ventas.filter(v=>inPeriod(v.fecha, period));
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
  cont.innerHTML = DB.productos.map(p=>{
    const bajo = p.cantidad <= p.cantidadMinima;
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${escapeHtml(p.nombre)}</span>
        <span class="li-sub ${bajo?'stock-low':''}">Disponible: ${p.cantidad}${bajo?' ⚠️ ¡próximo a agotarse!':''}</span>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        <span class="li-value">${money(p.precioVenta)}</span>
        <button data-accion="eliminar-producto" data-id="${p.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Eliminar</button>
      </div>
    </div>`;
  }).join('');
}

function renderClientes(){
  const cont = document.getElementById('lista-clientes');
  if(DB.clientes.length===0){
    cont.innerHTML = '<div class="empty-state">Aún no tienes clientes registrados 👥</div>';
    return;
  }
  cont.innerHTML = DB.clientes.map(c=>{
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${escapeHtml(c.nombre)}</span>
        <span class="li-sub">${escapeHtml(c.telefono||c.correo||'Sin datos de contacto')}</span>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        ${c.saldoPendiente>0 ? `<span class="li-value neg">Debe ${money(c.saldoPendiente)}</span>` : `<span class="li-value">Al día</span>`}
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
  cont.innerHTML = DB.proveedores.map(p=>{
    return `<div class="list-item">
      <div class="li-main">
        <span class="li-title">${escapeHtml(p.nombre)}</span>
        <span class="li-sub">${escapeHtml(p.provee || p.telefono || p.correo || 'Sin datos')}</span>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        ${p.saldoPendiente>0 ? `<span class="li-value neg">Le debes ${money(p.saldoPendiente)}</span>` : `<span class="li-value">Al día</span>`}
        <div style="display:flex;gap:6px;">
          <button data-accion="editar-proveedor" data-id="${p.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Editar</button>
          <button data-accion="eliminar-proveedor" data-id="${p.id}" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Eliminar</button>
        </div>
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
    return DB.ventas.filter(v=>{ const f=new Date(v.fecha); return f>=d && f<next; })
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
    const key = v.descripcion || 'Venta';
    agrupado[key] = (agrupado[key]||0) + v.cantidad;
  });
  const top = Object.entries(agrupado).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const topCont = document.getElementById('top-productos');
  topCont.innerHTML = top.length ? top.map(([nombre,cant])=>`
    <div class="list-item">
      <div class="li-main"><span class="li-title">${escapeHtml(nombre)}</span></div>
      <span class="li-value">${cant} vendidos</span>
    </div>`).join('') : '<div class="empty-state">Todavía no hay ventas este mes</div>';

  renderMetas();
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

function renderPerfil(){
  if(!DB.negocio) return;
  document.getElementById('pf-propietario').value = DB.negocio.propietario||'';
  document.getElementById('pf-nombre').value = DB.negocio.nombre||'';
  document.getElementById('pf-tipo').value = DB.negocio.tipo||'';
  document.getElementById('pf-ciudad').value = DB.negocio.ciudad||'';
  document.getElementById('pf-moneda').value = DB.negocio.moneda||'COP';
  document.getElementById('pf-correo-actual').textContent = currentUser?.email ? `Sesión iniciada con el celular ${emailToTelefono(currentUser.email)}` : '';
}

function renderTopbar(){
  document.getElementById('tb-negocio').textContent = DB.negocio?.nombre || 'Mi negocio';
  document.getElementById('tb-fecha').textContent = new Date().toLocaleDateString('es-CO', {weekday:'long', day:'numeric', month:'long'});
}

function renderAll(){
  if(!DB.negocio) return;
  renderTopbar();
  renderInicio();
  renderProductos();
  renderClientes();
  renderProveedores();
  renderFinanzas();
  renderPerfil();
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
}

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
