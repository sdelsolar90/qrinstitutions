const mongoose = require("mongoose");

function getValue(input) {
  if (input === null || input === undefined) return "";
  return String(input).trim();
}

function normalizeInstitutionId(value) {
  const raw = getValue(value);
  return raw || "";
}

function getRequestedInstitutionId(req) {
  const headerValue =
    req.headers["x-institution-id"] ||
    req.headers["x-institution"] ||
    req.headers["institution-id"];
  if (getValue(headerValue)) return getValue(headerValue);

  const queryValue = req.query?.institutionId || req.query?.institution;
  if (getValue(queryValue)) return getValue(queryValue);

  const bodyValue = req.body?.institutionId || req.body?.institution;
  if (getValue(bodyValue)) return getValue(bodyValue);

  return "";
}

function getAuthInstitutionId(authUser) {
  if (!authUser) return "";
  if (authUser.institutionId && typeof authUser.institutionId === "object") {
    return getValue(authUser.institutionId._id || authUser.institutionId.id || authUser.institutionId);
  }
  return getValue(authUser.institutionId);
}

function isGlobalInstitutionRole(role) {
  return role === "superadmin" || role === "admin";
}

function resolveInstitutionIdForRequest(req, options = {}) {
  const { allowSuperadminAll = false } = options;
  const authUser = req.authUser;
  if (!authUser) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }

  const requestedInstitutionId = normalizeInstitutionId(getRequestedInstitutionId(req));
  const userInstitutionId = normalizeInstitutionId(getAuthInstitutionId(authUser));

  if (requestedInstitutionId && !mongoose.Types.ObjectId.isValid(requestedInstitutionId)) {
    const error = new Error("Invalid institutionId");
    error.status = 400;
    throw error;
  }

  if (isGlobalInstitutionRole(authUser.role)) {
    const effectiveInstitutionId = requestedInstitutionId || userInstitutionId;
    if (!effectiveInstitutionId) {
      if (allowSuperadminAll) return "";
      const error = new Error("Institution context is required for this operation");
      error.status = 400;
      throw error;
    }
    return effectiveInstitutionId;
  }

  if (!userInstitutionId) {
    const error = new Error("Your account is not assigned to an institution");
    error.status = 403;
    throw error;
  }

  if (requestedInstitutionId && requestedInstitutionId !== userInstitutionId) {
    const error = new Error("You cannot access data from another institution");
    error.status = 403;
    throw error;
  }

  return userInstitutionId;
}

function toInstitutionObjectId(institutionId) {
  if (!institutionId) return null;
  if (institutionId instanceof mongoose.Types.ObjectId) return institutionId;
  return new mongoose.Types.ObjectId(String(institutionId));
}

function mapInstitution(institution) {
  if (!institution) return null;
  const id = institution._id ? String(institution._id) : String(institution.id || "");
  return {
    id,
    name: institution.name,
    code: institution.code,
    shortName: institution.shortName || "",
    type: institution.type || "university",
    logoUrl: institution.logoUrl || "",
    website: institution.website || "",
    contactEmail: institution.contactEmail || "",
    contactPhone: institution.contactPhone || "",
    country: institution.country || "",
    state: institution.state || "",
    city: institution.city || "",
    addressLine1: institution.addressLine1 || "",
    addressLine2: institution.addressLine2 || "",
    postalCode: institution.postalCode || "",
    timezone: institution.timezone || "UTC",
    termSystem: institution.termSystem || "semester",
    academicYearLabel: institution.academicYearLabel || "",
    gradingScale: institution.gradingScale || "",
    isActive: institution.isActive !== false,
    createdAt: institution.createdAt || null,
    updatedAt: institution.updatedAt || null,
  };
}

module.exports = {
  normalizeInstitutionId,
  getRequestedInstitutionId,
  getAuthInstitutionId,
  resolveInstitutionIdForRequest,
  toInstitutionObjectId,
  mapInstitution,
};
