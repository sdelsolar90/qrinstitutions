const express = require("express");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const AuthUser = require("../models/AuthUser");
const Institution = require("../models/Institution");
const { createAuthToken, requireAuth, requireRoles } = require("../middleware/auth");
const {
  normalizeInstitutionId,
  getAuthInstitutionId,
  resolveInstitutionIdForRequest,
  mapInstitution,
} = require("../middleware/institution");

const router = express.Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const PASSWORD_HASH_ROUNDS = 12;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const INSTITUTION_LOGO_DIR =
  process.env.INSTITUTION_LOGO_DIR || path.join(__dirname, "../../frontend/public/institution-logos");
const INSTITUTION_TYPES = new Set(["university", "school", "college", "institute", "other"]);
const TERM_SYSTEMS = new Set(["semester", "trimester", "quarter", "annual", "other"]);
const INSTITUTION_SELECT_FIELDS = [
  "name",
  "code",
  "shortName",
  "type",
  "logoUrl",
  "website",
  "contactEmail",
  "contactPhone",
  "country",
  "state",
  "city",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "timezone",
  "termSystem",
  "academicYearLabel",
  "gradingScale",
  "isActive",
  "createdAt",
  "updatedAt",
].join(" ");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePagination(query, { defaultLimit = 50, maxLimit = 500 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const requestedLimit = Number.parseInt(query.limit, 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), maxLimit)
    : defaultLimit;

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

function sanitizeUser(userDoc) {
  const institutionId =
    userDoc?.institutionId && typeof userDoc.institutionId === "object"
      ? String(userDoc.institutionId._id || userDoc.institutionId)
      : userDoc?.institutionId
      ? String(userDoc.institutionId)
      : null;
  const institution =
    userDoc?.institutionId &&
    typeof userDoc.institutionId === "object" &&
    userDoc.institutionId?.name
      ? mapInstitution(userDoc.institutionId)
      : null;

  return {
    id: String(userDoc._id),
    name: userDoc.name,
    email: userDoc.email,
    role: userDoc.role,
    institutionId,
    institution,
    isActive: userDoc.isActive,
    lastLoginAt: userDoc.lastLoginAt,
    createdAt: userDoc.createdAt,
    updatedAt: userDoc.updatedAt,
  };
}

function validateCredentials({ name, email, password, requireName = false }) {
  const normalizedEmail = normalizeEmail(email);

  if (requireName && !String(name || "").trim()) {
    return "Name is required";
  }
  if (!normalizedEmail || !EMAIL_PATTERN.test(normalizedEmail)) {
    return "A valid email is required";
  }
  if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

function toInstitutionCode(rawCode, fallbackName) {
  const source = String(rawCode || fallbackName || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  const compact = source.slice(0, 20);
  if (compact.length >= 3) return compact;

  const fallback = String(fallbackName || "INSTITUTION")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 12);

  if (fallback.length >= 3) return fallback;
  return "INST";
}

function ensureInstitutionLogoDir() {
  if (!fs.existsSync(INSTITUTION_LOGO_DIR)) {
    fs.mkdirSync(INSTITUTION_LOGO_DIR, { recursive: true });
  }
}

function parseImageDataUrl(dataUrl) {
  const raw = String(dataUrl || "");
  const match = raw.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) {
    const error = new Error("Invalid image format. Use PNG, JPEG or WEBP.");
    error.status = 400;
    throw error;
  }

  const mimeType = String(match[1]).toLowerCase();
  const base64Payload = match[2];
  const buffer = Buffer.from(base64Payload, "base64");
  if (!buffer.length) {
    const error = new Error("Logo image is empty");
    error.status = 400;
    throw error;
  }
  if (buffer.length > MAX_LOGO_BYTES) {
    const error = new Error("Logo image exceeds 2MB limit");
    error.status = 400;
    throw error;
  }

  const extensionMap = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
  };
  const ext = extensionMap[mimeType] || "png";
  return { buffer, ext };
}

function isGlobalInstitutionRole(role) {
  return role === "superadmin" || role === "admin";
}

