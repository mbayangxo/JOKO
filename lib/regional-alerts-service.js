/**
 * Regional climate & safety alerts — geo-scoped flood, drought, storm warnings.
 * Phase 1: K21-curated alerts in Postgres. External feeds only after API/legal review.
 */

import { prisma } from './prisma.js';
import { demoContentAllowed } from './runtime-safety.js';

const SEED_ALERTS = [
  {
    alertType: 'flood',
    severity: 'urgent',
    title: 'Alerte inondation côtière — Saint-Louis',
    body:
      'Marée haute exceptionnelle prévue demain 6h–14h. Risque de submersion à Guet-Ndar, Pikine et sur la Langue de Barbarie. Niveau estimé +1,2 m au-dessus de la normale.',
    guidance:
      'Déplacez pirogues et équipement vers zone sèche avant ce soir 18h. Évitez la langue de sable. Suivez les consignes des pêcheurs expérimentés et des autorités locales.',
    country: 'SN',
    regionKeys: ['saint-louis'],
    regionLabel: 'Saint-Louis · Guet-Ndar',
    source: 'K21',
    sourceUrl: null,
    featured: true,
    validFrom: new Date(),
    validUntil: new Date(Date.now() + 48 * 3600 * 1000),
  },
  {
    alertType: 'drought',
    severity: 'watch',
    title: 'Sécheresse agricole — Kaolack & Fatick',
    body:
      'Pluviométrie inférieure de 40 % à la moyenne sur 30 jours. Stress hydrique sur cultures d\'arachide et élevage. Surveillance renforcée des points d\'eau.',
    guidance:
      'Priorisez l\'irrigation des parcelles sensibles. Signalez ruptures de forage via K21 Mouvement pour coordination locale.',
    country: 'SN',
    regionKeys: ['kaolack', 'national'],
    regionLabel: 'Kaolack · Saloum',
    source: 'K21',
    sourceUrl: null,
    featured: false,
    validFrom: new Date(Date.now() - 12 * 3600 * 1000),
    validUntil: new Date(Date.now() + 14 * 24 * 3600 * 1000),
  },
  {
    alertType: 'climate',
    severity: 'info',
    title: 'Canicule — Dakar & banlieue',
    body:
      'Températures max 38–40 °C prévues sur 3 jours. Indice UV très élevé entre 11h et 16h.',
    guidance:
      'Hydratez-vous, évitez l\'effort en plein soleil. Vérifiez les personnes âgées dans votre quartier.',
    country: 'SN',
    regionKeys: ['medina', 'plateau', 'pikine', 'guediawaye', 'yoff', 'ouakam', 'almadies', 'hlm', 'parcelles', 'national'],
    regionLabel: 'Dakar · Région',
    source: 'K21',
    sourceUrl: null,
    featured: false,
    validFrom: new Date(),
    validUntil: new Date(Date.now() + 72 * 3600 * 1000),
  },
];

const SEED_ARTICLES = [
  {
    category: 'news',
    title: 'Macky Sall annonce une nouvelle politique économique',
    excerpt: 'Mesures ciblées sur l\'emploi des jeunes et l\'accès au crédit agricole.',
    source: 'RFI',
    country: 'SN',
    regionKeys: ['national'],
    trendScore: 8400,
    publishedAt: new Date(Date.now() - 2 * 3600 * 1000),
  },
  {
    category: 'news',
    title: 'Lions de la Teranga : convocations CAN 2026',
    excerpt: 'Liste provisoire publiée — 5 joueurs locaux retenus.',
    source: 'wiwsport',
    country: 'SN',
    regionKeys: ['national'],
    trendScore: 6200,
    publishedAt: new Date(Date.now() - 4 * 3600 * 1000),
  },
  {
    category: 'cause',
    title: 'Wifi gratuit dans tous les campus universitaires du Sénégal',
    excerpt: 'Pétition UCAD — connectivité étudiante et accès aux ressources numériques.',
    source: 'K21 Causes',
    country: 'SN',
    regionKeys: ['medina', 'plateau', 'national'],
    signatureTarget: 100000,
    signatureCount: 73200,
    trendScore: 73200,
    publishedAt: new Date(Date.now() - 24 * 3600 * 1000),
  },
  {
    category: 'cause',
    title: 'Protection mangrove — Saloum & Casamance',
    excerpt: 'Restauration des barrières naturelles contre l\'érosion côtière.',
    source: 'K21 Causes',
    country: 'SN',
    regionKeys: ['ziguinchor', 'saint-louis', 'national'],
    signatureTarget: 50000,
    signatureCount: 18400,
    trendScore: 18400,
    publishedAt: new Date(Date.now() - 36 * 3600 * 1000),
  },
];

function alertMatchesRegion(alert, { country, regionKey }) {
  if (alert.country !== country) return false;
  const keys = alert.regionKeys ?? [];
  if (keys.includes('national')) return true;
  if (!regionKey) return keys.includes('national');
  return keys.includes(regionKey);
}

