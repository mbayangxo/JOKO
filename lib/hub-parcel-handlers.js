import { z } from 'zod';
import { prisma } from './prisma.js';
import { validationError } from './validation.js';
import {
  confirmHubParcelPickup,
  getHubParcelDetail,
  hubParcelErrorStatus,
  HubParcelError,
  listOwnerHubParcels,
  markHubParcelArrived,
  markHubParcelInTransit,
  registerHubParcel,
  requestHubParcelLastMile,
  supportedOriginCountries,
} from './hub-parcel-service.js';

function parseCoords(req) {
  const lat = req.query.lat != null ? Number(req.query.lat) : null;
  const lng = req.query.lng != null ? Number(req.query.lng) : null;
  return {
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

export async function hubParcelsOriginCountries(req, res) {
  res.json({ countries: supportedOriginCountries() });
}

export async function hubParcelsMine(req, res) {
  const parcels = await listOwnerHubParcels(prisma, req.userId);
  res.json({ parcels });
}

export async function hubParcelsCreate(req, res) {
  const schema = z.object({
    hubId: z.string().min(1),
    originCountry: z.string().min(2).max(8),
    originLabel: z.string().max(120).optional(),
    description: z.string().min(2).max(300),
    externalRef: z.string().max(120).optional(),
    senderName: z.string().max(80).optional(),
    senderContact: z.string().max(80).optional(),
    fulfillmentPlan: z.enum(['pickup', 'last_mile']).default('pickup'),
    dropoff: z
      .object({
        area: z.string().min(2),
        address: z.string().min(2),
        lat: z.number().optional(),
        lng: z.number().optional(),
      })
      .optional(),
    notes: z.string().max(400).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const parcel = await registerHubParcel(prisma, {
      ownerId: req.userId,
      ...parsed.data,
    });
    res.status(201).json(parcel);
  } catch (error) {
    if (error instanceof HubParcelError) {
      res.status(hubParcelErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function hubParcelGet(req, res) {
  try {
    const parcel = await getHubParcelDetail(prisma, String(req.query.id ?? ''), req.userId);
    res.json(parcel);
  } catch (error) {
    if (error instanceof HubParcelError) {
      res.status(hubParcelErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function hubParcelInTransit(req, res) {
  try {
    const parcel = await markHubParcelInTransit(prisma, String(req.query.id ?? ''), req.userId);
    res.json(parcel);
  } catch (error) {
    if (error instanceof HubParcelError) {
      res.status(hubParcelErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function hubParcelArrive(req, res) {
  // J8.0: authority = operator of the ACTIVE pickup point running this hub (checked in the service).
  try {
    const parcel = await markHubParcelArrived(prisma, String(req.query.id ?? ''), {
      staffUserId: req.userId,
    });
    res.json(parcel);
  } catch (error) {
    if (error instanceof HubParcelError) {
      res.status(hubParcelErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function hubParcelLastMile(req, res) {
  const schema = z.object({
    area: z.string().min(2),
    address: z.string().min(2),
    lat: z.number().optional(),
    lng: z.number().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const parcel = await requestHubParcelLastMile(
      prisma,
      String(req.query.id ?? ''),
      req.userId,
      parsed.data,
    );
    res.status(201).json(parcel);
  } catch (error) {
    if (error instanceof HubParcelError) {
      res.status(hubParcelErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export async function hubParcelConfirmPickup(req, res) {
  const schema = z.object({ pickupCode: z.string().min(4).max(8) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error);

  try {
    const parcel = await confirmHubParcelPickup(
      prisma,
      String(req.query.id ?? ''),
      req.userId,
      parsed.data.pickupCode,
    );
    res.json(parcel);
  } catch (error) {
    if (error instanceof HubParcelError) {
      res.status(hubParcelErrorStatus(error.code)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
}

export { supportedOriginCountries };