function canManageInstitution(authUser, institutionId) {
  const ownInstitutionId = normalizeInstitutionId(getAuthInstitutionId(authUser));
  return isGlobalInstitutionRole(authUser?.role) || institutionId === ownInstitutionId;
}

function isInstitutionAdminRole(role) {
  return role === "institution_admin";
}

function isInstitutionManager(role) {
  return isGlobalInstitutionRole(role) || isInstitutionAdminRole(role);
}

function isTruthyFlag(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function canUseAllInstitutionsScope(req) {
  if (!isGlobalInstitutionRole(req?.authUser?.role)) return false;
  return isTruthyFlag(req?.query?.includeAll);
}

function toOptionalText(value, { max = 180, uppercase = false, lowercase = false } = {}) {
  const raw = String(value ?? "").trim();
  const sliced = raw.slice(0, max);
  if (uppercase) return sliced.toUpperCase();
  if (lowercase) return sliced.toLowerCase();
  return sliced;
}

function toInstitutionType(value) {
  const normalized = toOptionalText(value, { max: 30, lowercase: true });
  if (!normalized) return "university";
  if (INSTITUTION_TYPES.has(normalized)) return normalized;
  return "other";
}

function toTermSystem(value) {
  const normalized = toOptionalText(value, { max: 30, lowercase: true });
  if (!normalized) return "semester";
  if (TERM_SYSTEMS.has(normalized)) return normalized;
  return "other";
}

function buildInstitutionPayload(body, { includeDefaults = false } = {}) {
  const payload = {};

  if (includeDefaults || body.shortName !== undefined) {
    payload.shortName = toOptionalText(body.shortName, { max: 80 });
  }
  if (includeDefaults || body.type !== undefined) {
    payload.type = toInstitutionType(body.type);
  }
  if (includeDefaults || body.logoUrl !== undefined) {
    payload.logoUrl = toOptionalText(body.logoUrl, { max: 600 });
  }
  if (includeDefaults || body.website !== undefined) {
    payload.website = toOptionalText(body.website, { max: 300 });
  }
  if (includeDefaults || body.contactEmail !== undefined) {
    payload.contactEmail = toOptionalText(body.contactEmail, { max: 180, lowercase: true });
  }
  if (includeDefaults || body.contactPhone !== undefined) {
    payload.contactPhone = toOptionalText(body.contactPhone, { max: 80 });
  }
  if (includeDefaults || body.country !== undefined) {
    payload.country = toOptionalText(body.country, { max: 120 });
  }
  if (includeDefaults || body.state !== undefined) {
    payload.state = toOptionalText(body.state, { max: 120 });
  }
  if (includeDefaults || body.city !== undefined) {
    payload.city = toOptionalText(body.city, { max: 120 });
  }
  if (includeDefaults || body.addressLine1 !== undefined) {
    payload.addressLine1 = toOptionalText(body.addressLine1, { max: 180 });
  }
  if (includeDefaults || body.addressLine2 !== undefined) {
    payload.addressLine2 = toOptionalText(body.addressLine2, { max: 180 });
  }
  if (includeDefaults || body.postalCode !== undefined) {
    payload.postalCode = toOptionalText(body.postalCode, { max: 40, uppercase: true });
  }
  if (includeDefaults || body.timezone !== undefined) {
    payload.timezone = toOptionalText(body.timezone, { max: 80 }) || "UTC";
  }
  if (includeDefaults || body.termSystem !== undefined) {
    payload.termSystem = toTermSystem(body.termSystem);
  }
  if (includeDefaults || body.academicYearLabel !== undefined) {
    payload.academicYearLabel = toOptionalText(body.academicYearLabel, { max: 60 });
  }
  if (includeDefaults || body.gradingScale !== undefined) {
    payload.gradingScale = toOptionalText(body.gradingScale, { max: 80 });
  }
  if (includeDefaults || body.isActive !== undefined) {
    payload.isActive = body.isActive !== false;
  }

  return payload;
}

router.get("/bootstrap-status", async (req, res) => {
  try {
    const [userCount, institutionCount] = await Promise.all([
      AuthUser.countDocuments(),
      Institution.countDocuments(),
    ]);
    return res.json({
      status: "success",
      needsBootstrap: userCount === 0,
      institutions: institutionCount,
    });
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

router.post("/bootstrap-superadmin", async (req, res) => {
  try {
    const validationError = validateCredentials({
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      requireName: true,
    });
    if (validationError) {
      return res.status(400).json({ status: "error", message: validationError });
    }

    const existingCount = await AuthUser.countDocuments();
    if (existingCount > 0) {
      return res.status(409).json({
        status: "error",
        message: "Bootstrap already completed",
      });
    }

    const institutionName = String(req.body.institutionName || "").trim() || "Main Institution";
    const institutionCode = toInstitutionCode(req.body.institutionCode, institutionName);
    let institution =
      (await Institution.findOne({
        $or: [{ code: institutionCode }, { name: institutionName }],
      }).select("_id name code isActive")) || null;
    if (!institution) {
      institution = await Institution.create({
        name: institutionName,
        code: institutionCode,
        isActive: true,
        createdBy: null,
      });
    }

    const email = normalizeEmail(req.body.email);
    const passwordHash = await bcrypt.hash(String(req.body.password), PASSWORD_HASH_ROUNDS);

    const user = await AuthUser.create({
      name: String(req.body.name).trim(),
      email,
      passwordHash,
      role: "superadmin",
      institutionId: institution._id,
      isActive: true,
      lastLoginAt: new Date(),
    });

    const token = createAuthToken(user);
    return res.status(201).json({
      status: "success",
      message: "Superadmin created",
      token,
      user: sanitizeUser(user),
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        status: "error",
        message: "Email or institution already exists",
      });
    }
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

router.post("/login", async (req, res) => {
  try {
    const validationError = validateCredentials({
      email: req.body.email,
      password: req.body.password,
      requireName: false,
    });
    if (validationError) {
      return res.status(400).json({ status: "error", message: validationError });
    }

    const email = normalizeEmail(req.body.email);
    const user = await AuthUser.findOne({ email })
      .select("+passwordHash")
      .populate("institutionId", INSTITUTION_SELECT_FIELDS);

    if (!user || !user.isActive) {
      return res.status(401).json({
        status: "error",
        message: "Invalid credentials",
      });
    }

    const isValidPassword = await bcrypt.compare(String(req.body.password), user.passwordHash);
    if (!isValidPassword) {
      return res.status(401).json({
        status: "error",
        message: "Invalid credentials",
      });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = createAuthToken(user);
    return res.json({
      status: "success",
      token,
      user: sanitizeUser(user),
    });
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

router.get("/me", requireAuth, (req, res) => {
  return AuthUser.findById(req.authUser._id)
    .populate("institutionId", INSTITUTION_SELECT_FIELDS)
    .then((freshUser) =>
      res.json({
        status: "success",
        user: sanitizeUser(freshUser || req.authUser),
      })
    )
    .catch((error) =>
      res.status(500).json({
        status: "error",
        message: error.message,
      })
    );
});

router.get(
  "/institutions",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin", "institution_user", "teacher"),
  async (req, res) => {
    try {
      const activeParam = String(req.query.active || "").toLowerCase();
      const filter = {};
      if (activeParam === "true") filter.isActive = true;
      if (activeParam === "false") filter.isActive = false;

      if (!isGlobalInstitutionRole(req.authUser.role)) {
        const userInstitutionId = normalizeInstitutionId(getAuthInstitutionId(req.authUser));
        if (!userInstitutionId) {
          return res.status(403).json({
            status: "error",
            message: "Your account is not assigned to an institution",
          });
        }
        filter._id = userInstitutionId;
      }

      const rows = await Institution.find(filter)
        .sort({ name: 1 })
        .select(INSTITUTION_SELECT_FIELDS);

      return res.json({
        status: "success",
        data: rows.map(mapInstitution),
      });
    } catch (error) {
      return res.status(500).json({
        status: "error",
        message: error.message,
      });
    }
  }
);

router.post(
  "/institutions",
  requireAuth,
  requireRoles("superadmin", "admin"),
  async (req, res) => {
    try {
      const name = String(req.body.name || "").trim();
      if (!name) {
        return res.status(400).json({
          status: "error",
          message: "Institution name is required",
        });
      }

      const code = toInstitutionCode(req.body.code, name);
      const payload = buildInstitutionPayload(req.body, { includeDefaults: true });
      const institution = await Institution.create({
        name,
        code,
        ...payload,
        createdBy: req.authUser._id,
      });

      return res.status(201).json({
        status: "success",
        message: "Institution created",
        data: mapInstitution(institution),
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({
          status: "error",
          message: "Institution name or code already exists",
        });
      }
      return res.status(500).json({
        status: "error",
        message: error.message,
      });
    }
  }
);

router.patch(
  "/institutions/:id",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin"),
  async (req, res) => {
    try {
      const institutionId = String(req.params.id || "").trim();
      if (!mongoose.Types.ObjectId.isValid(institutionId)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid institution id",
        });
      }

      if (!canManageInstitution(req.authUser, institutionId)) {
        return res.status(403).json({
          status: "error",
          message: "You cannot edit another institution",
        });
      }

      const currentInstitution = await Institution.findById(institutionId).select("name code");
      if (!currentInstitution) {
        return res.status(404).json({
          status: "error",
          message: "Institution not found",
        });
      }

      const updates = buildInstitutionPayload(req.body, { includeDefaults: false });
      if (req.body.name !== undefined) {
        const nextName = toOptionalText(req.body.name, { max: 180 });
        if (!nextName) {
          return res.status(400).json({
            status: "error",
            message: "Institution name is required",
          });
        }
        updates.name = nextName;
      }

      if (req.body.code !== undefined) {
        const requestedCode = toOptionalText(req.body.code, { max: 40, uppercase: true });
        updates.code = requestedCode
          ? toInstitutionCode(requestedCode, updates.name || currentInstitution.name)
          : currentInstitution.code;
      }

      if (!Object.keys(updates).length) {
        return res.status(400).json({
          status: "error",
          message: "No institution fields to update",
        });
      }

      const institution = await Institution.findByIdAndUpdate(
        institutionId,
        { $set: updates },
        {
          new: true,
          runValidators: true,
        }
      ).select(INSTITUTION_SELECT_FIELDS);

      if (!institution) {
        return res.status(404).json({
          status: "error",
          message: "Institution not found",
        });
      }

      return res.json({
        status: "success",
        message: "Institution updated",
        data: mapInstitution(institution),
      });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({
          status: "error",
          message: "Institution name or code already exists",
        });
      }
      return res.status(500).json({
        status: "error",
        message: error.message,
      });
    }
  }
);

router.post(
  "/institutions/:id/logo-upload",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin"),
  async (req, res) => {
    try {
      const institutionId = String(req.params.id || "").trim();
      if (!mongoose.Types.ObjectId.isValid(institutionId)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid institution id",
        });
      }

      if (!canManageInstitution(req.authUser, institutionId)) {
        return res.status(403).json({
          status: "error",
          message: "You cannot edit another institution",
        });
      }

      const institution = await Institution.findById(institutionId).select("_id logoUrl");
      if (!institution) {
        return res.status(404).json({
          status: "error",
          message: "Institution not found",
        });
      }

      const { dataUrl, fileName } = req.body || {};
      const { buffer, ext } = parseImageDataUrl(dataUrl);
      ensureInstitutionLogoDir();

      const safeName = String(fileName || "logo")
        .trim()
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 80);
      const baseName = safeName.replace(/\.[^.]+$/, "") || "logo";
      const randomPart = crypto.randomBytes(8).toString("hex");
      const filename = `inst_${institutionId}_${baseName}_${randomPart}.${ext}`;
      const logoPath = path.join(INSTITUTION_LOGO_DIR, filename);

      fs.writeFileSync(logoPath, buffer);

      const previousLogo = String(institution.logoUrl || "");
      if (previousLogo.startsWith("/institution-logos/")) {
        const previousFile = path.basename(previousLogo);
        const previousPath = path.join(INSTITUTION_LOGO_DIR, previousFile);
        if (fs.existsSync(previousPath)) {
          fs.unlinkSync(previousPath);
        }
      }

      institution.logoUrl = `/institution-logos/${filename}`;
      await institution.save();

      const updated = await Institution.findById(institutionId).select(INSTITUTION_SELECT_FIELDS);
      return res.status(201).json({
        status: "success",
        message: "Institution logo uploaded",
        data: mapInstitution(updated),
      });
    } catch (error) {
      const status = error.status || 500;
      return res.status(status).json({
        status: "error",
        message: error.message || "Failed to upload institution logo",
      });
    }
  }
);

router.get(
  "/users",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin", "institution_user"),
  async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const activeParam = String(req.query.active || "").toLowerCase();
    const hasPagingParams = req.query.page !== undefined || req.query.limit !== undefined;
    const paginate = hasPagingParams;
    const useAllInstitutions = canUseAllInstitutionsScope(req);
    const query = {};

    if (!useAllInstitutions) {
      const institutionId = resolveInstitutionIdForRequest(req);
      query.institutionId = institutionId;
    }
    if (req.authUser.role !== "superadmin") query.role = { $ne: "superadmin" };

    if (activeParam === "true") query.isActive = true;
    if (activeParam === "false") query.isActive = false;

    if (q) {
      const regex = new RegExp(escapeRegExp(q), "i");
      query.$or = [{ name: regex }, { email: regex }, { role: regex }];
    }

    let users = [];
    let total = 0;
    let page = 1;
    let limit = 0;

      if (!paginate) {
        users = await AuthUser.find(query)
          .sort({ role: 1, name: 1 })
          .select("name email role institutionId isActive lastLoginAt createdAt updatedAt")
          .populate("institutionId", INSTITUTION_SELECT_FIELDS);
      total = users.length;
      limit = total || 1;
    } else {
      const pagination = parsePagination(req.query, { defaultLimit: 50, maxLimit: 500 });
      page = pagination.page;
      limit = pagination.limit;
      const skip = pagination.skip;

      [total, users] = await Promise.all([
        AuthUser.countDocuments(query),
        AuthUser.find(query)
          .sort({ role: 1, name: 1 })
          .skip(skip)
          .limit(limit)
          .select("name email role institutionId isActive lastLoginAt createdAt updatedAt")
          .populate("institutionId", INSTITUTION_SELECT_FIELDS),
      ]);
    }

    return res.json({
      status: "success",
      data: users.map(sanitizeUser),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / Math.max(limit, 1))),
        hasNext: page * Math.max(limit, 1) < total,
      },
      scope: {
        includeAllInstitutions: useAllInstitutions,
      },
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({
        status: "error",
        message: error.message,
      });
    }
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
  }
);

router.post(
  "/users",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin"),
  async (req, res) => {
  try {
    const targetRole = String(req.body.role || "teacher").trim().toLowerCase();
    if (!["superadmin", "admin", "institution_admin", "institution_user", "teacher"].includes(targetRole)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid role",
      });
    }

    if (req.authUser.role === "admin" && ["superadmin", "admin"].includes(targetRole)) {
      return res.status(403).json({
        status: "error",
        message: "Admin cannot create superadmin or admin users",
      });
    }
    if (isInstitutionAdminRole(req.authUser.role) && !["teacher", "institution_user"].includes(targetRole)) {
      return res.status(403).json({
        status: "error",
        message: "Institution admin can only create teacher or institution_user",
      });
    }

    const validationError = validateCredentials({
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      requireName: true,
    });
    if (validationError) {
      return res.status(400).json({ status: "error", message: validationError });
    }

    let institutionId = "";
    if (req.authUser.role === "superadmin") {
      institutionId =
        normalizeInstitutionId(req.body.institutionId) || resolveInstitutionIdForRequest(req);
    } else {
      institutionId = resolveInstitutionIdForRequest(req);
    }

    if (!institutionId) {
      return res.status(400).json({
        status: "error",
        message: "institutionId is required",
      });
    }
    if (!mongoose.Types.ObjectId.isValid(institutionId)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid institutionId",
      });
    }

    const institution = await Institution.findById(institutionId).select("_id isActive");
    if (!institution || !institution.isActive) {
      return res.status(400).json({
        status: "error",
        message: "Institution not found or inactive",
      });
    }

    const email = normalizeEmail(req.body.email);
    const passwordHash = await bcrypt.hash(String(req.body.password), PASSWORD_HASH_ROUNDS);
    const createdUser = await AuthUser.create({
      name: String(req.body.name).trim(),
      email,
      passwordHash,
      role: targetRole,
      institutionId,
      isActive: req.body.isActive !== false,
    });
    const user = await AuthUser.findById(createdUser._id).populate(
      "institutionId",
      INSTITUTION_SELECT_FIELDS
    );

    return res.status(201).json({
      status: "success",
      message: "User created",
      user: sanitizeUser(user),
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({
        status: "error",
        message: error.message,
      });
    }
    if (error.code === 11000) {
      return res.status(409).json({
        status: "error",
        message: "Email already exists",
      });
    }
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
  }
);