function articleMatchesRegion(article, { country, regionKey }) {
  if (article.country !== country) return false;
  const keys = article.regionKeys ?? [];
  if (!keys.length || keys.includes('national')) return true;
  if (!regionKey) return true;
  return keys.includes(regionKey);
}

function isActive(alert, now = new Date()) {
  if (alert.validFrom && new Date(alert.validFrom) > now) return false;
  if (alert.validUntil && new Date(alert.validUntil) < now) return false;
  return true;
}

function shapeAlert(row, readIds = new Set()) {
  return {
    id: row.id,
    alertType: row.alertType,
    severity: row.severity,
    title: row.title,
    body: row.body,
    guidance: row.guidance ?? null,
    country: row.country,
    regionKeys: row.regionKeys,
    regionLabel: row.regionLabel,
    source: row.source,
    sourceUrl: row.sourceUrl ?? null,
    validFrom: row.validFrom?.toISOString?.() ?? row.validFrom,
    validUntil: row.validUntil?.toISOString?.() ?? row.validUntil ?? null,
    featured: Boolean(row.featured),
    publishedAt: row.publishedAt?.toISOString?.() ?? row.publishedAt,
    read: readIds.has(row.id),
    live: row.severity === 'urgent' || row.severity === 'watch',
  };
}

function shapeArticle(row) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    excerpt: row.excerpt,
    body: row.body ?? null,
    source: row.source,
    sourceUrl: row.sourceUrl ?? null,
    country: row.country,
    regionKeys: row.regionKeys ?? [],
    signatureTarget: row.signatureTarget ?? null,
    signatureCount: row.signatureCount ?? 0,
    trendScore: row.trendScore ?? 0,
    publishedAt: row.publishedAt?.toISOString?.() ?? row.publishedAt,
  };
}

/**
 * Rows previously written from the demo seeds (older deploys seeded them into
 * every database). In production they are filtered out by content fingerprint
 * so stale demo "alerts" never reach users — without deleting any data.
 */
const SEED_ALERT_TITLES = new Set(SEED_ALERTS.map((a) => a.title));
const SEED_ARTICLE_TITLES = new Set(SEED_ARTICLES.map((a) => a.title));
const isRealAlert = (row) => demoContentAllowed() || !SEED_ALERT_TITLES.has(row.title);
const isRealArticle = (row) => demoContentAllowed() || !SEED_ARTICLE_TITLES.has(row.title);

/**
 * Seeded alerts/articles are DEMO content (fixed texts with validity windows
 * computed from "now", so they always look current). They are never written
 * or served in production — fake emergency alerts must not masquerade as live.
 */
async function ensureSeedData(db) {
  if (!demoContentAllowed()) return;
  const alertCount = await db.regionalAlert.count();
  if (alertCount === 0) {
    for (const seed of SEED_ALERTS) {
      await db.regionalAlert.create({ data: seed });
    }
  }
  const articleCount = await db.trendingArticle.count();
  if (articleCount === 0) {
    for (const seed of SEED_ARTICLES) {
      await db.trendingArticle.create({ data: seed });
    }
  }
}

function staticAlertsForRegion(ctx) {
  if (!demoContentAllowed()) return [];
  return SEED_ALERTS.filter((a) => alertMatchesRegion(a, ctx) && isActive(a)).map((a, i) =>
    shapeAlert({ ...a, id: `seed-alert-${i}`, publishedAt: a.validFrom }),
  );
}

function staticArticlesForRegion(ctx, category) {
  if (!demoContentAllowed()) return [];
  return SEED_ARTICLES.filter((a) => {
    if (category && category !== 'all' && a.category !== category) return false;
    return articleMatchesRegion(a, ctx);
  }).map((a, i) => shapeArticle({ ...a, id: `seed-article-${i}` }));
}

export async function getUserRegionContext(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { country: true, arrondissementKey: true, arrondissementName: true },
  });
  return {
    country: user?.country ?? 'SN',
    regionKey: user?.arrondissementKey ?? null,
    regionName: user?.arrondissementName ?? null,
  };
}

export async function listRegionalAlerts(userId, { severity } = {}) {
  const ctx = await getUserRegionContext(userId);
  try {
    await ensureSeedData(prisma);
    const [rows, reads] = await Promise.all([
      prisma.regionalAlert.findMany({
        where: { country: ctx.country },
        orderBy: [{ featured: 'desc' }, { publishedAt: 'desc' }],
        take: 50,
      }),
      prisma.alertRead.findMany({
        where: { userId },
        select: { alertId: true },
      }),
    ]);
    const readIds = new Set(reads.map((r) => r.alertId));
    let alerts = rows
      .filter((a) => isRealAlert(a) && alertMatchesRegion(a, ctx) && isActive(a))
      .map((a) => shapeAlert(a, readIds));
    if (severity) alerts = alerts.filter((a) => a.severity === severity);
    return { region: ctx, alerts };
  } catch (err) {
    console.warn('[regional-alerts] DB fallback', err.message);
    let alerts = staticAlertsForRegion(ctx);
    if (severity) alerts = alerts.filter((a) => a.severity === severity);
    return { region: ctx, alerts, preview: true };
  }
}

