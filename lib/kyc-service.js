/**
 * KYC providers — Smile Identity & Sumsub (West Africa).
 * Images are streamed to the provider; never persisted in K21 storage.
 */

import crypto from 'crypto';
import { prisma } from './prisma.js';
import { kycSandboxAllowed } from './runtime-safety.js';
import { hashCni, normalizeCniNumber } from './cni-hash.js';
import { secretsEqual } from './field-crypto.js';
import { activatePendingStudentPass } from './moi-service.js';

const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;

const IMAGE_RETENTION_MS = 24 * 60 * 60 * 1000;

function providerName() {
  const p = (process.env.KYC_PROVIDER ?? 'smile_id').toLowerCase();
  return p === 'sumsub' ? 'sumsub' : 'smile_id';
}

function sandboxMode() {
  if (!kycSandboxAllowed()) {
    if (!process.env.KYC_API_KEY) {
      throw new KycError('kyc_unavailable', 'La vérification d’identité est momentanément indisponible. Réessaie plus tard.', 503);
    }
    return false;
  }
  return !process.env.KYC_API_KEY || process.env.NODE_ENV !== 'production';
}

async function submitToSmileId({ userId, frontImage, backImage, selfieImage }) {
  const apiKey = process.env.KYC_API_KEY;
  const baseUrl = process.env.KYC_API_URL ?? 'https://api.smileidentity.com/v1';

  if (sandboxMode() || !apiKey) {
    return {
      externalJobId: `smile-sandbox-${userId}-${Date.now()}`,
      sandbox: true,
    };
  }

  const response = await fetch(`${baseUrl}/document_verification`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      partner_params: { job_id: userId },
      images: [
        { image_type_id: 1, image: frontImage },
        { image_type_id: 2, image: backImage },
        ...(selfieImage ? [{ image_type_id: 0, image: selfieImage }] : []),
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Smile Identity error: ${text}`);
  }

  const data = await response.json();
  return { externalJobId: data.job_id ?? data.SmileJobID, sandbox: false };
}

async function submitToSumsub({ userId, frontImage, backImage, selfieImage }) {
  const apiKey = process.env.KYC_API_KEY;
  const baseUrl = process.env.KYC_API_URL ?? 'https://api.sumsub.com';

  if (sandboxMode() || !apiKey) {
    return {
      externalJobId: `sumsub-sandbox-${userId}-${Date.now()}`,
      sandbox: true,
    };
  }

  const response = await fetch(`${baseUrl}/resources/applicants/-/info`, {
    method: 'POST',
    headers: {
      'X-App-Token': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      externalUserId: userId,
      idDoc: { front: frontImage, back: backImage, selfie: selfieImage },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sumsub error: ${text}`);
  }

  const data = await response.json();
  return { externalJobId: data.id ?? data.applicantId, sandbox: false };
}

export class KycError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'KycError';
  }
}

export async function submitCniVerification(userId, { frontImage, backImage, selfieImage }) {
  if (!frontImage || !backImage) {
    throw new KycError('images_required', 'CNI front and back images required');
  }

  const provider = providerName();
  const submit =
    provider === 'sumsub'
      ? () => submitToSumsub({ userId, frontImage, backImage, selfieImage })
      : () => submitToSmileId({ userId, frontImage, backImage, selfieImage });

  const { externalJobId, sandbox } = await submit();

  const purgeImagesAt = new Date(Date.now() + IMAGE_RETENTION_MS);

  const job = await prisma.$transaction(async (db) => {
    await db.user.update({
      where: { id: userId },
      data: { verificationStatus: 'cni_pending' },
    });

    return db.cniVerificationJob.create({
      data: {
        userId,
        provider,
        externalJobId,
        status: sandbox ? 'processing' : 'pending',
        purgeImagesAt,
      },
    });
  });

  if (sandbox) {
    await completeCniVerification(job.id, {
      approved: true,
      legalName: 'Sandbox User',
      dateOfBirth: '1990-01-01',
      documentNumber: `SN${userId.slice(-8)}`,
    });
  }

  return {
    jobId: job.id,
    status: sandbox ? 'approved' : 'pending',
    provider,
    message: sandbox
      ? 'Vérification CNI simulée — compte passé au Tier 2'
      : 'Vérification en cours — tu seras notifié sous 24h',
  };
}

