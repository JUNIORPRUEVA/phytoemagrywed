#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

import pg from 'pg';

const DEFAULT_TIMEOUT_MS = 15_000;

function argsOf(argv) {
  const args = { csv: '', databaseUrl: '', timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--csv') args.csv = argv[++i] ?? '';
    else if (arg === '--database-url') args.databaseUrl = argv[++i] ?? '';
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i] ?? DEFAULT_TIMEOUT_MS);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Uso:
  node scripts/audit-historical-whatsapp-production.mjs --csv <archivo.csv>

Variables:
  DATABASE_URL o PHYTO_CRM_DATABASE_URL  PostgreSQL del CRM

Garantías:
  - Abre transacción BEGIN READ ONLY.
  - Solo ejecuta SELECT.
  - No llama APIs del CRM, WhatsApp, scheduler ni importador.
`);
      process.exit(0);
    } else {
      throw new Error(`opción desconocida: ${arg}`);
    }
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [headers, ...body] = rows.filter((entry) => entry.some((value) => String(value).trim()));
  if (!headers) return [];
  return body.map((values) => {
    const out = {};
    headers.forEach((header, index) => {
      out[String(header).trim()] = String(values[index] ?? '').trim();
    });
    return out;
  });
}

function fold(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

function first(row, names) {
  const normalized = new Map(Object.keys(row).map((key) => [fold(key), key]));
  for (const name of names) {
    const key = normalized.get(fold(name));
    if (key && row[key]) return row[key];
  }
  return '';
}

function toE164(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const withoutPrefix = digits.startsWith('00') ? digits.slice(2) : digits;
  const normalized = withoutPrefix.length === 10 ? `1${withoutPrefix}` : withoutPrefix;
  if (normalized.length < 8 || normalized.length > 15) return null;
  return `+${normalized}`;
}

function statusOf(row, phone) {
  const explicit = fold(first(row, ['estado comercial', 'clasificacion', 'clasificación', 'estado']));
  if (phone === '+18096738255' || phone === '+18098556095') return 'NO_COMPRO';
  if (explicit.includes('no compro') || explicit.includes('no compra')) return 'NO_COMPRO';
  if (explicit.includes('compro') && !explicit.includes('no compro')) return 'COMPRO_REPORTADO';
  if (explicit.includes('interes')) return 'INTERESADO';
  return 'POR_VERIFICAR';
}

function contactsFromCsv(file) {
  const rows = parseCsv(readFileSync(file, 'utf8'));
  return rows.map((row) => {
    const phone = toE164(first(row, ['whatsapp internacional', 'teléfono rd', 'telefono rd', 'telefono', 'teléfono', 'phone']));
    return {
      id: first(row, ['id']),
      name: first(row, ['nombre de cliente', 'nombre', 'cliente']),
      phone,
      status: statusOf(row, phone),
      observationPresent: Boolean(first(row, ['observaciones / evidencia', 'observaciones', 'evidencia'])),
    };
  });
}

async function tableExists(client, table) {
  const result = await client.query(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [table],
  );
  return result.rows[0]?.exists === true;
}

async function optionalRows(client, table, sql, params) {
  if (!(await tableExists(client, table))) return [];
  return (await client.query(sql, params)).rows;
}

function groupBy(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!out.has(value)) out.set(value, []);
    out.get(value).push(row);
  }
  return out;
}

async function main() {
  const args = argsOf(process.argv);
  if (!args.csv) throw new Error('falta --csv <archivo.csv>');
  if (!existsSync(args.csv)) throw new Error(`no existe el CSV: ${args.csv}`);
  const databaseUrl = args.databaseUrl || process.env.DATABASE_URL || process.env.PHYTO_CRM_DATABASE_URL || '';
  if (!databaseUrl) throw new Error('falta DATABASE_URL o PHYTO_CRM_DATABASE_URL');

  const contacts = contactsFromCsv(args.csv);
  const phones = [...new Set(contacts.map((row) => row.phone).filter(Boolean))];
  const validationErrors = [];
  if (contacts.length !== 34) validationErrors.push(`filas_csv=${contacts.length}`);
  if (phones.length !== 34) validationErrors.push(`telefonos_unicos=${phones.length}`);
  const byStatus = contacts.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});

  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: 'phyto-historical-whatsapp-readonly-audit',
    statement_timeout: args.timeoutMs,
    query_timeout: args.timeoutMs,
  });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.trunc(args.timeoutMs)}`);
    const mode = await client.query("SELECT current_setting('transaction_read_only') AS read_only, current_database() AS database");
    const readOnly = mode.rows[0]?.read_only === 'on';
    if (!readOnly) throw new Error('la transacción no quedó en READ ONLY');

    const customers = await optionalRows(
      client,
      'phytoemagry_customers',
      `SELECT
        id,
        phone_e164,
        doc->>'name' AS name,
        doc->>'commercial_state_manual' AS commercial_state_manual,
        doc->>'customer_stage_manual' AS customer_stage_manual,
        doc->>'do_not_contact' AS do_not_contact,
        doc->>'source' AS source,
        doc->>'historicalWhatsAppImport' AS historical_import,
        doc->>'total_purchases' AS stored_total_purchases,
        doc->>'total_spent' AS stored_total_spent,
        doc->>'last_purchase_at' AS stored_last_purchase_at
       FROM phytoemagry_customers
       WHERE phone_e164 = ANY($1::text[])
       ORDER BY phone_e164`,
      [phones],
    );
    const customerIds = customers.map((row) => row.id);
    const customerIdOrNull = customerIds.length ? customerIds : ['__none__'];
    const foundPhones = new Set(customers.map((row) => row.phone_e164));

    const orders = await optionalRows(
      client,
      'phytoemagry_items',
      `SELECT
        id,
        customer_id,
        phone,
        type,
        status,
        order_number,
        received_at,
        updated_at,
        total,
        source,
        channel,
        order_json
       FROM phytoemagry_items
       WHERE type = 'order_intent'
         AND (customer_id = ANY($1::text[]) OR phone = ANY($2::text[]))
       ORDER BY received_at DESC`,
      [customerIdOrNull, phones],
    );

    const conversations = await optionalRows(
      client,
      'phytoemagry_conversations',
      `SELECT id, customer_id, status, last_message_at, last_inbound_at, unread_count
       FROM phytoemagry_conversations
       WHERE customer_id = ANY($1::text[])`,
      [customerIdOrNull],
    );

    const messages = await optionalRows(
      client,
      'phytoemagry_wa_messages',
      `SELECT customer_id, direction, count(*)::int AS count
       FROM phytoemagry_wa_messages
       WHERE customer_id = ANY($1::text[])
       GROUP BY customer_id, direction`,
      [customerIdOrNull],
    );

    const followups = await optionalRows(
      client,
      'phytoemagry_followups',
      `SELECT customer_id, status, count(*)::int AS count
       FROM phytoemagry_followups
       WHERE customer_id = ANY($1::text[])
       GROUP BY customer_id, status`,
      [customerIdOrNull],
    );

    const byCustomer = groupBy(customers, 'phone_e164');
    const ordersByCustomer = groupBy(orders, 'customer_id');
    const conversationsByCustomer = groupBy(conversations, 'customer_id');
    const messageCountsByCustomer = groupBy(messages, 'customer_id');
    const followupsByCustomer = groupBy(followups, 'customer_id');
    const deliveredStatuses = new Set(['entregado']);

    const rows = contacts.map((contact) => {
      const customer = byCustomer.get(contact.phone)?.[0] ?? null;
      const customerOrders = customer ? ordersByCustomer.get(customer.id) ?? [] : [];
      const delivered = customerOrders.filter((row) => deliveredStatuses.has(String(row.status)));
      const open = customerOrders.filter((row) => !['entregado', 'cancelado', 'perdido'].includes(String(row.status)));
      const convs = customer ? conversationsByCustomer.get(customer.id) ?? [] : [];
      const msgCounts = customer ? messageCountsByCustomer.get(customer.id) ?? [] : [];
      const fups = customer ? followupsByCustomer.get(customer.id) ?? [] : [];
      const conflicts = [];
      if (delivered.length > 0 && contact.status !== 'COMPRO_REPORTADO') conflicts.push('csv_no_reporta_compra_pero_existe_entrega');
      if (contact.status === 'NO_COMPRO' && customerOrders.length > 0) conflicts.push('csv_no_compro_con_pedidos_existentes');
      if (customer?.name && contact.name && fold(customer.name) !== fold(contact.name)) conflicts.push('nombre_difiere');
      return {
        csvId: contact.id,
        phone: contact.phone,
        csvName: contact.name,
        csvStatus: contact.status,
        action: customer ? 'review_or_update' : 'create',
        existingCustomerId: customer?.id ?? null,
        existingNamePresent: Boolean(customer?.name),
        existingCommercialManual: customer?.commercial_state_manual ?? null,
        existingCustomerStageManual: customer?.customer_stage_manual ?? null,
        doNotContact: customer?.do_not_contact === 'true',
        hasHistoricalImport: Boolean(customer?.historical_import),
        orderCount: customerOrders.length,
        deliveredOrderCount: delivered.length,
        openOrderCount: open.length,
        latestOrderStatus: customerOrders[0]?.status ?? null,
        conversationCount: convs.length,
        inboundMessages: msgCounts.find((row) => row.direction === 'inbound')?.count ?? 0,
        outboundMessages: msgCounts.find((row) => row.direction === 'outbound')?.count ?? 0,
        followups: fups,
        conflicts,
      };
    });

    const existing = rows.filter((row) => row.existingCustomerId);
    const conflicts = rows.filter((row) => row.conflicts.length > 0);
    const updates = existing.filter((row) => row.conflicts.length > 0 || !row.hasHistoricalImport);
    const report = {
      ok: validationErrors.length === 0,
      readOnly,
      database: mode.rows[0]?.database,
      validation: { errors: validationErrors, rows: contacts.length, uniquePhones: phones.length, byStatus },
      summary: {
        existing: existing.length,
        toCreate: rows.length - existing.length,
        toReviewOrUpdate: updates.length,
        withDeliveredOrders: rows.filter((row) => row.deliveredOrderCount > 0).length,
        withOpenOrders: rows.filter((row) => row.openOrderCount > 0).length,
        withConversations: rows.filter((row) => row.conversationCount > 0).length,
        conflicts: conflicts.length,
      },
      rows,
      goNoGo:
        validationErrors.length === 0 && conflicts.length === 0
          ? 'GO técnico para preparar importación; requiere autorización explícita para escritura'
          : 'NO-GO hasta revisar conflictos/validación',
    };
    console.log(JSON.stringify(report, null, 2));
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
