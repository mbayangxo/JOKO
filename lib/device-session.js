import { prisma } from './prisma.js';
import { requestGeo } from './geo-ip.js';
import { RISK_LIMITS } from './risk-constants.js';

export async function registerDeviceLogin(userId, req) {
  const geo = requestGeo(req);
  if (!geo.deviceId) {
    return {
      deviceId: null,
      isNewDevice: false,
      devicesLast24h: 0,
      requiresVerification: true,
      flags: ['device_id_missing'],
    };
  }

  const now = new Date();
  const existing = await prisma.userDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId: geo.deviceId } },
  });

  const deviceCount = await prisma.userDevice.count({
    where: { userId, lastSeenAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
  });

  // J4 decision 6: diaspora/local status (and nationality, language, name,
  // neighbourhood) never changes authentication trust. The only location
  // signal is account-relative: a login country THIS account has never used
  // before. It applies identically to every user.
  let newCountry = false;
  if (geo.countryCode) {
    const seen = await prisma.userDevice.count({ where: { userId, countryCode: geo.countryCode } });
    const anyCountry = await prisma.userDevice.count({ where: { userId, countryCode: { not: null } } });
    newCountry = anyCountry > 0 && seen === 0;
  }

  let isNewDevice = false;
  if (existing) {
    await prisma.userDevice.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: now,
        ip: geo.ip,
        countryCode: geo.countryCode,
        deviceName: geo.deviceName ?? existing.deviceName,
      },
    });
  } else {
    isNewDevice = true;
    const priorDevices = await prisma.userDevice.count({ where: { userId } });
    await prisma.userDevice.create({
      data: {
        userId,
        deviceId: geo.deviceId,
        deviceName: geo.deviceName,
        ip: geo.ip,
        countryCode: geo.countryCode,
        verifiedAt: priorDevices === 0 ? now : null,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });
  }

  const devicesLast24h = isNewDevice ? deviceCount + 1 : deviceCount;
  const flags = [];

  if (isNewDevice) flags.push('device_new');
  if (devicesLast24h >= RISK_LIMITS.DEVICES_24H) flags.push('device_multi_24h');
  if (newCountry) flags.push('device_new_country');

  const requiresVerification =
    isNewDevice || newCountry || devicesLast24h >= RISK_LIMITS.DEVICES_24H;

  return {
    deviceId: geo.deviceId,
    isNewDevice,
    devicesLast24h,
    requiresVerification,
    newCountry,
    flags,
  };
}

export async function verifyDeviceWithOtp(userId, deviceId) {
  const device = await prisma.userDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
  });
  if (!device) return null;
  return prisma.userDevice.update({
    where: { id: device.id },
    data: { verifiedAt: new Date(), revokedAt: null, revokedReason: null },
  });
}

export async function assertDeviceVerified(userId, req) {
  const geo = requestGeo(req);
  if (!geo.deviceId) {
    return { ok: false, code: 'device_id_required', message: 'Device identification required' };
  }
  const device = await prisma.userDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId: geo.deviceId } },
  });
  if (!device) {
    return { ok: false, code: 'device_unknown', message: 'Unknown device — please sign in again' };
  }
  if (!device.verifiedAt || device.revokedAt) {
    return {
      ok: false,
      code: 'device_verification_required',
      message: 'Verify this device with OTP before moving money',
    };
  }
  return { ok: true };
}

export async function countDevicesLast24h(userId) {
  return prisma.userDevice.count({
    where: {
      userId,
      lastSeenAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });
}
