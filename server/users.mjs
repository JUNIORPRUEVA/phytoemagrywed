import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(pbkdf2);

export const USER_ROLES = Object.freeze(['ADMIN', 'AGENT', 'DELIVERY', 'OPERADOR']);

/**
 * Largo mínimo de una contraseña.
 *
 * Seis caracteres es lo que pidió el negocio para poder crear cuentas rápido en
 * mostrador. El panel lo enseña tal cual (`data.minPasswordLength`), así que la
 * regla vive en UN solo sitio y no se puede quedar desincronizada.
 */
export const MIN_PASSWORD_LENGTH = 6;
export const ROLE_PERMISSIONS = Object.freeze({
  ADMIN: Object.freeze(['*']),
  AGENT: Object.freeze([
    'clients.read',
    'clients.update',
    'customer.stage.update',
    'customer.tags.assign',
    'chats.read',
    'chats.reply',
    'chats.transfer_own',
    'followups.read',
    'followups.create',
    'followups.update',
    'sales.read',
    'sales.create',
    'sales.view_payment_method',
    'orders.read',
    'orders.create',
    'orders.update_operational',
    'delivery.manage',
    /*
     * UN AGENTE TAMBIÉN REPARTE: el negocio no tiene repartidores aparte, el
     * pedido se le pasa a un agente y ese agente lo entrega. Sin estos permisos
     * «propios» podría recibir el pedido pero no arrancar la entrega ni compartir
     * su ubicación, que es justo lo que hace falta para entregarlo.
     */
    'delivery.location.read_own',
    'delivery.location.update_own',
    'delivery.tracking.start',
    'delivery.tracking.stop',
  ]),
  DELIVERY: Object.freeze([
    'clients.read',
    'clients.update',
    'customer.stage.update',
    'customer.tags.assign',
    'chats.read',
    'chats.reply',
    'chats.transfer_own',
    'followups.read',
    'followups.create',
    'followups.update',
    'sales.read',
    'sales.create',
    'sales.view_payment_method',
    'orders.read',
    'orders.create',
    'orders.update_operational',
    'delivery.manage',
    'delivery.location.read_own',
    'delivery.location.update_own',
    'delivery.tracking.start',
    'delivery.tracking.stop',
  ]),
  OPERADOR: Object.freeze([
    'clients.read',
    'clients.update',
    'customer.stage.update',
    'customer.tags.assign',
    'chats.read',
    'chats.reply',
    'chats.transfer_own',
    'followups.read',
    'followups.create',
    'followups.update',
    'sales.read',
    'sales.create',
    'sales.view_payment_method',
    'orders.read',
    'orders.create',
    'orders.update_operational',
    'delivery.manage',
  ]),
});
export const SYSTEM_ACTOR = Object.freeze({
  id: 'SYSTEM',
  role: 'SYSTEM',
  display_name: 'Sistema',
  actor_type: 'SYSTEM',
});

const PASSWORD_VERSION = 'pbkdf2-sha256';
const PASSWORD_ITERATIONS = 210_000;
const PASSWORD_KEYLEN = 32;
const PASSWORD_DIGEST = 'sha256';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function short(value, max = 200) {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

function usernameOf(value) {
  return short(value, 120)?.toLowerCase() ?? null;
}

function publicUser(user) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  return safe;
}

async function hashPassword(password) {
  const value = String(password ?? '');
  if (value.length < MIN_PASSWORD_LENGTH) return { ok: false, error: 'weak_password' };
  const salt = randomBytes(16).toString('base64url');
  const key = await derive(value, salt, PASSWORD_ITERATIONS, PASSWORD_KEYLEN, PASSWORD_DIGEST);
  return {
    ok: true,
    hash: `${PASSWORD_VERSION}$${PASSWORD_ITERATIONS}$${salt}$${Buffer.from(key).toString('base64url')}`,
  };
}

async function verifyPassword(password, stored) {
  const raw = String(stored ?? '');
  const [version, iterationsRaw, salt, expectedRaw] = raw.split('$');
  if (version !== PASSWORD_VERSION || !salt || !expectedRaw) return false;
  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isFinite(iterations) || iterations < 100_000) return false;
  const expected = Buffer.from(expectedRaw, 'base64url');
  const actual = await derive(String(password ?? ''), salt, iterations, expected.length, PASSWORD_DIGEST);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function createPasswordHash(password) {
  const result = await hashPassword(password);
  if (!result.ok) throw Object.assign(new Error(result.error), { code: result.error });
  return result.hash;
}

export function sanitizeUser(user) {
  return publicUser(user);
}

export function permissionsForRole(role) {
  return ROLE_PERMISSIONS[String(role ?? '').toUpperCase()] ?? [];
}

export function hasPermission(userOrRole, permission) {
  const role = typeof userOrRole === 'string' ? userOrRole : userOrRole?.role;
  const permissions = permissionsForRole(role);
  return permissions.includes('*') || permissions.includes(permission);
}

