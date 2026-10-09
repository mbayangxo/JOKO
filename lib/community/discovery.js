import { prisma } from '../prisma.js';
import { CommunityError } from './errors.js';

/**
 * J10-S7 privacy-safe discovery and S6 neighbourhood.
 *  - Phone lookup (P2P recipient search) respects the person's `discoverableByPhone` setting
 *    (everyone | connections | nobody) and answers exactly like "not found" when hidden.
 *    Phone lookups are budgeted (30 / hour / searcher) so the endpoint is not an enumeration oracle.
 *  - Contact matching is consent-only: the app sends SHA-256 hashes of E.164 numbers from the
 *    person's own address book (≤ 200 per call, ≤ 1 000 per day); only people discoverable to the
 *    searcher are returned, with minimal identity and never the number itself.
 *  - Neighbourhood: real VERIFIED, active businesses in the person's arrondissement, and people who
 *    opted in (`neighbourhoodVisible`), excluding blocks both ways. No ranking, no counters.
 */
const LOOKUPS_PER_HOUR = 30;
const MATCH_PER_CALL = 200;
const MATCH_PER_DAY = 1000;
const hidden = () => new CommunityError('not_found', 'Personne introuvable sur K21', 404);

async function budget(key, windowMs, units, max, message) {
  const { hitBucket } = await import('../request-limits.js');
  if ((await hitBucket(key, windowMs, units)) > max) throw new CommunityError('lookup_limit', message, 429);
}

async function areConnected(aId, bId) {
  return Boolean(await prisma.userFriend.findFirst({ where: { userId: aId, friendId: bId } }));
}
async function blockedEitherWay(aId, bId) {
  return Boolean(await prisma.userBlock.findFirst({ where: { OR: [{ blockerId: aId, blockedUserId: bId }, { blockerId: bId, blockedUserId: aId }] } }));
}

/** May `viewerId` find `target` by phone number? */
export async function discoverableByPhone(viewerId, target) {
  const s = await prisma.communitySettings.findUnique({ where: { userId: target.id }, select: { discoverableByPhone: true } });
  const mode = s?.discoverableByPhone ?? 'everyone';
  if (mode === 'nobody') return false;
  if (await blockedEitherWay(viewerId, target.id)) return false;
  if (mode === 'connections') return areConnected(target.id, viewerId);
  return true;
}

/** Called by the P2P phone lookup before revealing anyone. Throws the same 404 as "not found". */
export async function guardPhoneLookup(viewerId, target) {
  await budget(`phone-lookup:${viewerId}`, 3600_000, 1, LOOKUPS_PER_HOUR, 'Trop de recherches par numéro — réessaie dans une heure ou cherche par @pseudo');
  if (!target || !(await discoverableByPhone(viewerId, target))) throw hidden();
}

export async function matchContacts(viewerId, hashes) {
  const list = [...new Set(hashes.map((h) => String(h).toLowerCase()))].filter((h) => /^[a-f0-9]{64}$/.test(h));
  if (list.length > MATCH_PER_CALL) throw new CommunityError('invalid', `${MATCH_PER_CALL} contacts maximum par envoi`, 400);
  await budget(`contact-match:${viewerId}`, 86_400_000, Math.max(list.length, 1), MATCH_PER_DAY, 'Limite quotidienne de recherche de contacts atteinte');
  if (!list.length) return { matches: [] };
  const rows = await prisma.$queryRaw`
    SELECT id, name, handle, "avatarEmoji" FROM "User"
     WHERE phone IS NOT NULL AND encode(sha256(convert_to(phone, 'UTF8')), 'hex') = ANY(${list}::text[]) AND id <> ${viewerId}
     LIMIT ${MATCH_PER_CALL}`;
  const out = [];
  for (const u of rows) {
    if (!(await discoverableByPhone(viewerId, u))) continue;
    out.push({ userId: u.id, firstName: u.name?.split(' ')[0] ?? null, handle: u.handle, avatarEmoji: u.avatarEmoji, connected: await areConnected(viewerId, u.id) });
  }
  return { matches: out };
}

export async function neighbourhood(viewerId) {
  const me = await prisma.user.findUnique({ where: { id: viewerId }, select: { arrondissementKey: true, arrondissementName: true } });
  const keys = [me?.arrondissementKey, me?.arrondissementName].filter(Boolean);
  if (!keys.length) return { area: null, businesses: [], people: [], hint: 'Choisis ton quartier dans ton profil' };
  const area = { mode: 'insensitive', in: keys };
  const blocks = await prisma.userBlock.findMany({ where: { OR: [{ blockerId: viewerId }, { blockedUserId: viewerId }] }, select: { blockerId: true, blockedUserId: true, blockedBusinessId: true } });
  const blockedUsers = new Set(blocks.flatMap((b) => [b.blockerId, b.blockedUserId]).filter((x) => x && x !== viewerId));
  const blockedBiz = new Set(blocks.map((b) => b.blockedBusinessId).filter(Boolean));
  const [biz, settings] = await Promise.all([
    prisma.business.findMany({ where: { verificationStatus: 'verified', status: 'active', arrondissement: { in: keys, mode: 'insensitive' } }, orderBy: { name: 'asc' }, take: 50, select: { id: true, name: true, type: true, category: true, arrondissement: true } }),
    prisma.communitySettings.findMany({ where: { neighbourhoodVisible: true }, select: { userId: true }, take: 2000 }),
  ]);
  const optedIn = settings.map((s) => s.userId).filter((id) => id !== viewerId && !blockedUsers.has(id));
  const people = optedIn.length
    ? await prisma.user.findMany({ where: { id: { in: optedIn }, OR: [{ arrondissementKey: area }, { arrondissementName: area }] }, take: 30, select: { id: true, name: true, handle: true, avatarEmoji: true } })
    : [];
  return {
    area: me.arrondissementName ?? me.arrondissementKey,
    businesses: biz.filter((b) => !blockedBiz.has(b.id)).map((b) => ({ id: b.id, name: b.name, type: b.type, category: b.category })),
    people: people.map((p) => ({ userId: p.id, firstName: p.name?.split(' ')[0] ?? null, handle: p.handle, avatarEmoji: p.avatarEmoji })),
  };
}