router.get(
  "/users/:id",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin", "institution_user"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid user id",
        });
      }

      const useAllInstitutions = canUseAllInstitutionsScope(req);
      const query = { _id: id };
      if (!useAllInstitutions) {
        const institutionId = resolveInstitutionIdForRequest(req);
        query.institutionId = institutionId;
      }
      if (req.authUser.role !== "superadmin") {
        query.role = { $ne: "superadmin" };
      }

      const user = await AuthUser.findOne(query)
        .select("name email role institutionId isActive lastLoginAt createdAt updatedAt")
        .populate("institutionId", INSTITUTION_SELECT_FIELDS);

      if (!user) {
        return res.status(404).json({
          status: "error",
          message: "User not found",
        });
      }

      return res.json({
        status: "success",
        user: sanitizeUser(user),
      });
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({
          status: "error",
          message: error.message,
        });
      }
      return res.status(500).json({
        status: "error",
        message: error.message,
      });
    }
  }
);

router.patch(
  "/users/:id",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid user id",
        });
      }

      const useAllInstitutions = canUseAllInstitutionsScope(req);
      const scopedInstitutionId = useAllInstitutions ? "" : resolveInstitutionIdForRequest(req);
      const targetUser = await AuthUser.findById(id);
      if (!targetUser) {
        return res.status(404).json({
          status: "error",
          message: "User not found",
        });
      }

      if (scopedInstitutionId && String(targetUser.institutionId || "") !== String(scopedInstitutionId || "")) {
        return res.status(404).json({
          status: "error",
          message: "User not found",
        });
      }

      const isSelfUpdate = String(targetUser._id) === String(req.authUser._id);
      const currentRole = String(targetUser.role || "").trim().toLowerCase();
      const requestedRole =
        req.body.role !== undefined ? String(req.body.role || "").trim().toLowerCase() : "";
      const nextRole = requestedRole || currentRole;

      if (!["superadmin", "admin", "institution_admin", "institution_user", "teacher"].includes(nextRole)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid role",
        });
      }

      if (currentRole === "superadmin" && req.authUser.role !== "superadmin") {
        return res.status(403).json({
          status: "error",
          message: "Only superadmin can modify a superadmin",
        });
      }

      if (req.authUser.role === "admin") {
        if (["superadmin", "admin"].includes(currentRole) || ["superadmin", "admin"].includes(nextRole)) {
          return res.status(403).json({
            status: "error",
            message: "Admin cannot modify superadmin or admin users",
          });
        }
      }

      if (isInstitutionAdminRole(req.authUser.role)) {
        if (!isSelfUpdate && ["admin", "institution_admin", "superadmin"].includes(currentRole)) {
          return res.status(403).json({
            status: "error",
            message: "Institution admin cannot change another admin",
          });
        }

        if (!isSelfUpdate && !["teacher", "institution_user"].includes(nextRole)) {
          return res.status(403).json({
            status: "error",
            message: "Institution admin can only update teacher or institution_user",
          });
        }

        if (isSelfUpdate && requestedRole && requestedRole !== "institution_admin") {
          return res.status(403).json({
            status: "error",
            message: "Institution admin cannot change own role",
          });
        }
      }

      if (req.body.name !== undefined) {
        const name = String(req.body.name || "").trim();
        if (!name) {
          return res.status(400).json({
            status: "error",
            message: "Name is required",
          });
        }
        targetUser.name = name;
      }

      if (req.body.email !== undefined) {
        const email = normalizeEmail(req.body.email);
        if (!email || !EMAIL_PATTERN.test(email)) {
          return res.status(400).json({
            status: "error",
            message: "A valid email is required",
          });
        }
        targetUser.email = email;
      }

      let nextInstitutionId = String(targetUser.institutionId || "");
      if (isGlobalInstitutionRole(req.authUser.role)) {
        const requestedInstitutionId = normalizeInstitutionId(req.body.institutionId);
        if (requestedInstitutionId) {
          nextInstitutionId = requestedInstitutionId;
        }
      } else {
        const ownInstitutionId = resolveInstitutionIdForRequest(req);
        const requestedInstitutionId = normalizeInstitutionId(req.body.institutionId);
        if (requestedInstitutionId && requestedInstitutionId !== ownInstitutionId) {
          return res.status(403).json({
            status: "error",
            message: "You cannot edit another institution",
          });
        }
        nextInstitutionId = ownInstitutionId;
      }

      if (!nextInstitutionId) {
        return res.status(400).json({
          status: "error",
          message: "institutionId is required",
        });
      }
      if (!mongoose.Types.ObjectId.isValid(nextInstitutionId)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid institutionId",
        });
      }

      const institution = await Institution.findById(nextInstitutionId).select("_id isActive");
      if (!institution || !institution.isActive) {
        return res.status(400).json({
          status: "error",
          message: "Institution not found or inactive",
        });
      }

      targetUser.institutionId = nextInstitutionId;
      targetUser.role = nextRole;

      if (req.body.isActive !== undefined) {
        targetUser.isActive = req.body.isActive !== false;
      }

      if (req.body.password !== undefined) {
        const rawPassword = String(req.body.password || "");
        if (rawPassword.trim()) {
          if (rawPassword.length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({
              status: "error",
              message: "Password must be at least " + MIN_PASSWORD_LENGTH + " characters",
            });
          }
          targetUser.passwordHash = await bcrypt.hash(rawPassword, PASSWORD_HASH_ROUNDS);
        }
      }

      await targetUser.save();

      const updatedUser = await AuthUser.findById(targetUser._id)
        .select("name email role institutionId isActive lastLoginAt createdAt updatedAt")
        .populate("institutionId", INSTITUTION_SELECT_FIELDS);

      return res.json({
        status: "success",
        message: "User updated",
        user: sanitizeUser(updatedUser),
      });
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({
          status: "error",
          message: error.message,
        });
      }
      if (error.code === 11000) {
        return res.status(409).json({
          status: "error",
          message: "Email already exists",
        });
      }
      return res.status(500).json({
        status: "error",
        message: error.message,
      });
    }
  }
);

