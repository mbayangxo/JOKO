#!/usr/bin/env node
/**
 * J3 break-glass operator role management (OFFLINE, database access required).
 *
 *   node scripts/admin-roles.mjs list
 *   node scripts/admin-roles.mjs grant <adminEmail> <role> "<reason ≥ 10 chars>" --break-glass
 *   node scripts/admin-roles.mjs revoke <adminEmail> <role> "<reason ≥ 10 chars>"
 *
 * In-app, a role grant is maker-checker (two sysadmins). This script exists
 * for the first deployment (existing operators hold NO roles after J3) and for
 * emergencies. Every grant is written to AdminRoleGrant + IdentityAuditEvent
 * with actorType "break_glass". It refuses to run against a non-local
 * database unless ALLOW_REMOTE_BREAK_GLASS=true — and must not be run
 * against production without an explicit, recorded decision.
 */
import { PrismaClient } from '@prisma/client';
import { ADMIN_ROLES } from '../lib/authz/catalog.js';
import { grantAdminRole, revokeAdminRole, activeAdminRoles } from '../lib/authz/admin-authz.js';

const [cmd, email, role, reason, flag] = process.argv.slice(2);
const url = process.env.DATABASE_URL ?? '';
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
if (!local && process.env.ALLOW_REMOTE_BREAK_GLASS !== 'true') {
  console.error('Refusing: not a local database (set ALLOW_REMOTE_BREAK_GLASS=true after a recorded decision).');
  process.exit(2);
}
const db = new PrismaClient();
try {
  if (cmd === 'list') {
    for (const a of await db.adminUser.findMany({ orderBy: { createdAt: 'asc' } })) {
      console.log(`${a.email}\t${a.active ? 'active' : 'inactive'}\t${(await activeAdminRoles(a.id, db)).join(',') || '(no roles)'}`);
    }
  } else if (cmd === 'grant' || cmd === 'revoke') {
    if (!ADMIN_ROLES[role]) throw new Error(`role must be one of ${Object.keys(ADMIN_ROLES).join(', ')}`);
    const admin = await db.adminUser.findUnique({ where: { email: String(email).toLowerCase() } });
    if (!admin) throw new Error('operator not found');
    if (cmd === 'grant') {
      if (flag !== '--break-glass') throw new Error('grant requires --break-glass (in-app grants are maker-checker)');
      console.log(await grantAdminRole(db, { adminUserId: admin.id, role, grantedBy: 'break_glass_script', reason, actorType: 'break_glass' }));
    } else {
      console.log(await revokeAdminRole(db, { adminUserId: admin.id, role, revokedBy: 'break_glass_script', reason }));
    }
  } else {
    console.error('usage: list | grant <email> <role> "<reason>" --break-glass | revoke <email> <role> "<reason>"');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
