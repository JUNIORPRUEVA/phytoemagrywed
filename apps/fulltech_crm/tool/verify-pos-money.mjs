#!/usr/bin/env node
/**
 * Verificación de paridad de dinero JS ↔ Dart para el POS.
 *
 * Lee los MISMOS casos que la app (`test/fixtures/pos_money_cases.json`) y los
 * pasa por `public/admin/pos-math.js`, que es el módulo que ejecuta el
 * servidor. No modifica nada: solo compara.
 *
 * Uso:  node tool/verify-pos-money.mjs
 * Salida: tabla de casos + código de salida 0 si todo coincide, 1 si no.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { calculateSale } from '../../../public/admin/pos-math.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../test/fixtures/pos_money_cases.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

let failures = 0;
const rows = [];

for (const testCase of fixture.cases) {
  // Las líneas manuales NO existen en el catálogo: `calculateSale` las crea con
  // `manualProducts()` a partir del objeto `manual`.
  const products = testCase.lines
    .filter((line) => !line.manual)
    .map((line) => ({
      id: line.variantId,
      name: `Producto ${line.variantId}`,
      price_cents: line.unitPriceCents,
      active: true,
    }));
  const lines = testCase.lines.map((line) => ({
    variantId: line.variantId,
    quantity: line.quantity,
    discount: line.discount ?? {},
    ...(line.manual ? { manual: line.manual } : {}),
  }));

  // La app envía el envío en PESOS ENTEROS (redondeado); eso es lo que llega aquí.
  const deliveryFeePesos = Math.round(testCase.deliveryFeeCents / 100);
  const sale = calculateSale(lines, products, testCase.discount ?? {}, deliveryFeePesos);

  let expected = testCase.expected;
  if (testCase.knownDivergence) {
    // Este caso existe para DEMOSTRAR la diferencia: si el envío llegara con
    // fracción de peso, el servidor calcularía céntimos y rechazaría la venta.
    const raw = testCase.deliveryFeeCents / 100;
    const rawSale = calculateSale(lines, products, {}, raw);
    const rawOk = !Number.isInteger(raw) && rawSale.total_cents === testCase.expectedJs.totalCents;
    rows.push({
      caso: `${testCase.name} (envío sin redondear)`,
      'subtotal JS': rawSale.subtotal_cents,
      'subtotal esperado': testCase.expectedJs.subtotalCents,
      'total JS': rawSale.total_cents,
      'total esperado': testCase.expectedJs.totalCents,
      resultado: rawOk ? 'OK (divergencia documentada)' : 'FALLA',
    });
    if (!rawOk) failures += 1;
    expected = testCase.expected;
  }
  const ok =
    sale.subtotal_cents === expected.subtotalCents &&
    sale.total_cents === expected.totalCents &&
    sale.delivery_cents === deliveryFeePesos * 100 &&
    (expected.discountCents === undefined || sale.discount_cents === expected.discountCents) &&
    (expected.lineDiscountCents === undefined ||
      sale.items.reduce((sum, row) => sum + row.discount_cents, 0) === expected.lineDiscountCents);

  if (!ok) failures += 1;
  rows.push({
    caso: testCase.name,
    'subtotal JS': sale.subtotal_cents,
    'subtotal esperado': expected.subtotalCents,
    'total JS': sale.total_cents,
    'total esperado': expected.totalCents,
    resultado: ok ? 'OK' : 'FALLA',
  });
}

console.table(rows);

const divergences = fixture.cases.filter((c) => c.knownDivergence);
if (divergences.length > 0) {
  console.log('\nDivergencias deliberadas (la app redondea el envío a pesos enteros):');
  for (const c of divergences) {
    console.log(`- ${c.name}: ${c.knownDivergence}`);
  }
}

console.log(`\n${fixture.cases.length} casos, ${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
