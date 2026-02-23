const crypto = require("crypto");
const AuthUser = require("../models/AuthUser");

const TOKEN_TTL_SECONDS = Number(process.env.AUTH_TOKEN_TTL_SECONDS || 8 * 60 * 60);
const AUTH_SECRET =
  process.env.AUTH_SECRET || process.env.QR_SECRET_KEY || "change-me-auth-secret";

function toBase64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function sign(unsignedToken) {
  return crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(unsignedToken)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createAuthToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const institutionId =
    user?.institutionId && typeof user.institutionId === "object"
      ? String(user.institutionId._id || user.institutionId)
      : user?.institutionId
      ? String(user.institutionId)
      : null;
  const payload = {
    sub: String(user._id),
    role: user.role,
    email: user.email,
    institutionId,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  const headerPart = toBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadPart = toBase64Url(JSON.stringify(payload));
  const unsignedToken = `${headerPart}.${payloadPart}`;
  const signature = sign(unsignedToken);
  return `${unsignedToken}.${signature}`;
}

function verifyAuthToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid token format");
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  const unsignedToken = `${headerPart}.${payloadPart}`;
  const expectedSignature = sign(unsignedToken);

  if (signaturePart.length !== expectedSignature.length) {
    throw new Error("Invalid token signature");
  }

  const providedSignatureBuffer = Buffer.from(signaturePart);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);

  if (!crypto.timingSafeEqual(providedSignatureBuffer, expectedSignatureBuffer)) {
    throw new Error("Invalid token signature");
  }

  const payload = JSON.parse(fromBase64Url(payloadPart));
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) {
    throw new Error("Token expired");
  }

  return payload;
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice("Bearer ".length).trim();
}

async function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({
        status: "error",
        message: "Missing bearer token",
      });
    }

    const payload = verifyAuthToken(token);
    const user = await AuthUser.findById(payload.sub).select(
      "name email role institutionId isActive lastLoginAt createdAt updatedAt"
    );

    if (!user || !user.isActive) {
      return res.status(401).json({
        status: "error",
        message: "Invalid or inactive user",
      });
    }

    req.authUser = user;
    req.authTokenPayload = payload;
    return next();
  } catch (error) {
    return res.status(401).json({
      status: "error",
      message: error.message || "Unauthorized",
    });
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.authUser) {
      return res.status(401).json({
        status: "error",
        message: "Unauthorized",
      });
    }

    if (!roles.includes(req.authUser.role)) {
      return res.status(403).json({
        status: "error",
        message: "Insufficient permissions",
      });
    }

    return next();
  };
}

module.exports = {
  createAuthToken,
  verifyAuthToken,
  requireAuth,
  requireRoles,
};
