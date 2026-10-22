#!/usr/bin/env node
/**
 * SEMILLA DE DEMOSTRACIÓN — FULLTECH Store (SOLO UAT)
 *
 * PARA QUÉ SIRVE
 *   Llenar la tienda local de pruebas con un catálogo realista (51 artículos; se reutilizan las categorías existentes) para trabajar el diseño y el recorrido de compra sin tocar
 *   producción ni inventar datos del negocio real.
 *
 * GARANTÍAS
 *   1. SOLO habla con un servidor LOCAL (`127.0.0.1`) y exige que el
 *      almacenamiento sea SQLite: producción usa Postgres, así que el script se
 *      niega a continuar contra ella.
 *   2. Es IDEMPOTENTE: los artículos llevan SKU `UAT-###`; si ya existen, se
 *      omiten (no se reescriben ni se duplican).
 *   3. Los artículos quedan MARCADOS INTERNAMENTE: SKU con prefijo UAT y la
 *      descripción interna empieza por «DEMO UAT». La descripción pública no
 *      lleva marcas raras (es la que ve el cliente).
 *   4. Las imágenes se GENERAN con sharp a partir de un SVG propio: son activos
 *      de prueba, sin derechos de terceros.
 *   5. Los descuentos son «precio anterior» configurado de verdad (el servidor
 *      valida que sea mayor y calcula el porcentaje). Las fechas de publicación
 *      las registra el servidor, sin backdating ni antigüedad inventada.
 *
 * CÓMO SE USA (con `npm run uat` abierto en otra terminal)
 *   node scripts/seed-store-uat.mjs                 (puerto 8790 = UAT)
 *   node scripts/seed-store-uat.mjs --dry-run       (solo informa, no escribe)
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const PORT = Number(value('port', '8790'));
const HOST = value('host', '127.0.0.1');
const TOKEN = value('token', 'phyto-uat');
const DRY = flag('dry-run');
const REFRESH_IMAGES = flag('refresh-images');
const BASE = `http://${HOST}:${PORT}`;
const UAT_DB = path.join(ROOT, 'data', 'uat', 'phyto-uat.sqlite');

/* ------------------------------------------------------------------ seguridad */
if (!['127.0.0.1', 'localhost'].includes(HOST) || PORT < 8790 || PORT > 8799) {
  console.error('⛔ Esta semilla solo funciona contra el UAT local (127.0.0.1:8790-8799).');
  process.exit(1);
}
if (!existsSync(UAT_DB)) {
  console.error(`⛔ No encuentro la base UAT en ${path.relative(ROOT, UAT_DB)}. ¿Arrancaste \`npm run uat\`?`);
  process.exit(1);
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error(`⛔ No responde ${BASE}/api/health. Arranca el ambiente UAT primero.`);
  process.exit(1);
}
if (health.storage !== 'sqlite' || health.uat !== true) {
  console.error(`⛔ El servidor de ${BASE} usa «${health.storage}». Esta semilla SOLO escribe en SQLite de UAT.`);
  process.exit(1);
}

/* ------------------------------------------------------------------- sesión */
const login = await fetch(`${BASE}/api/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: TOKEN }),
});
if (!login.ok) {
  console.error(`⛔ No pude entrar al panel de ${BASE} (HTTP ${login.status}). Revisa --token=…`);
  process.exit(1);
}
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
async function call(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${route} → HTTP ${response.status} ${data.error || ''} ${data.message || ''}`.trim());
    error.status = response.status;
    throw error;
  }
  return data;
}

/* -------------------------------------------------------------- imágenes */
const PALETTE = {
  'Tecnología': ['#0b3fa8', '#2f7bff'],
  Accesorios: ['#0b2c5c', '#4f8dff'],
  Hogar: ['#123c78', '#3b8bff'],
  Seguridad: ['#0b1220', '#165dff'],
  'Cámaras': ['#0f2f63', '#2f6bff'],
  'Redes y conectividad': ['#0c3466', '#5aa0ff'],
  Electricidad: ['#14325e', '#3f7bd6'],
  Phytoemagry: ['#0b1f45', '#2f7bff'],
};
const FORMATS = [[800, 800], [640, 800], [900, 700], [720, 900]];
/*
 * Pictograma vectorial por categoría (viewBox 100×100). Se dibuja con formas,
 * SIN texto: los generadores de imágenes no siempre tienen fuentes disponibles y
 * el texto se perdería. Son activos de prueba propios, sin derechos de terceros.
 */