export async function completeCniVerification(jobId, result) {
  const job = await prisma.cniVerificationJob.findUnique({ where: { id: jobId } });
  if (!job) throw new KycError('not_found', 'Verification job not found');
  if (['approved', 'rejected'].includes(job.status)) return job;

  if (!result.approved) {
    return prisma.$transaction(async (db) => {
      const updated = await db.cniVerificationJob.update({
        where: { id: jobId },
        data: {
          status: 'rejected',
          failureReason: result.reason ?? 'Document verification failed',
          completedAt: new Date(),
          imagesPurgedAt: new Date(),
        },
      });
      await db.user.update({
        where: { id: job.userId },
        data: { verificationStatus: 'phone_only' },
      });
      await db.notification.create({
        data: {
          userId: job.userId,
          title: 'Vérification CNI refusée',
          body: result.reason ?? 'Impossible de vérifier ta CNI. Réessaie avec des photos nettes.',
        },
      });
      return updated;
    });
  }

  const docNumber = result.documentNumber ? normalizeCniNumber(result.documentNumber) : null;
  const docHash = docNumber ? hashCni(docNumber) : result.documentNumberHash ?? null;

  if (docHash) {
    const duplicate = await prisma.user.findFirst({
      where: { cniHash: docHash, NOT: { id: job.userId } },
    });
    if (duplicate) {
      throw new KycError('cni_duplicate', 'This CNI is already linked to another account');
    }
  }

  const dob = result.dateOfBirth ? new Date(result.dateOfBirth) : null;

  return prisma.$transaction(async (db) => {
    const updatedJob = await db.cniVerificationJob.update({
      where: { id: jobId },
      data: {
        status: 'approved',
        verifiedLegalName: result.legalName ?? null,
        verifiedDateOfBirth: dob,
        documentNumberHash: docHash,
        completedAt: new Date(),
        imagesPurgedAt: new Date(),
      },
    });

    await db.user.update({
      where: { id: job.userId },
      data: {
        verificationTier: 2,
        verificationStatus: 'cni_verified',
        cniVerifiedAt: new Date(),
        cniHash: docHash,
        cniNumberEnc: null,
        name: result.legalName ?? undefined,
        dateOfBirth: dob,
      },
    });

    await activatePendingStudentPass(db, job.userId);

    await db.notification.create({
      data: {
        userId: job.userId,
        title: 'CNI vérifiée ✓',
        body: 'Ton compte est maintenant Tier 2 — envois, retraits et transferts internationaux débloqués.',
      },
    });

    return updatedJob;
  });
}

export async function submitAddressVerification(userId, { addressLine, city, region }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.cniVerifiedAt) {
    throw new KycError('cni_required', 'Complete CNI verification before address verification');
  }

  const sandbox = sandboxMode();

  await prisma.user.update({
    where: { id: userId },
    data: {
      verificationTier: sandbox ? 3 : user.verificationTier,
      verificationStatus: sandbox ? 'fully_verified' : 'address_pending',
      addressVerifiedAt: sandbox ? new Date() : null,
      arrondissementName: city ?? user.arrondissementName,
    },
  });

  if (sandbox) {
    await prisma.notification.create({
      data: {
        userId,
        title: 'Adresse vérifiée ✓',
        body: 'Ton compte est Tier 3 — accès complet et comptes professionnels débloqués.',
      },
    });
  }

  return {
    status: sandbox ? 'approved' : 'pending',
    message: sandbox
      ? 'Adresse vérifiée (sandbox) — Tier 3 actif'
      : 'Vérification d’adresse en cours — examen sous 48h',
  };
}

export async function getKycStatus(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      cniVerificationJobs: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  if (!user) throw new KycError('not_found', 'User not found');

  const latestJob = user.cniVerificationJobs[0] ?? null;
  return {
    verificationTier: user.verificationTier,
    verificationStatus: user.verificationStatus,
    cniVerifiedAt: user.cniVerifiedAt?.toISOString() ?? null,
    addressVerifiedAt: user.addressVerifiedAt?.toISOString() ?? null,
    dateOfBirth: user.dateOfBirth?.toISOString().slice(0, 10) ?? null,
    latestCniJob: latestJob
      ? {
          id: latestJob.id,
          status: latestJob.status,
          provider: latestJob.provider,
          submittedAt: latestJob.submittedAt.toISOString(),
          completedAt: latestJob.completedAt?.toISOString() ?? null,
          failureReason: latestJob.failureReason,
        }
      : null,
  };
}