export async function getRegionalAlert(userId, alertId) {
  const ctx = await getUserRegionContext(userId);
  try {
    await ensureSeedData(prisma);
    const row = await prisma.regionalAlert.findUnique({ where: { id: alertId } });
    if (!row || !isRealAlert(row) || !alertMatchesRegion(row, ctx)) return null;
    const read = await prisma.alertRead.findUnique({
      where: { userId_alertId: { userId, alertId } },
    });
    return shapeAlert(row, new Set(read ? [alertId] : []));
  } catch {
    if (!demoContentAllowed()) return null;
    const idx = Number(String(alertId).replace('seed-alert-', ''));
    const seed = SEED_ALERTS[idx];
    if (!seed || !alertMatchesRegion(seed, ctx)) return null;
    return shapeAlert({ ...seed, id: alertId, publishedAt: seed.validFrom });
  }
}

export async function markAlertRead(userId, alertId) {
  try {
    const alert = await prisma.regionalAlert.findUnique({ where: { id: alertId } });
    if (!alert) return null;
    await prisma.alertRead.upsert({
      where: { userId_alertId: { userId, alertId } },
      create: { userId, alertId },
      update: { readAt: new Date() },
    });
    return { ok: true };
  } catch {
    return { ok: true, preview: true };
  }
}

export async function listTrendingArticles(userId, { category } = {}) {
  const ctx = await getUserRegionContext(userId);
  try {
    await ensureSeedData(prisma);
    const rows = await prisma.trendingArticle.findMany({
      where: {
        country: ctx.country,
        ...(category && category !== 'all' ? { category } : {}),
      },
      orderBy: [{ trendScore: 'desc' }, { publishedAt: 'desc' }],
      take: 40,
    });
    return {
      region: ctx,
      articles: rows.filter((a) => isRealArticle(a) && articleMatchesRegion(a, ctx)).map(shapeArticle),
    };
  } catch (err) {
    console.warn('[trending-articles] DB fallback', err.message);
    return {
      region: ctx,
      articles: staticArticlesForRegion(ctx, category),
      preview: true,
    };
  }
}

export async function notifyUsersForAlert(alertId) {
  const alert = await prisma.regionalAlert.findUnique({ where: { id: alertId } });
  if (!alert || !isActive(alert)) return { notified: 0 };

  const keys = alert.regionKeys.filter((k) => k !== 'national');
  const users = await prisma.user.findMany({
    where: {
      country: alert.country,
      ...(alert.regionKeys.includes('national')
        ? {}
        : keys.length
          ? { arrondissementKey: { in: keys } }
          : { id: '__none__' }),
    },
    select: { id: true, arrondissementKey: true, smsAlertsEnabled: true, phone: true },
    take: 5000,
  });

  let notified = 0;
  for (const user of users) {
    if (!alertMatchesRegion(alert, { country: alert.country, regionKey: user.arrondissementKey })) continue;
    const existing = await prisma.notification.findFirst({
      where: { userId: user.id, kind: 'alert', refId: alert.id },
    });
    if (existing) continue;

    await prisma.notification.create({
      data: {
        userId: user.id,
        kind: 'alert',
        refId: alert.id,
        actionLabel: 'Voir',
        title: alert.severity === 'urgent' ? `Alerte — ${alert.title}` : alert.title,
        body: alert.body.slice(0, 280),
      },
    });
    notified += 1;
  }
  return { notified };
}

export async function syncAlertNotificationsForUser(userId) {
  const { alerts } = await listRegionalAlerts(userId);
  const urgent = alerts.filter((a) => a.severity === 'urgent' && !a.read);
  let created = 0;
  for (const alert of urgent) {
    if (String(alert.id).startsWith('seed-alert-')) continue;
    const existing = await prisma.notification.findFirst({
      where: { userId, kind: 'alert', refId: alert.id },
    });
    if (existing) continue;
    await prisma.notification.create({
      data: {
        userId,
        kind: 'alert',
        refId: alert.id,
        actionLabel: 'Voir',
        title: `Alerte — ${alert.title}`,
        body: alert.body.slice(0, 280),
      },
    });
    created += 1;
  }
  return { created };
}

export function buildAlertShareMessage(alert, regionName) {
  const lines = [
    `Alerte K21 — ${alert.title}`,
    alert.regionLabel ?? regionName ?? '',
    '',
    alert.body,
    alert.guidance ? `\n${alert.guidance}` : '',
    '',
    `Source : ${alert.source}`,
    'Partagé via K21 — reste informé·e dans ta région.',
  ];
  return lines.filter((l) => l !== undefined).join('\n').trim();
}
