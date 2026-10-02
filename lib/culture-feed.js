/**
 * Culture feed — K21-curated sports & culture items stored in Postgres.
 * Seeded on first empty DB; ops can edit rows directly (Studio/admin later).
 */

import { prisma } from './prisma.js';
import { demoContentAllowed } from './runtime-safety.js';

const SEED_BY_COUNTRY = {
  SN: [
    { regionKey: 'senegal', tag: 'Sport', icon: '⚽', title: 'Lions — match à venir', meta: 'AFCON · Dakar · 17h', sortOrder: 0 },
    { regionKey: 'dakar', tag: 'Sport', icon: '🏀', title: 'AS Douanes vs Jaraaf', meta: 'Basket · Dakar Arena · 20h', sortOrder: 1 },
    { regionKey: 'senegal', tag: 'Sport', icon: '🤼', title: 'Gala de Lutte', meta: 'Arène Nationale · 16h', sortOrder: 2 },
    { regionKey: 'dakar', tag: 'Culture', icon: '🎨', title: 'Expo Art Contemporain', meta: 'IFAN · Cette semaine', sortOrder: 3 },
  ],
  US: [
    { regionKey: 'usa', tag: 'Sport', icon: '🏀', title: 'NBA Tonight', meta: 'National TV · 20h ET', sortOrder: 0 },
    { regionKey: 'usa', tag: 'Sport', icon: '🏈', title: 'NFL Highlights', meta: 'This week', sortOrder: 1 },
    { regionKey: 'diaspora', tag: 'Culture', icon: '⚽', title: 'Sénégal diaspora watch parties', meta: 'New York · Atlanta · DC', sortOrder: 2 },
  ],
  FR: [
    { regionKey: 'france', tag: 'Sport', icon: '⚽', title: 'Ligue 1 — week-end', meta: 'Paris · 21h', sortOrder: 0 },
    { regionKey: 'diaspora', tag: 'Culture', icon: '🇸🇳', title: 'Communauté sénégalaise', meta: 'Événements · Paris 18e', sortOrder: 1 },
  ],
};

function shapeItem(row) {
  return {
    id: row.id,
    key: row.id,
    icon: row.icon,
    title: row.title,
    meta: row.meta,
    tag: row.tag,
    region: row.regionKey ?? row.country.toLowerCase(),
  };
}

/** Seed rows are demo content — never written in production. */
async function ensureSeedData(db, country) {
  if (!demoContentAllowed()) return;
  const count = await db.cultureFeedItem.count({ where: { country } });
  if (count > 0) return;
  const seeds = SEED_BY_COUNTRY[country] ?? SEED_BY_COUNTRY.SN;
  for (const seed of seeds) {
    await db.cultureFeedItem.create({ data: { country, ...seed } });
  }
}

function staticItems(country) {
  if (!demoContentAllowed()) return [];
  const seeds = SEED_BY_COUNTRY[country] ?? SEED_BY_COUNTRY.SN;
  return seeds.map((seed, i) =>
    shapeItem({
      id: `seed-${country.toLowerCase()}-${i}`,
      country,
      ...seed,
    }),
  );
}

export async function getCultureFeed({ country = 'SN', query = '' } = {}) {
  const cc = String(country).toUpperCase().slice(0, 2);
  const q = String(query).trim().toLowerCase();

  try {
    await ensureSeedData(prisma, cc);
    const rows = await prisma.cultureFeedItem.findMany({
      where: { country: cc, active: true },
      orderBy: [{ sortOrder: 'asc' }, { publishedAt: 'desc' }],
      take: 40,
    });
    // Older deploys seeded demo items into every DB — hide them in production.
    const seedTitles = new Set(Object.values(SEED_BY_COUNTRY).flat().map((x) => x.title));
    let items = rows.filter((r) => demoContentAllowed() || !seedTitles.has(r.title)).map(shapeItem);
    if (q) {
      items = items.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.meta.toLowerCase().includes(q) ||
          i.tag.toLowerCase().includes(q),
      );
    }
    return {
      country: cc,
      items,
      preview: false,
      source: 'internal',
      message: 'Contenu K21 — mis à jour par l’équipe.',
    };
  } catch (err) {
    console.warn('[culture-feed] DB fallback', err.message);
    let items = staticItems(cc);
    if (q) {
      items = items.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.meta.toLowerCase().includes(q) ||
          i.tag.toLowerCase().includes(q),
      );
    }
    return {
      country: cc,
      items,
      preview: true,
      demo: demoContentAllowed(),
      source: 'fallback',
      message: demoContentAllowed() ? 'Contenu de démonstration.' : 'Contenu indisponible pour le moment.',
    };
  }
}