export async function purgeExpiredKycImageMetadata() {
  const now = new Date();
  const due = await prisma.cniVerificationJob.findMany({
    where: {
      imagesPurgedAt: null,
      purgeImagesAt: { lte: now },
    },
  });

  for (const job of due) {
    await prisma.cniVerificationJob.update({
      where: { id: job.id },
      data: { imagesPurgedAt: now },
    });
  }

  return { purged: due.length };
}

/**
 * Smile ID signs callbacks with HMAC-SHA256 keyed on the partner API key,
 * over `timestamp + partner_id + "sid_request"`, base64-encoded, with
 * `signature`/`timestamp` returned as fields in the callback body itself
 * (per Smile ID's SDK "confirm" pattern). This reconstruction is based on
 * secondary documentation (Smile ID's primary signing docs 403'd and their
 * GitHub source 404'd when checked) — CONFIRM against a real Smile ID
 * partner account/SDK before relying on it in production.
 */
export function verifySmileWebhookSignature(body) {
  const apiKey = process.env.KYC_API_KEY;
  const partnerId = process.env.KYC_PARTNER_ID;
  const signature = body?.signature;
  const timestamp = body?.timestamp;
  if (!apiKey || !partnerId || !signature || !timestamp) return false;

  const age = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(age) || age < 0 || age > WEBHOOK_MAX_AGE_MS) return false;

  const expected = crypto
    .createHmac('sha256', apiKey)
    .update(String(timestamp), 'utf8')
    .update(String(partnerId), 'utf8')
    .update('sid_request', 'utf8')
    .digest('base64');

  return secretsEqual(String(signature), expected);
}

const SUMSUB_DIGEST_ALGOS = {
  HMAC_SHA1_HEX: 'sha1',
  HMAC_SHA256_HEX: 'sha256',
  HMAC_SHA512_HEX: 'sha512',
};

/**
 * Sumsub signs webhooks with HMAC over the raw request body, algorithm named
 * in `X-Payload-Digest-Alg` (default HMAC_SHA256_HEX) and the hex digest in
 * `X-Payload-Digest`, using the webhook secret configured in the Sumsub
 * dashboard (KYC_WEBHOOK_SECRET). https://docs.sumsub.com/docs/webhook-manager
 */
export function verifySumsubWebhookSignature(headers, rawBody) {
  const secret = process.env.KYC_WEBHOOK_SECRET;
  const digest = headers?.['x-payload-digest'];
  if (!secret || !digest) return false;

  const algoName = String(headers?.['x-payload-digest-alg'] ?? 'HMAC_SHA256_HEX').toUpperCase();
  const algo = SUMSUB_DIGEST_ALGOS[algoName];
  if (!algo) return false;

  const expected = crypto.createHmac(algo, secret).update(rawBody ?? '', 'utf8').digest('hex');
  return secretsEqual(String(digest), expected);
}

export function parseKycWebhook(provider, body) {
  if (provider === 'smile_id') {
    const approved = body?.result?.ResultCode === '0810' || body?.Actions?.Verify_ID_Number === 'Verified';
    return {
      externalJobId: body?.SmileJobID ?? body?.job_id,
      approved,
      legalName: body?.result?.FullName ?? body?.FullName,
      dateOfBirth: body?.result?.DOB ?? body?.DOB,
      documentNumber: body?.result?.IDNumber ?? body?.IDNumber,
      reason: body?.result?.ResultText,
    };
  }

  if (provider === 'sumsub') {
    const approved = body?.reviewStatus === 'completed' && body?.reviewResult?.reviewAnswer === 'GREEN';
    return {
      externalJobId: body?.applicantId ?? body?.inspectionId,
      approved,
      legalName: body?.info?.firstName
        ? `${body.info.firstName} ${body.info.lastName ?? ''}`.trim()
        : undefined,
      dateOfBirth: body?.info?.dob,
      documentNumber: body?.info?.idDocs?.[0]?.number,
      reason: body?.reviewResult?.moderationComment,
    };
  }

  return null;
}

export async function handleKycWebhook(provider, body) {
  const parsed = parseKycWebhook(provider, body);
  if (!parsed?.externalJobId) return { ok: false, reason: 'unparseable' };

  const job = await prisma.cniVerificationJob.findFirst({
    where: { externalJobId: parsed.externalJobId, provider },
  });
  if (!job) return { ok: false, reason: 'job_not_found' };

  await completeCniVerification(job.id, {
    approved: parsed.approved,
    legalName: parsed.legalName,
    dateOfBirth: parsed.dateOfBirth,
    documentNumber: parsed.documentNumber,
    reason: parsed.reason,
  });

  return { ok: true, jobId: job.id };
}