router.patch(
  "/users/:id/status",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const isActive = req.body.isActive === true;
      const useAllInstitutions = canUseAllInstitutionsScope(req);
      const institutionId = useAllInstitutions ? "" : resolveInstitutionIdForRequest(req);
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid user id",
        });
      }

      const targetUser = await AuthUser.findById(id);
      if (!targetUser) {
        return res.status(404).json({
          status: "error",
          message: "User not found",
        });
      }

      if (institutionId && String(targetUser.institutionId || "") !== String(institutionId || "")) {
        return res.status(404).json({
          status: "error",
          message: "User not found",
        });
      }

      if (targetUser.role === "superadmin" && req.authUser.role !== "superadmin") {
        return res.status(403).json({
          status: "error",
          message: "Only superadmin can modify a superadmin",
        });
      }

      if (
        req.authUser.role === "institution_admin" &&
        ["admin", "institution_admin"].includes(String(targetUser.role || "")) &&
        String(targetUser._id) !== String(req.authUser._id)
      ) {
        return res.status(403).json({
          status: "error",
          message: "Institution admin cannot change another admin",
        });
      }

      targetUser.isActive = isActive;
      await targetUser.save();

      return res.json({
        status: "success",
        message: "User status updated",
        user: sanitizeUser(targetUser),
      });
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({
          status: "error",
          message: error.message,
        });
      }
      return res.status(500).json({
        status: "error",
        message: error.message,
      });
    }
  }
);

module.exports = router;
