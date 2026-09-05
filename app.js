/* =======================================================
   MI NEGOCIO FÁCIL - lógica de la aplicación
   Datos guardados en localStorage (un solo negocio, un solo dispositivo).
   ======================================================= */

const STORAGE_KEY = 'mnf_data_v1';

const CURRENCY_SYMBOLS = {
  COP: '$', USD: 'US$', MXN: 'MX$', PEN: 'S/', CLP: 'CLP$', ARS: 'AR$', EUR: '€'
};

let DB = null;

/* ---------- Persistencia ---------- */
function loadDB(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if(raw){
    try{ return JSON.parse(raw); }catch(e){ /* ignore corrupt data */ }
  }
  return {
    negocio: null,
    productos: [],
    clientes: [],
    ventas: [],
    gastos: [],
    metas: []
  };
}
function saveDB(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(DB));
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
  el.addEventListener('click', ()=> openModal(el.dataset.open));
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
  boot();
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
  DB.productos = DB.productos.filter(p=>p.id!==id);
  saveDB(); renderAll();
}

/* ================= CLIENTES ================= */
document.getElementById('form-cliente').addEventListener('submit', (e)=>{
  e.preventDefault();
  DB.clientes.push({
    id: uid(),
    nombre: document.getElementById('c-nombre').value.trim(),
    telefono: document.getElementById('c-telefono').value.trim(),
    correo: document.getElementById('c-correo').value.trim(),
    saldoPendiente: Number(document.getElementById('c-saldo').value)||0
  });
  saveDB();
  e.target.reset();
  closeModals();
  toast('Cliente guardado ✅');
  renderAll();
});

function eliminarCliente(id){
  DB.clientes = DB.clientes.filter(c=>c.id!==id);
  saveDB(); renderAll();
}

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
        DB = data;
        saveDB();
        boot();
        toast('Respaldo restaurado ✅');
      }
    }catch(err){
      toast('No se pudo leer el archivo ❌');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
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
        <button onclick="eliminarProducto('${p.id}')" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Eliminar</button>
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
        <button onclick="eliminarCliente('${c.id}')" class="btn btn-secondary" style="padding:4px 10px;font-size:11px;">Eliminar</button>
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
        <button onclick="eliminarMeta('${m.id}')" style="background:none;border:none;color:#d9534f;font-weight:700;cursor:pointer;">✕</button>
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
  renderFinanzas();
  renderPerfil();
}

/* ================= INSTALAR APP (PWA) ================= */
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

if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  });
}

/* ================= BOOT ================= */
function boot(){
  DB = loadDB();
  if(DB.negocio){
    document.getElementById('view-onboarding').hidden = true;
    document.getElementById('app').hidden = false;
    switchView(currentView);
  } else {
    document.getElementById('view-onboarding').hidden = false;
    document.getElementById('app').hidden = true;
  }
}
boot();