export function actorFromUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    role: user.role,
    display_name: user.display_name,
    actor_type: 'USER',
  };
}

export function createUserService(deps) {
  const db = deps.db;
  const audit = deps.audit ?? null;
  const sessionSeconds = Number(deps.sessionSeconds ?? 8 * 60 * 60);
  const clock = deps.clock ?? (() => new Date());

  async function activeAdmins(exceptId = null) {
    const users = await db.list('crm_users', { limit: 1000 });
    return users.filter((user) => user.active !== false && user.role === 'ADMIN' && user.id !== exceptId);
  }

  async function byUsername(username) {
    return db.findBy('crm_users', 'username', usernameOf(username));
  }

  async function ensureBootstrapAdmin(input = {}) {
    const username = usernameOf(input.username);
    const password = String(input.password ?? '');
    if (!username || !password) return { created: false, reason: 'not_configured' };

    const existing = await byUsername(username);
    if (existing) {
      const updated = await updateUser(
        existing.id,
        {
          password,
          firstName: input.firstName ?? existing.first_name,
          lastName: input.lastName ?? existing.last_name,
          displayName: input.displayName ?? existing.display_name,
          role: 'ADMIN',
          active: true,
        },
        SYSTEM_ACTOR,
      );
      return { created: false, updated: updated.ok === true, user: updated.user ?? publicUser(existing) };
    }

    const created = await createUser({
      username,
      password,
      firstName: input.firstName ?? 'Admin',
      lastName: input.lastName ?? null,
      displayName: input.displayName ?? 'Administrador',
      role: 'ADMIN',
      createdBy: null,
    });
    return { created: true, user: created.user };
  }

  async function createUser(input) {
    const username = usernameOf(input.username);
    const role = USER_ROLES.includes(input.role) ? input.role : 'AGENT';
    const firstName = short(input.firstName ?? input.first_name, 80);
    const lastName = short(input.lastName ?? input.last_name, 80);
    const displayName = short(input.displayName ?? input.display_name, 120) ?? ([firstName, lastName].filter(Boolean).join(' ') || username);
    if (!username || !displayName) return { ok: false, error: 'invalid_user' };
    const password = await hashPassword(input.password);
    if (!password.ok) return { ok: false, error: password.error };
    const at = clock().toISOString();
    const doc = {
      id: newId('usr'),
      first_name: firstName,
      last_name: lastName,
      display_name: displayName,
      username,
      password_hash: password.hash,
      role,
      active: input.active === false ? false : true,
      created_at: at,
      updated_at: at,
      last_login_at: null,
      created_by: short(input.createdBy, 80),
    };
    const result = await db.insert('crm_users', doc);
    if (result.duplicate) return { ok: false, error: 'duplicate_user' };
    await audit?.record({
      entity: 'user',
      entityId: doc.id,
      action: 'user_created',
      actor: input.actorName ?? null,
      summary: `Usuario creado: ${doc.display_name}`,
      data: { role: doc.role, username: doc.username },
      idempotencyKey: `user.created:${doc.id}`,
    });
    return { ok: true, user: publicUser(doc) };
  }

  async function listUsers() {
    const rows = await db.list('crm_users', { by: 'created_at', order: 'asc', limit: 1000 });
    return rows.map(publicUser);
  }

  async function updateUser(id, patch, actor = null) {
    const current = await db.get('crm_users', id);
    if (!current) return { ok: false, error: 'not_found' };
    const nextRole = patch.role !== undefined ? String(patch.role) : current.role;
    const nextActive = patch.active !== undefined ? patch.active === true : current.active !== false;
    if (!USER_ROLES.includes(nextRole)) return { ok: false, error: 'invalid_role' };
    if (current.role === 'ADMIN' && (nextRole !== 'ADMIN' || nextActive === false)) {
      if ((await activeAdmins(current.id)).length === 0) return { ok: false, error: 'last_admin' };
    }
    const update = { updated_at: clock().toISOString() };
    if (patch.firstName !== undefined || patch.first_name !== undefined) update.first_name = short(patch.firstName ?? patch.first_name, 80);
    if (patch.lastName !== undefined || patch.last_name !== undefined) update.last_name = short(patch.lastName ?? patch.last_name, 80);
    if (patch.displayName !== undefined || patch.display_name !== undefined) {
      // Un nombre visible vacío dejaría el chat y la auditoría sin autor: se rechaza.
      const displayName = short(patch.displayName ?? patch.display_name, 120);
      if (!displayName) return { ok: false, error: 'invalid_user' };
      update.display_name = displayName;
    }
    if (patch.role !== undefined) update.role = nextRole;
    if (patch.active !== undefined) update.active = nextActive;
    if (patch.password !== undefined) {
      const password = await hashPassword(patch.password);
      if (!password.ok) return { ok: false, error: password.error };
      update.password_hash = password.hash;
      update.password_changed_at = update.updated_at;
    }
    const updated = await db.update('crm_users', id, update);
    if (patch.active === false) await revokeSessionsForUser(id, 'user_disabled');
    if (patch.role !== undefined && patch.role !== current.role) await revokeSessionsForUser(id, 'role_changed');
    if (patch.active === false) {
      await audit?.record({ entity: 'user', entityId: id, action: 'user_disabled', actor: actor?.display_name, summary: `Usuario desactivado: ${current.display_name}` });
    } else if (patch.role !== undefined && patch.role !== current.role) {
      await audit?.record({
        entity: 'user',
        entityId: id,
        action: 'user_role_changed',
        actor: actor?.display_name,
        summary: `Rol: ${current.role} → ${patch.role}`,
        data: { from: current.role, to: patch.role },
      });
    } else {
      await audit?.record({ entity: 'user', entityId: id, action: 'user_updated', actor: actor?.display_name, summary: `Usuario actualizado: ${updated.display_name}` });
    }
    return { ok: true, user: publicUser(updated) };
  }

  async function changeOwnPassword(userId, currentPassword, nextPassword, actor = null) {
    const user = await db.get('crm_users', userId);
    if (!user || user.active === false) return { ok: false, error: 'not_found' };
    if (!(await verifyPassword(currentPassword, user.password_hash))) return { ok: false, error: 'invalid_password' };
    const password = await hashPassword(nextPassword);
    if (!password.ok) return { ok: false, error: password.error };
    await db.update('crm_users', userId, {
      password_hash: password.hash,
      password_changed_at: clock().toISOString(),
      updated_at: clock().toISOString(),
    });
    await revokeSessionsForUser(userId, 'password_changed');
    await audit?.record({ entity: 'user', entityId: userId, action: 'password_changed', actor: actor?.display_name, summary: 'Contraseña cambiada' });
    return { ok: true };
  }

  async function login(input) {
    const username = usernameOf(input.username);
    const user = username ? await byUsername(username) : null;
    const fakeHash = await hashPassword('fake-password-for-timing');
    const stored = user?.password_hash ?? fakeHash.hash;
    const valid = await verifyPassword(input.password, stored);
    if (!user || user.active === false || !valid) {
      await audit?.record({
        entity: 'auth',
        action: 'login_failure',
        actor: username ?? 'unknown',
        summary: 'Inicio de sesión fallido',
        data: { username: username ?? null, reason: user?.active === false ? 'inactive' : 'invalid' },
      });
      return { ok: false, error: 'invalid_credentials' };
    }
    const session = await createSession(user, input);
    await db.update('crm_users', user.id, { last_login_at: clock().toISOString(), updated_at: clock().toISOString() });
    await audit?.record({
      entity: 'auth',
      entityId: user.id,
      action: 'login_success',
      actor: user.display_name,
      summary: 'Inicio de sesión correcto',
      data: { role: user.role },
    });
    return { ok: true, user: publicUser({ ...user, last_login_at: clock().toISOString() }), session };
  }

  async function createSession(user, input = {}) {
    const at = clock().toISOString();
    const expiresAt = new Date(clock().getTime() + sessionSeconds * 1000).toISOString();
    const session = {
      id: newId('ses'),
      user_id: user.id,
      user_display_name_snapshot: user.display_name,
      role_snapshot: user.role,
      expires_at: expiresAt,
      revoked_at: null,
      ip: short(input.ip, 80),
      user_agent: short(input.userAgent, 240),
      created_at: at,
    };
    await db.insert('crm_sessions', session);
    return session;
  }

  async function sessionUser(sessionId) {
    const session = sessionId ? await db.get('crm_sessions', sessionId) : null;
    if (!session || session.revoked_at || Date.parse(session.expires_at) <= clock().getTime()) return null;
    const user = await db.get('crm_users', session.user_id);
    if (!user || user.active === false) return null;
    return { session, user: publicUser(user), fullUser: user };
  }

  async function revokeSession(sessionId, actor = null) {
    const current = sessionId ? await db.get('crm_sessions', sessionId) : null;
    if (!current || current.revoked_at) return false;
    await db.update('crm_sessions', sessionId, { revoked_at: clock().toISOString() });
    await audit?.record({ entity: 'auth', entityId: current.user_id, action: 'logout', actor: actor?.display_name, summary: 'Sesión cerrada' });
    return true;
  }

  async function revokeSessionsForUser(userId, reason = 'revoked') {
    const sessions = await db.list('crm_sessions', { limit: 5000 });
    const at = clock().toISOString();
    for (const session of sessions.filter((row) => row.user_id === userId && !row.revoked_at)) {
      await db.update('crm_sessions', session.id, { revoked_at: at, revoke_reason: reason });
    }
  }

  return {
    roles: USER_ROLES,
    ensureBootstrapAdmin,
    createUser,
    listUsers,
    updateUser,
    changeOwnPassword,
    login,
    sessionUser,
    revokeSession,
    revokeSessionsForUser,
    get: (id) => db.get('crm_users', id).then(publicUser),
    findByUsername: byUsername,
  };
}