const GLYPHS = {
  'Tecnología': '<rect x="18" y="26" width="64" height="38" rx="5"/><path d="M10 70h80l-7 10H17z"/>',
  Accesorios: '<path d="M20 60V50a30 30 0 0 1 60 0v10" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round"/><rect x="12" y="56" width="16" height="24" rx="7"/><rect x="72" y="56" width="16" height="24" rx="7"/>',
  Hogar: '<path d="M50 16 14 46h9v38h54V46h9z"/><rect x="42" y="62" width="16" height="22" fill="#0b1220" opacity="0.28"/>',
  Seguridad: '<path d="M50 14 20 26v24c0 19 13 31 30 36 17-5 30-17 30-36V26z"/>',
  'Cámaras': '<rect x="12" y="30" width="76" height="46" rx="9"/><circle cx="50" cy="53" r="15" fill="#0b1220" opacity="0.3"/><rect x="34" y="18" width="20" height="12" rx="4"/>',
  'Redes y conectividad': '<path d="M16 40a48 48 0 0 1 68 0l-9 10a35 35 0 0 0-50 0z"/><path d="M32 56a27 27 0 0 1 36 0l-9 10a14 14 0 0 0-18 0z"/><circle cx="50" cy="78" r="6"/>',
  Electricidad: '<path d="M57 10 25 57h19l-4 33 35-47H57z"/>',
  Phytoemagry: '<rect x="39" y="14" width="22" height="11" rx="3"/><path d="M37 29h26l6 13v35a7 7 0 0 1-7 7H37a7 7 0 0 1-7-7V42z"/>',
};
async function makeImage(product, index) {
  const [w, h] = FORMATS[index % FORMATS.length];
  const [c1, c2] = PALETTE[product.cat] || ['#0b1220', '#165dff'];
  const glyph = GLYPHS[product.cat] || GLYPHS.Accesorios;
  const side = Math.min(w, h) * 0.52;
  const x = (w - side) / 2;
  const y = (h - side) / 2 - h * 0.03;
  const tilt = ((index % 4) - 1.5) * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${Math.round(w * 0.82)}" cy="${Math.round(h * 0.16)}" r="${Math.round(w * 0.3)}" fill="#ffffff" opacity="0.10"/>
    <circle cx="${Math.round(w * 0.1)}" cy="${Math.round(h * 0.92)}" r="${Math.round(w * 0.24)}" fill="#ffffff" opacity="0.07"/>
    <rect x="${Math.round(w * 0.08)}" y="${Math.round(h * 0.86)}" width="${Math.round(w * 0.18)}" height="4" rx="2" fill="#ffffff" opacity="0.5"/>
    <g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${tilt} ${(side / 2).toFixed(1)} ${(side / 2).toFixed(1)})"
       fill="#ffffff" fill-opacity="0.92">
      <svg x="0" y="0" width="${side.toFixed(1)}" height="${side.toFixed(1)}" viewBox="0 0 100 100">${glyph}</svg>
    </g>
  </svg>`;
  const bytes = await sharp(Buffer.from(svg)).webp({ quality: 82 }).toBuffer();
  return `data:image/webp;base64,${bytes.toString('base64')}`;
}

/* --------------------------------------------------------------- catálogo */
/*
 * Catálogo de DEMOSTRACIÓN. Precios en pesos dominicanos (RD$) dentro de rangos
 * comerciales razonables para el tipo de artículo. `offer` = precio anterior
 * configurado (el servidor calcula el %); `stock` = unidades reales del UAT;
 * `order` = «bajo pedido» (se consigue con el proveedor, no descuenta stock).
 */
const CATEGORIES = ['Tecnología', 'Accesorios', 'Hogar', 'Seguridad', 'Cámaras', 'Redes y conectividad', 'Electricidad', 'Phytoemagry'];

const PRODUCTS = [

  // Tecnología
  { cat: 'Tecnología', name: 'Laptop Fulltech 14" 8 GB / 256 GB', brand: 'FULLTECH', price: 28500, offer: 31900, stock: 4, featured: true, short: 'Portátil ligero para trabajo y estudio, SSD de 256 GB.', desc: 'Pantalla de 14 pulgadas, 8 GB de memoria y unidad SSD de 256 GB. Incluye cargador y funda de transporte.' },
  { cat: 'Tecnología', name: 'Monitor LED 24" Full HD 75 Hz', brand: 'ViewMax', price: 9450, stock: 7, featured: true, short: 'Panel IPS de 24 pulgadas con HDMI y VGA.', desc: 'Resolución 1920 × 1080, 75 Hz, entradas HDMI y VGA, base ajustable e inclinación.' },
  { cat: 'Tecnología', name: 'Teclado inalámbrico compacto', brand: 'KeyPro', price: 1750, stock: 18, short: 'Teclado Bluetooth de perfil bajo con teclado numérico.', desc: 'Conexión Bluetooth 5.0, batería recargable por USB-C y diseño de perfil bajo.' },
  { cat: 'Tecnología', name: 'Mouse ergonómico silencioso', brand: 'KeyPro', price: 890, offer: 1150, stock: 26, short: 'Clic silencioso y sensor de 1600 DPI.', desc: 'Diseño ergonómico para uso prolongado, clic silencioso y sensor ajustable de 800 a 1600 DPI.' },
  { cat: 'Tecnología', name: 'Disco SSD 480 GB SATA', brand: 'StoreJet', price: 3450, stock: 12, featured: true, short: 'Mejora el arranque de tu computadora.', desc: 'Unidad de estado sólido SATA III de 480 GB, formato de 2.5 pulgadas.' },
  { cat: 'Tecnología', name: 'Tablet 10" 64 GB Wi-Fi', brand: 'FULLTECH', price: 11900, stock: 0, short: 'Pantalla de 10 pulgadas para estudio y entretenimiento.', desc: 'Tablet de 10 pulgadas, 64 GB de almacenamiento y conectividad Wi-Fi.' },
  { cat: 'Tecnología', name: 'Impresora multifuncional Wi-Fi', brand: 'PrintLine', price: 14900, offer: 17200, stock: 3, short: 'Imprime, escanea y copia desde el teléfono.', desc: 'Impresora multifuncional con Wi-Fi, impresión a doble cara y escáner de cama plana.' },
  { cat: 'Tecnología', name: 'Audífonos over-ear con cancelación', brand: 'SoundOne', price: 5200, stock: 9, short: 'Cancelación activa de ruido y 30 h de batería.', desc: 'Audífonos circumaurales con cancelación activa de ruido, hasta 30 horas de autonomía y estuche rígido.' },
  // Accesorios
  { cat: 'Accesorios', name: 'Cargador rápido USB-C 33 W', brand: 'PowerLink', price: 1250, stock: 34, short: 'Carga rápida para teléfono y tablet.', desc: 'Cargador de pared de 33 W con puerto USB-C y protección contra sobrecarga.' },
  { cat: 'Accesorios', name: 'Cable USB-C trenzado 1.5 m', brand: 'PowerLink', price: 590, offer: 750, stock: 48, short: 'Cable reforzado para carga y datos.', desc: 'Cable USB-C a USB-C de 1.5 metros, recubrimiento trenzado y soporte de carga rápida.' },
  { cat: 'Accesorios', name: 'Power bank 20 000 mAh', brand: 'PowerLink', price: 2650, stock: 14, featured: true, short: 'Dos salidas y carga simultánea.', desc: 'Batería externa de 20 000 mAh con dos salidas USB y entrada USB-C.' },
  { cat: 'Accesorios', name: 'Soporte para teléfono de escritorio', brand: 'DeskMate', price: 450, stock: 40, short: 'Aluminio ajustable, plegable.', desc: 'Soporte de aluminio con inclinación ajustable para teléfono o tablet pequeña.' },
  { cat: 'Accesorios', name: 'Funda impermeable para celular', brand: 'AquaGear', price: 690, stock: 0, short: 'Protección contra agua y polvo.', desc: 'Funda sellada con cierre de seguridad, compatible con pantallas táctiles.' },
  { cat: 'Accesorios', name: 'Mochila antirrobo 15.6"', brand: 'TrekLine', price: 3200, offer: 3900, stock: 6, short: 'Compartimento acolchado y puerto USB.', desc: 'Mochila con compartimento para portátil de 15.6 pulgadas, bolsillo oculto y puerto USB externo.' },
  { cat: 'Accesorios', name: 'Auriculares inalámbricos deportivos', brand: 'SoundOne', price: 2400, stock: 11, short: 'Resistentes al sudor con gancho de oído.', desc: 'Auriculares Bluetooth con gancho de sujeción, resistencia al sudor y estuche de carga.' },
  // Hogar
  { cat: 'Hogar', name: 'Enchufe inteligente Wi-Fi', brand: 'SmartHome', price: 1150, offer: 1450, stock: 22, featured: true, short: 'Controla desde el teléfono o por voz.', desc: 'Enchufe con Wi-Fi 2.4 GHz, programación horaria y control por aplicación.' },
  { cat: 'Hogar', name: 'Lámpara LED de escritorio táctil', brand: 'LightWay', price: 1890, stock: 15, short: 'Tres temperaturas de luz y brazo ajustable.', desc: 'Lámpara LED con control táctil, tres tonos de luz y brazo articulado.' },
  { cat: 'Hogar', name: 'Cafetera de goteo 12 tazas', brand: 'HomeBrew', price: 4300, stock: 5, short: 'Jarra de vidrio y filtro reutilizable.', desc: 'Cafetera de goteo para 12 tazas con placa térmica y filtro permanente.' },
  { cat: 'Hogar', name: 'Ventilador de torre silencioso', brand: 'CoolAir', price: 6800, offer: 7600, stock: 2, short: 'Oscilación y temporizador.', desc: 'Ventilador de torre con tres velocidades, oscilación y temporizador de 8 horas.' },
  { cat: 'Hogar', name: 'Set de sartenes antiadherentes (3)', brand: 'KitchenPro', price: 3950, stock: 8, short: 'Tres tamaños con recubrimiento antiadherente.', desc: 'Juego de tres sartenes de 20, 24 y 28 cm con mango resistente al calor.' },
  { cat: 'Hogar', name: 'Organizador de escritorio de madera', brand: 'DeskMate', price: 1450, stock: 0, short: 'Dos niveles y cajón frontal.', desc: 'Organizador de madera con dos niveles, cajón y espacio para documentos.' },
  // Seguridad
  { cat: 'Seguridad', name: 'Cerradura inteligente con huella', brand: 'SafeLock', price: 12400, offer: 14200, stock: 4, featured: true, short: 'Huella, código y llave de respaldo.', desc: 'Cerradura de puerta con lector de huella, teclado numérico y llave mecánica de respaldo.' },
  { cat: 'Seguridad', name: 'Detector de humo inalámbrico', brand: 'SafeLock', price: 2350, stock: 16, short: 'Alarma sonora de 85 dB.', desc: 'Detector fotoeléctrico de humo con alarma de 85 dB y aviso de batería baja.' },
  { cat: 'Seguridad', name: 'Alarma para puerta y ventana', brand: 'SafeLock', price: 890, stock: 30, short: 'Instalación sin cables, 90 dB.', desc: 'Contacto magnético con adhesivo, sirena de 90 dB y baterías incluidas.' },
  { cat: 'Seguridad', name: 'Kit de seguridad para el hogar (4 piezas)', brand: 'SafeLock', price: 7450, offer: 8900, stock: 3, short: 'Sensor de movimiento, contactos y sirena.', desc: 'Kit con hub, sensor de movimiento, dos contactos magnéticos y sirena.' },
  { cat: 'Seguridad', name: 'Extintor PQS 5 lb', brand: 'GuardPro', price: 3200, stock: 9, short: 'Polvo químico seco, manómetro incluido.', desc: 'Extintor de polvo químico seco de 5 libras con soporte y manómetro.' },
  { cat: 'Seguridad', name: 'Caja fuerte digital pequeña', brand: 'GuardPro', price: 8600, stock: 0, short: 'Apertura por código con llave de emergencia.', desc: 'Caja fuerte con teclado digital, llave de emergencia y anclaje para pared.' },
  { cat: 'Seguridad', name: 'Timbre inalámbrico con cámara', brand: 'SmartHome', price: 4900, order: true, short: 'Aviso en el teléfono con imagen.', desc: 'Timbre con cámara, visión nocturna y notificación en la aplicación.' },
  // Cámaras
  { cat: 'Cámaras', name: 'Cámara IP interior 2 MP', brand: 'ViewMax', price: 3450, stock: 20, featured: true, short: 'Visión nocturna y audio bidireccional.', desc: 'Cámara Wi-Fi interior de 2 MP con visión nocturna, audio bidireccional y tarjeta microSD.' },
  { cat: 'Cámaras', name: 'Cámara IP exterior IP66 4 MP', brand: 'ViewMax', price: 5900, offer: 6900, stock: 10, short: 'Resistente a la intemperie.', desc: 'Cámara exterior con certificación IP66, resolución 4 MP y detección de movimiento.' },
  { cat: 'Cámaras', name: 'Kit de 4 cámaras con grabador', brand: 'ViewMax', price: 24600, stock: 2, short: 'Cuatro cámaras, DVR y disco de 1 TB.', desc: 'Kit completo con cuatro cámaras, grabador de 4 canales, disco de 1 TB y cables.' },
  { cat: 'Cámaras', name: 'Cámara PTZ con seguimiento', brand: 'GuardPro', price: 8900, stock: 6, short: 'Gira 355° y sigue el movimiento.', desc: 'Cámara PTZ con rotación de 355°, seguimiento automático y visión nocturna.' },
  { cat: 'Cámaras', name: 'Video portero con pantalla 7"', brand: 'SafeLock', price: 11200, offer: 12800, stock: 3, short: 'Pantalla interior y cámara exterior.', desc: 'Videoportero con pantalla de 7 pulgadas, cámara exterior y apertura remota.' },
  { cat: 'Cámaras', name: 'Cámara de acción 4K sumergible', brand: 'TrekLine', price: 9800, stock: 0, short: 'Grabación 4K y carcasa sumergible.', desc: 'Cámara de acción 4K con estabilización, carcasa sumergible y soportes.' },
  { cat: 'Cámaras', name: 'Memoria microSD 64 GB clase 10', brand: 'StoreJet', price: 950, stock: 44, short: 'Para cámaras y grabadores.', desc: 'Tarjeta microSD de 64 GB clase 10 con adaptador SD.' },
  // Redes y conectividad
  { cat: 'Redes y conectividad', name: 'Router Wi-Fi 6 doble banda', brand: 'NetCore', price: 7900, offer: 8900, stock: 8, featured: true, short: 'Cobertura para casas de varios niveles.', desc: 'Router Wi-Fi 6 con doble banda, cuatro antenas y puertos Gigabit.' },
  { cat: 'Redes y conectividad', name: 'Repetidor Wi-Fi de pared', brand: 'NetCore', price: 2150, stock: 19, short: 'Amplía la señal en toda la casa.', desc: 'Repetidor de señal Wi-Fi con configuración por aplicación y puerto Ethernet.' },
  { cat: 'Redes y conectividad', name: 'Switch Gigabit 8 puertos', brand: 'NetCore', price: 3450, stock: 7, short: 'Metálico, montaje en pared.', desc: 'Switch no administrable de 8 puertos Gigabit con carcasa metálica.' },
  { cat: 'Redes y conectividad', name: 'Cable de red Cat6 15 m', brand: 'NetCore', price: 950, stock: 25, short: 'Listo para usar, con conectores.', desc: 'Cable UTP Cat6 de 15 metros con conectores RJ45 montados.' },
  { cat: 'Redes y conectividad', name: 'Módem-router para fibra', brand: 'NetCore', price: 6400, order: true, short: 'Compatible con planes de fibra óptica.', desc: 'Equipo para fibra con puerto WAN, Wi-Fi de doble banda y configuración guiada.' },
  { cat: 'Redes y conectividad', name: 'Antena exterior de largo alcance', brand: 'NetCore', price: 4200, stock: 4, short: 'Enlace punto a punto de hasta 5 km.', desc: 'Antena direccional para enlaces exteriores con kit de montaje.' },
  // Electricidad
  { cat: 'Electricidad', name: 'Regulador de voltaje 1000 VA', brand: 'VoltGuard', price: 4600, stock: 10, short: 'Protección contra variaciones de voltaje.', desc: 'Regulador automático de voltaje de 1000 VA con dos tomacorrientes.' },
  { cat: 'Electricidad', name: 'UPS 1200 VA con respaldo', brand: 'VoltGuard', price: 8900, offer: 10400, stock: 5, featured: true, short: 'Mantiene equipos encendidos ante cortes.', desc: 'Sistema de respaldo de 1200 VA con cuatro tomas y protección contra sobretensión.' },
  { cat: 'Electricidad', name: 'Toma corriente doble con protección', brand: 'VoltGuard', price: 420, stock: 60, short: 'Instalación sencilla, 15 A.', desc: 'Tomacorriente doble de 15 A con tapa y protección contra sobrecarga.' },
  { cat: 'Electricidad', name: 'Breaker de 2 polos 60 A', brand: 'VoltGuard', price: 1350, stock: 18, short: 'Corte automático para paneles.', desc: 'Interruptor termomagnético de dos polos y 60 A para panel eléctrico.' },
  { cat: 'Electricidad', name: 'Extensión eléctrica 6 tomas 3 m', brand: 'VoltGuard', price: 890, stock: 0, short: 'Con interruptor y protección.', desc: 'Extensión de seis tomas con interruptor, protección térmica y cable de 3 metros.' },
  { cat: 'Electricidad', name: 'Panel solar portátil 100 W', brand: 'VoltGuard', price: 16800, offer: 19500, stock: 2, short: 'Carga equipos en exteriores.', desc: 'Panel solar plegable de 100 W con regulador de carga y salidas USB.' },
  // Cierre del catálogo de demostración
  { cat: 'Accesorios', name: 'Estuche rígido para audífonos', brand: 'SoundOne', price: 690, stock: 21, short: 'Protege y organiza tus audífonos.', desc: 'Estuche semirrígido con malla interior y mosquetón de transporte.' },
  { cat: 'Hogar', name: 'Purificador de agua de grifo', brand: 'HomeBrew', price: 3900, stock: 6, short: 'Filtro de carbón activado.', desc: 'Purificador de grifo con filtro de carbón activado y selector de agua filtrada.' },
  { cat: 'Cámaras', name: 'Soporte de techo para cámara', brand: 'ViewMax', price: 650, stock: 27, short: 'Montaje ajustable de 360°.', desc: 'Soporte metálico para techo o pared con inclinación ajustable y tornillos.' },
  { cat: 'Accesorios', name: 'Adaptador USB-C a Ethernet Gigabit', brand: 'FULLTECH', price: 1590, stock: 8, short: 'Conexión de red por cable para USB-C.', desc: 'Adaptador de demostración UAT con puerto Ethernet Gigabit y conexión USB-C.' },
  // Phytoemagry (categoría existente del catálogo: sus presentaciones reales ya
  // están publicadas; aquí solo se añade un accesorio neutro, sin duplicarlas).
];

/* ---------------------------------------------------------------- ejecución */
const existing = await call('/api/admin/store/products');
const bySku = new Map((existing.products || []).map((product) => [String(product.sku || '').toUpperCase(), product]));
const skuOf = (index) => `UAT-${String(index + 1).padStart(3, '0')}`;
const pendientes = PRODUCTS.filter((product, index) => !bySku.has(skuOf(index)));

console.log(`\n▸ SEMILLA FULLTECH STORE · ${BASE}`);
console.log(`   catálogo objetivo      ${PRODUCTS.length} artículos en ${CATEGORIES.length} categorías`);
console.log(`   ya existentes          ${PRODUCTS.length - pendientes.length}`);
console.log(`   a crear                ${pendientes.length}${DRY ? '  (dry-run: no se escribe)' : ''}\n`);
if (DRY) { console.log('Dry-run: no writes.'); } else {
if (!pendientes.length) {
  if (pendientes.length) {
    console.log('· Dry-run: nada se ha escrito.');
    process.exit(0);
  }
  console.log('· Artículos: ya estaban todos sembrados (idempotente).');
}

let created = 0;
for (const [index, product] of PRODUCTS.entries()) {
  const sku = skuOf(index);
  if (bySku.has(sku)) continue;
  const body = {
    kind: 'product',
    name: product.name,
    sku,
    category: product.cat,
    /* Descripción INTERNA: marca el registro como demostración. */
    description: `DEMO UAT · Artículo de demostración generado por scripts/seed-store-uat.mjs. No usar en producción.`,
    store_public_name: product.name,
    store_brand: product.brand,
    store_short_description: product.short,
    store_public_description: product.desc,
    price: product.price.toFixed(2),
    cost: (product.price * 0.62).toFixed(2),
    quantity: product.order ? 0 : product.stock,
    min_stock: 1,
    track_stock: !product.order,
    product_type: product.order ? 'third_party' : 'own',
    store_availability: product.order ? 'ON_REQUEST' : 'AVAILABLE_NOW',
    ...(product.offer ? { compare_at_price: product.offer.toFixed(2) } : {}),
    images: [{ data: await makeImage({ ...product, cat: product.cat }, index) }],
  };
  const result = await call('/api/admin/store/products', { method: 'POST', body });
  await call(`/api/admin/store/products/${result.product.id}/publication`, {
    method: 'POST',
    body: { status: 'published', featured: product.featured === true, sort_order: (index + 1) * 10 },
  });
  created += 1;
  process.stdout.write(`\r   creados y publicados: ${created}/${pendientes.length}`);
}
console.log(`\n\n▸ ${created} artículos creados y publicados.`);

/*
 * REPARACIÓN DE OFERTAS (idempotente): si un artículo de demostración ya existía
 * antes de que el catálogo entendiera «precio anterior», se le configura ahora.
 * Se envía el registro completo con su versión para respetar el control de
 * concurrencia del CRM.
 */
let repaired = 0;
if (!DRY) {
  const fresh = new Map(((await call('/api/admin/store/products')).products || []).map((product) => [String(product.sku || '').toUpperCase(), product]));
  for (const [index, seed] of PRODUCTS.entries()) {
    const current = fresh.get(skuOf(index));
    if (!current) continue;
    const needsOffer = Boolean(seed.offer) && Number(current.compare_at_cents) !== Number(seed.offer) * 100;
    if (!needsOffer && !REFRESH_IMAGES) continue;
    await call(`/api/admin/store/products/${current.id}`, {
      method: 'PATCH',
      body: {
        version: current.version,
        kind: 'product',
        name: current.name,
        sku: current.sku,
        category: current.category,
        description: current.description,
        store_public_name: current.store_public_name,
        store_brand: current.store_brand,
        store_short_description: current.store_short_description,
        store_public_description: current.store_public_description,
        price: (current.price_cents / 100).toFixed(2),
        cost: (current.cost_cents / 100).toFixed(2),
        ...(needsOffer ? { compare_at_price: seed.offer.toFixed(2) } : {}),
        ...(REFRESH_IMAGES ? { images: [{ data: await makeImage(seed, index) }] } : {}),
        min_stock: current.min_stock,
        active: current.active !== false,
        track_stock: current.track_stock !== false,
        product_type: current.product_type || 'own',
        store_availability: current.store_availability || 'AVAILABLE_NOW',
      },
    });
    repaired += 1;
  }
  if (repaired) console.log(`▸ ${repaired} artículo(s) actualizados (ofertas e imágenes).`);
}

const after = await call('/api/store/catalog?limit=1');
const home = await fetch(`${BASE}/api/store/home`).then((r) => r.json());
console.log(`\n   catálogo público        ${after.pagination?.total ?? '?'} artículos`);
console.log(`   destacados              ${home.sections?.featured?.length ?? 0}`);
console.log(`   ofertas (precio anterior) ${home.sections?.offers?.length ?? 0}`);
console.log(`   novedades               ${home.sections?.newArrivals?.length ?? 0}`);
console.log(`   categorías              ${(home.categoryCards || []).map((tile) => `${tile.name} (${tile.count})`).join(' · ')}\n`);

}
