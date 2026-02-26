const express = require("express");
const mongoose = require("mongoose");
const AuthUser = require("../models/AuthUser");
const Course = require("../models/Course");
const TeacherCourseAssignment = require("../models/TeacherCourseAssignment");
const CourseEnrollment = require("../models/CourseEnrollment");
const { requireAuth, requireRoles } = require("../middleware/auth");
const {
  resolveInstitutionIdForRequest,
  toInstitutionObjectId,
} = require("../middleware/institution");

const router = express.Router();
const WEEKDAY_BY_INDEX = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const ALLOWED_DAY_CODES = new Set(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const ENROLLMENT_ROLL_PATTERN = /^[A-Z0-9-]{3,30}$/;
const COURSE_DELIVERY_MODES = new Set(["in_person", "online", "hybrid"]);
const DEFAULT_REQUIRE_ENROLLMENT = process.env.ATTENDANCE_REQUIRE_ENROLLMENT !== "false";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function isInstitutionAdminRole(role) {
  return role === "institution_admin";
}

function isGlobalInstitutionRole(role) {
  return role === "superadmin" || role === "admin";
}

function isTruthyFlag(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function canUseAllInstitutionsScope(req) {
  if (!isGlobalInstitutionRole(req?.authUser?.role)) return false;
  return isTruthyFlag(req?.query?.includeAll);
}

function normalizeUpper(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePagination(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const pageRaw = Number.parseInt(query.page, 10);
  const limitRaw = Number.parseInt(query.limit, 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limitCandidate = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : defaultLimit;
  const limit = Math.min(limitCandidate, maxLimit);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function parseExactTextFilter(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function buildCaseInsensitiveExactRegex(value) {
  return new RegExp(`^${escapeRegExp(value)}$`, "i");
}

function applyTextFilter(items, searchText, projector) {
  const normalizedSearch = String(searchText || "").trim().toLowerCase();
  if (!normalizedSearch) return [...items];
  const terms = normalizedSearch.split(/\s+/).filter(Boolean);

  return items.filter((item) => {
    const haystack = String(projector(item) || "").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function normalizeDaysOfWeek(input) {
  if (!Array.isArray(input)) return [];
  const normalized = input
    .map((day) => String(day || "").trim().toUpperCase())
    .filter((day) => ALLOWED_DAY_CODES.has(day));
  return [...new Set(normalized)];
}

function normalizeTime(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (!TIME_PATTERN.test(normalized)) return null;
  return normalized;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function toNullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function normalizeDeliveryMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "in_person";
  if (!COURSE_DELIVERY_MODES.has(normalized)) {
    const error = new Error("deliveryMode must be one of: in_person, online, hybrid");
    error.status = 400;
    throw error;
  }
  return normalized;
}

function normalizeIpAllowlist(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function buildAttendancePolicy(rawPolicy, { deliveryMode = "in_person", fallbackPolicy = null } = {}) {
  const source = rawPolicy && typeof rawPolicy === "object" ? rawPolicy : {};
  const fallback = fallbackPolicy && typeof fallbackPolicy === "object" ? fallbackPolicy : {};

  const singleDevicePerDay = normalizeBoolean(
    source.singleDevicePerDay,
    normalizeBoolean(fallback.singleDevicePerDay, true)
  );
  const requireSignature = normalizeBoolean(
    source.requireSignature,
    normalizeBoolean(fallback.requireSignature, true)
  );
  const requireEnrollment = normalizeBoolean(
    source.requireEnrollment,
    normalizeBoolean(fallback.requireEnrollment, DEFAULT_REQUIRE_ENROLLMENT)
  );
  const requireIpAllowlist = normalizeBoolean(
    source.requireIpAllowlist,
    normalizeBoolean(fallback.requireIpAllowlist, false)
  );
  const ipAllowlist = source.ipAllowlist !== undefined
    ? normalizeIpAllowlist(source.ipAllowlist)
    : normalizeIpAllowlist(fallback.ipAllowlist);

  const requireGeofence = normalizeBoolean(
    source.requireGeofence,
    normalizeBoolean(fallback.requireGeofence, false)
  );
  const geofenceSource = source.geofence && typeof source.geofence === "object"
    ? source.geofence
    : (fallback.geofence && typeof fallback.geofence === "object" ? fallback.geofence : {});
  const geofenceLat = toNullableNumber(geofenceSource.lat);
  const geofenceLng = toNullableNumber(geofenceSource.lng);
  const geofenceRadiusRaw = toNullableNumber(geofenceSource.radiusMeters);
  const geofenceRadius = geofenceRadiusRaw === null ? 120 : geofenceRadiusRaw;

  if (requireIpAllowlist && !ipAllowlist.length) {
    const error = new Error("attendancePolicy.ipAllowlist is required when requireIpAllowlist=true");
    error.status = 400;
    throw error;
  }
  if (requireGeofence) {
    if (geofenceLat === null || geofenceLng === null) {
      const error = new Error("attendancePolicy.geofence.lat/lng are required when requireGeofence=true");
      error.status = 400;
      throw error;
    }
    if (geofenceRadius < 10 || geofenceRadius > 100000) {
      const error = new Error("attendancePolicy.geofence.radiusMeters must be between 10 and 100000");
      error.status = 400;
      throw error;
    }
  }

  return {
    deliveryMode,
    singleDevicePerDay,
    requireSignature,
    requireEnrollment,
    requireIpAllowlist,
    ipAllowlist,
    requireGeofence,
    geofence: {
      lat: geofenceLat,
      lng: geofenceLng,
      radiusMeters: geofenceRadius,
    },
  };
}

function mapAttendancePolicy(rawPolicy, deliveryMode) {
  try {
    return buildAttendancePolicy(rawPolicy, { deliveryMode });
  } catch (_) {
    return buildAttendancePolicy({}, { deliveryMode });
  }
}

function toMinutes(timeValue) {
  if (!timeValue || !TIME_PATTERN.test(timeValue)) return null;
  const [hours, minutes] = timeValue.split(":").map(Number);
  return hours * 60 + minutes;
}

function evaluateCourseSchedule(course, now = new Date()) {
  const daysOfWeek = Array.isArray(course.daysOfWeek) ? course.daysOfWeek : [];
  const startMinutes = toMinutes(course.startTime);
  const endMinutes = toMinutes(course.endTime);
  const hasSchedule =
    daysOfWeek.length > 0 &&
    startMinutes !== null &&
    endMinutes !== null &&
    endMinutes > startMinutes;
  if (!hasSchedule) {
    return {
      hasSchedule: false,
      scheduledToday: false,
      inScheduleWindow: false,
      upcomingToday: false,
      rank: 0,
    };
  }

  const todayCode = WEEKDAY_BY_INDEX[now.getDay()];
  const scheduledToday = daysOfWeek.includes(todayCode);
  if (!scheduledToday) {
    return {
      hasSchedule: true,
      scheduledToday: false,
      inScheduleWindow: false,
      upcomingToday: false,
      rank: 0,
    };
  }

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (nowMinutes >= startMinutes && nowMinutes <= endMinutes) {
    return {
      hasSchedule: true,
      scheduledToday: true,
      inScheduleWindow: true,
      upcomingToday: false,
      rank: 300 + (endMinutes - nowMinutes),
    };
  }

  if (nowMinutes < startMinutes) {
    return {
      hasSchedule: true,
      scheduledToday: true,
      inScheduleWindow: false,
      upcomingToday: true,
      rank: 200 - (startMinutes - nowMinutes),
    };
  }

  return {
    hasSchedule: true,
    scheduledToday: true,
    inScheduleWindow: false,
    upcomingToday: false,
    rank: 100 - (nowMinutes - endMinutes),
  };
}

function sortAndMapCourses(courses) {
  const now = new Date();
  const decorated = courses.map((course) => ({
    course,
    scheduleMeta: evaluateCourseSchedule(course, now),
  }));

  decorated.sort((left, right) => {
    if (right.scheduleMeta.rank !== left.scheduleMeta.rank) {
      return right.scheduleMeta.rank - left.scheduleMeta.rank;
    }
    const leftKey = `${left.course.program || ""}-${left.course.programVersion || ""}-${left.course.code || ""}-${left.course.section || ""}`;
    const rightKey = `${right.course.program || ""}-${right.course.programVersion || ""}-${right.course.code || ""}-${right.course.section || ""}`;
    return leftKey.localeCompare(rightKey);
  });

  return decorated.map(({ course, scheduleMeta }) => mapCourse(course, scheduleMeta));
}

function mapCourse(course, scheduleMeta = evaluateCourseSchedule(course)) {
  let deliveryMode = "in_person";
  try {
    deliveryMode = normalizeDeliveryMode(course.deliveryMode);
  } catch (_) {
    deliveryMode = "in_person";
  }
  const attendancePolicy = mapAttendancePolicy(course.attendancePolicy, deliveryMode);
  return {
    id: String(course._id),
    institutionId: course.institutionId ? String(course.institutionId) : null,
    program: course.program || "General",
    programVersion: course.programVersion || "1",
    code: course.code,
    name: course.name,
    section: course.section,
    academicYear: course.academicYear || "",
    daysOfWeek: Array.isArray(course.daysOfWeek) ? course.daysOfWeek : [],
    startTime: course.startTime || "",
    endTime: course.endTime || "",
    schedule: {
      daysOfWeek: Array.isArray(course.daysOfWeek) ? course.daysOfWeek : [],
      startTime: course.startTime || "",
      endTime: course.endTime || "",
    },
    scheduledToday: scheduleMeta.scheduledToday,
    inScheduleWindow: scheduleMeta.inScheduleWindow,
    upcomingToday: scheduleMeta.upcomingToday,
    deliveryMode,
    attendancePolicy,
    isActive: course.isActive,
  };
}

function mapTeacher(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
  };
}

function mapAssignment(assignment) {
  const assignmentDeliveryMode = (() => {
    try {
      return normalizeDeliveryMode(assignment?.courseId?.deliveryMode);
    } catch (_) {
      return "in_person";
    }
  })();

  return {
    id: String(assignment._id),
    institutionId: assignment.institutionId ? String(assignment.institutionId) : null,
    isActive: assignment.isActive,
    teacher: assignment.teacherId
      ? {
          id: String(assignment.teacherId._id),
          name: assignment.teacherId.name,
          email: assignment.teacherId.email,
          role: assignment.teacherId.role,
          isActive: assignment.teacherId.isActive,
        }
      : null,
    course: assignment.courseId
      ? {
          id: String(assignment.courseId._id),
          program: assignment.courseId.program || "General",
          programVersion: assignment.courseId.programVersion || "1",
          code: assignment.courseId.code,
          name: assignment.courseId.name,
          section: assignment.courseId.section,
          daysOfWeek: Array.isArray(assignment.courseId.daysOfWeek)
            ? assignment.courseId.daysOfWeek
            : [],
          startTime: assignment.courseId.startTime || "",
          endTime: assignment.courseId.endTime || "",
          deliveryMode: assignmentDeliveryMode,
          isActive: assignment.courseId.isActive,
        }
      : null,
  };
}

function mapEnrollment(enrollment) {
  return {
    id: String(enrollment._id),
    institutionId: enrollment.institutionId ? String(enrollment.institutionId) : null,
    courseId: String(enrollment.courseId),
    universityRollNo: enrollment.universityRollNo,
    email: enrollment.email,
    fullName: enrollment.fullName,
    section: enrollment.section,
    classRollNo: enrollment.classRollNo,
    isActive: enrollment.isActive,
    createdAt: enrollment.createdAt,
    updatedAt: enrollment.updatedAt,
  };
}

async function ensureCourseAccess(authUser, courseId, institutionId) {
  if (
    authUser.role === "superadmin" ||
    authUser.role === "admin" ||
    isInstitutionAdminRole(authUser.role) ||
    authUser.role === "institution_user"
  ) {
    const course = await Course.findOne({
      _id: courseId,
      institutionId,
    }).select("_id");
    return Boolean(course);
  }
  if (authUser.role !== "teacher") {
    return false;
  }

  const assignment = await TeacherCourseAssignment.findOne({
    institutionId,
    teacherId: authUser._id,
    courseId,
    isActive: true,
  }).select("_id");

  return Boolean(assignment);
}

function normalizeEnrollmentRow(row) {
  const universityRollNo = normalizeUpper(row.universityRollNo);
  const fullName = normalizeName(row.fullName);
  const section = normalizeUpper(row.section);
  const classRollNo = normalizeUpper(row.classRollNo);
  const email = normalizeEmail(row.email);

  if (!ENROLLMENT_ROLL_PATTERN.test(universityRollNo)) {
    return { error: "Invalid universityRollNo format" };
  }
  if (!fullName) {
    return { error: "fullName is required" };
  }
  if (!section) {
    return { error: "section is required" };
  }
  if (!classRollNo) {
    return { error: "classRollNo is required" };
  }
  if (!EMAIL_PATTERN.test(email)) {
    return { error: "Valid email is required" };
  }

  return {
    universityRollNo,
    fullName,
    section,
    classRollNo,
    email,
  };
}

async function getCoursesForTeacher(teacherId, institutionId) {
  const assignments = await TeacherCourseAssignment.find({
    institutionId,
    teacherId,
    isActive: true,
  })
    .populate({
      path: "courseId",
      match: { institutionId, isActive: true },
      select: "program programVersion code name section academicYear isActive daysOfWeek startTime endTime deliveryMode attendancePolicy",
    })
    .sort({ createdAt: -1 });

  return assignments
    .map((assignment) => assignment.courseId)
    .filter(Boolean);
}

router.get("/my-courses", requireAuth, async (req, res) => {
  try {
    const institutionId = resolveInstitutionIdForRequest(req);
    const q = String(req.query.q || "").trim();
    const programFilter = parseExactTextFilter(req.query.program);
    const programVersionFilter = parseExactTextFilter(req.query.programVersion);
    const deliveryModeFilterRaw = String(req.query.deliveryMode || "").trim();
    const deliveryModeFilter = deliveryModeFilterRaw ? normalizeDeliveryMode(deliveryModeFilterRaw) : "";
    const { page, limit, skip } = parsePagination(req.query, {
      defaultLimit: 80,
      maxLimit: 300,
    });

    if (req.authUser.role === "teacher") {
      const teacherCourses = await getCoursesForTeacher(req.authUser._id, institutionId);
      const rankedCourses = sortAndMapCourses(teacherCourses);
      let filteredCourses = applyTextFilter(
        rankedCourses,
        q,
        (course) =>
          [
            course.program,
            course.programVersion,
            course.code,
            course.name,
            course.section,
            course.academicYear,
            (course.daysOfWeek || []).join(" "),
            course.startTime,
            course.endTime,
            course.deliveryMode,
          ].join(" ")
      );

      if (programFilter) {
        const programRegex = buildCaseInsensitiveExactRegex(programFilter);
        filteredCourses = filteredCourses.filter((course) => programRegex.test(String(course.program || "")));
      }
      if (programVersionFilter) {
        const versionRegex = buildCaseInsensitiveExactRegex(programVersionFilter);
        filteredCourses = filteredCourses.filter((course) => versionRegex.test(String(course.programVersion || "")));
      }
      if (deliveryModeFilter) {
        filteredCourses = filteredCourses.filter(
          (course) => String(course.deliveryMode || "").toLowerCase() === deliveryModeFilter
        );
      }
      const total = filteredCourses.length;
      const pagedCourses = filteredCourses.slice(skip, skip + limit);

      return res.json({
        status: "success",
        data: pagedCourses,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
          hasNext: skip + limit < total,
        },
      });
    }

    const filter = { institutionId, isActive: true };
    if (programFilter) filter.program = buildCaseInsensitiveExactRegex(programFilter);
    if (programVersionFilter) filter.programVersion = buildCaseInsensitiveExactRegex(programVersionFilter);
    if (deliveryModeFilter) filter.deliveryMode = deliveryModeFilter;
    if (q) {
      const regex = new RegExp(escapeRegExp(q), "i");
      filter.$or = [
        { program: regex },
        { programVersion: regex },
        { code: regex },
        { name: regex },
        { section: regex },
        { academicYear: regex },
        { daysOfWeek: regex },
        { startTime: regex },
        { endTime: regex },
        { deliveryMode: regex },
      ];
    }

    const [total, courses] = await Promise.all([
      Course.countDocuments(filter),
      Course.find(filter)
        .sort({ program: 1, programVersion: 1, code: 1, section: 1 })
        .skip(skip)
        .limit(limit),
    ]);

    return res.json({
      status: "success",
      data: sortAndMapCourses(courses),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNext: skip + limit < total,
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
});

router.get(
  "/courses",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin", "institution_user"),
  async (req, res) => {
  try {
    const useAllInstitutions = canUseAllInstitutionsScope(req);
    const q = String(req.query.q || "").trim();
    const programFilter = parseExactTextFilter(req.query.program);
    const programVersionFilter = parseExactTextFilter(req.query.programVersion);
    const deliveryModeFilterRaw = String(req.query.deliveryMode || "").trim();
    const deliveryModeFilter = deliveryModeFilterRaw ? normalizeDeliveryMode(deliveryModeFilterRaw) : "";
    const activeParam = String(req.query.active || "").toLowerCase();
    const hasPagingParams = req.query.page !== undefined || req.query.limit !== undefined;
    const paginate = hasPagingParams;
    const filter = {};

    if (!useAllInstitutions) {
      const institutionId = resolveInstitutionIdForRequest(req);
      filter.institutionId = institutionId;
    }

    if (activeParam === "true") filter.isActive = true;
    if (activeParam === "false") filter.isActive = false;
    if (programFilter) filter.program = buildCaseInsensitiveExactRegex(programFilter);
    if (programVersionFilter) filter.programVersion = buildCaseInsensitiveExactRegex(programVersionFilter);
    if (deliveryModeFilter) filter.deliveryMode = deliveryModeFilter;

    if (q) {
      const regex = new RegExp(escapeRegExp(q), "i");
      filter.$or = [
        { program: regex },
        { programVersion: regex },
        { code: regex },
        { name: regex },
        { section: regex },
        { academicYear: regex },
        { daysOfWeek: regex },
        { startTime: regex },
        { endTime: regex },
        { deliveryMode: regex },
      ];
    }

    let courses = [];
    let total = 0;
    let page = 1;
    let limit = 0;

    if (!paginate) {
      courses = await Course.find(filter).sort({ isActive: -1, program: 1, programVersion: 1, code: 1, section: 1 });
      total = courses.length;
      limit = total || 1;
    } else {
      const pagination = parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 });
      page = pagination.page;
      limit = pagination.limit;
      const skip = pagination.skip;

      [total, courses] = await Promise.all([
        Course.countDocuments(filter),
        Course.find(filter)
          .sort({ isActive: -1, program: 1, programVersion: 1, code: 1, section: 1 })
          .skip(skip)
          .limit(limit),
      ]);
    }

    return res.json({
      status: "success",
      data: courses.map(mapCourse),
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

router.get(
  "/programs",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin", "institution_user"),
  async (req, res) => {
  try {
    const useAllInstitutions = canUseAllInstitutionsScope(req);
    const activeParam = String(req.query.active || "").toLowerCase();
    const match = {};

    if (!useAllInstitutions) {
      const institutionId = resolveInstitutionIdForRequest(req);
      match.institutionId = toInstitutionObjectId(institutionId);
    }

    if (activeParam === "true") match.isActive = true;
    if (activeParam === "false") match.isActive = false;

    const rows = await Course.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            program: { $ifNull: ["$program", "General"] },
            programVersion: { $ifNull: ["$programVersion", "1"] },
          },
          totalCourses: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          program: "$_id.program",
          programVersion: "$_id.programVersion",
          totalCourses: 1,
        },
      },
      { $sort: { program: 1, programVersion: 1 } },
    ]);

    const byProgram = new Map();
    rows.forEach((row) => {
      const program = String(row.program || "General");
      const version = String(row.programVersion || "1");
      const totalCourses = Number(row.totalCourses || 0);
      if (!byProgram.has(program)) {
        byProgram.set(program, {
          program,
          totalCourses: 0,
          versions: [],
        });
      }
      const entry = byProgram.get(program);
      entry.totalCourses += totalCourses;
      entry.versions.push({
        programVersion: version,
        totalCourses,
      });
    });

    return res.json({
      status: "success",
      data: Array.from(byProgram.values()),
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
  "/courses",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin"),
  async (req, res) => {
  try {
    const institutionId = resolveInstitutionIdForRequest(req);
    const code = String(req.body.code || "").trim().toUpperCase();
    const name = String(req.body.name || "").trim();
    const section = String(req.body.section || "").trim().toUpperCase();
    const program = String(req.body.program || "").trim() || "General";
    const programVersion = String(req.body.programVersion || "").trim() || "1";
    const academicYear = String(req.body.academicYear || "").trim();
    const daysOfWeek = normalizeDaysOfWeek(req.body.daysOfWeek);
    const startTime = normalizeTime(req.body.startTime);
    const endTime = normalizeTime(req.body.endTime);
    const deliveryMode = normalizeDeliveryMode(req.body.deliveryMode);
    const attendancePolicy = buildAttendancePolicy(req.body.attendancePolicy, { deliveryMode });

    if (!code || !name || !section) {
      return res.status(400).json({
        status: "error",
        message: "Code, name and section are required",
      });
    }
    if (startTime === null || endTime === null) {
      return res.status(400).json({
        status: "error",
        message: "startTime and endTime must use HH:mm format",
      });
    }

    const hasAnySchedule = Boolean(daysOfWeek.length || startTime || endTime);
    if (hasAnySchedule) {
      if (!daysOfWeek.length || !startTime || !endTime) {
        return res.status(400).json({
          status: "error",
          message: "daysOfWeek, startTime and endTime must be provided together",
        });
      }
      if (startTime >= endTime) {
        return res.status(400).json({
          status: "error",
          message: "startTime must be earlier than endTime",
        });
      }
    }

    const course = await Course.create({
      institutionId,
      program,
      programVersion,
      code,
      name,
      section,
      academicYear,
      daysOfWeek,
      startTime: startTime || "",
      endTime: endTime || "",
      deliveryMode,
      attendancePolicy,
      createdBy: req.authUser._id,
      isActive: true,
    });

    return res.status(201).json({
      status: "success",
      message: "Course created",
      data: mapCourse(course),
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
        message: "Course code+section already exists",
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
  "/courses/:courseId",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin", "institution_user"),
  async (req, res) => {
    try {
      const institutionId = resolveInstitutionIdForRequest(req);
      const courseId = String(req.params.courseId || "").trim();
      if (!courseId) {
        return res.status(400).json({
          status: "error",
          message: "courseId is required",
        });
      }

      const course = await Course.findOne({
        _id: courseId,
        institutionId,
      });

      if (!course) {
        return res.status(404).json({
          status: "error",
          message: "Course not found",
        });
      }

      return res.json({
        status: "success",
        data: mapCourse(course),
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

router.put(
  "/courses/:courseId",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin"),
  async (req, res) => {
    try {
      const institutionId = resolveInstitutionIdForRequest(req);
      const courseId = String(req.params.courseId || "").trim();
      if (!courseId) {
        return res.status(400).json({
          status: "error",
          message: "courseId is required",
        });
      }

      const course = await Course.findOne({ _id: courseId, institutionId });
      if (!course) {
        return res.status(404).json({
          status: "error",
          message: "Course not found",
        });
      }

      const code = String(req.body.code ?? course.code ?? "").trim().toUpperCase();
      const name = String(req.body.name ?? course.name ?? "").trim();
      const section = String(req.body.section ?? course.section ?? "").trim().toUpperCase();
      const program = String(req.body.program ?? course.program ?? "").trim() || "General";
      const programVersion = String(req.body.programVersion ?? course.programVersion ?? "").trim() || "1";
      const academicYear = String(req.body.academicYear ?? course.academicYear ?? "").trim();
      const daysOfWeek = normalizeDaysOfWeek(req.body.daysOfWeek ?? course.daysOfWeek);
      const startTime = normalizeTime(req.body.startTime ?? course.startTime);
      const endTime = normalizeTime(req.body.endTime ?? course.endTime);
      const deliveryMode = normalizeDeliveryMode(req.body.deliveryMode ?? course.deliveryMode);
      const attendancePolicy = buildAttendancePolicy(
        req.body.attendancePolicy,
        { deliveryMode, fallbackPolicy: course.attendancePolicy }
      );

      if (!code || !name || !section) {
        return res.status(400).json({
          status: "error",
          message: "Code, name and section are required",
        });
      }
      if (startTime === null || endTime === null) {
        return res.status(400).json({
          status: "error",
          message: "startTime and endTime must use HH:mm format",
        });
      }

      const hasAnySchedule = Boolean(daysOfWeek.length || startTime || endTime);
      if (hasAnySchedule) {
        if (!daysOfWeek.length || !startTime || !endTime) {
          return res.status(400).json({
            status: "error",
            message: "daysOfWeek, startTime and endTime must be provided together",
          });
        }
        if (startTime >= endTime) {
          return res.status(400).json({
            status: "error",
            message: "startTime must be earlier than endTime",
          });
        }
      }

      course.code = code;
      course.name = name;
      course.section = section;
      course.program = program;
      course.programVersion = programVersion;
      course.academicYear = academicYear;
      course.daysOfWeek = daysOfWeek;
      course.startTime = startTime || "";
      course.endTime = endTime || "";
      course.deliveryMode = deliveryMode;
      course.attendancePolicy = attendancePolicy;
      if (req.body.isActive !== undefined) {
        course.isActive = req.body.isActive !== false;
      }
      await course.save();

      return res.json({
        status: "success",
        message: "Course updated",
        data: mapCourse(course),
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
          message: "Course code+section already exists",
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
  "/teachers",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin", "institution_user"),
  async (req, res) => {
  try {
    const institutionId = resolveInstitutionIdForRequest(req);
    const q = String(req.query.q || "").trim();
    const activeParam = String(req.query.active || "").toLowerCase();
    const hasPagingParams = req.query.page !== undefined || req.query.limit !== undefined;
    const paginate = hasPagingParams;
    const filter = { institutionId, role: "teacher" };

    if (activeParam === "true") filter.isActive = true;
    if (activeParam === "false") filter.isActive = false;

    if (q) {
      const regex = new RegExp(escapeRegExp(q), "i");
      filter.$or = [{ name: regex }, { email: regex }];
    }

    let teachers = [];
    let total = 0;
    let page = 1;
    let limit = 0;

    if (!paginate) {
      teachers = await AuthUser.find(filter)
        .sort({ isActive: -1, name: 1 })
        .select("name email role isActive");
      total = teachers.length;
      limit = total || 1;
    } else {
      const pagination = parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 });
      page = pagination.page;
      limit = pagination.limit;
      const skip = pagination.skip;

      [total, teachers] = await Promise.all([
        AuthUser.countDocuments(filter),
        AuthUser.find(filter)
          .sort({ isActive: -1, name: 1 })
          .skip(skip)
          .limit(limit)
          .select("name email role isActive"),
      ]);
    }

    return res.json({
      status: "success",
      data: teachers.map(mapTeacher),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / Math.max(limit, 1))),
        hasNext: page * Math.max(limit, 1) < total,
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

router.get(
  "/assignments",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin", "institution_user"),
  async (req, res) => {
    try {
      const institutionId = resolveInstitutionIdForRequest(req);
      const q = String(req.query.q || "").trim();
      const activeParam = String(req.query.active || "").toLowerCase();
      const hasPagingParams = req.query.page !== undefined || req.query.limit !== undefined;
      const paginate = hasPagingParams;
      const teacherId = String(req.query.teacherId || "").trim();
      const courseId = String(req.query.courseId || "").trim();

      const match = { institutionId: toInstitutionObjectId(institutionId) };
      if (activeParam === "true") match.isActive = true;
      if (activeParam === "false") match.isActive = false;

      if (teacherId) {
        if (!mongoose.Types.ObjectId.isValid(teacherId)) {
          return res.status(400).json({
            status: "error",
            message: "Invalid teacherId",
          });
        }
        match.teacherId = new mongoose.Types.ObjectId(teacherId);
      }

      if (courseId) {
        if (!mongoose.Types.ObjectId.isValid(courseId)) {
          return res.status(400).json({
            status: "error",
            message: "Invalid courseId",
          });
        }
        match.courseId = new mongoose.Types.ObjectId(courseId);
      }

      const pipeline = [
        { $match: match },
        {
          $lookup: {
            from: "authusers",
            localField: "teacherId",
            foreignField: "_id",
            as: "teacherId",
          },
        },
        {
          $unwind: {
            path: "$teacherId",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $lookup: {
            from: "courses",
            localField: "courseId",
            foreignField: "_id",
            as: "courseId",
          },
        },
        {
          $unwind: {
            path: "$courseId",
            preserveNullAndEmptyArrays: true,
          },
        },
      ];

      if (q) {
        const regex = new RegExp(escapeRegExp(q), "i");
        pipeline.push({
          $match: {
            $or: [
              { "teacherId.name": regex },
              { "teacherId.email": regex },
              { "courseId.program": regex },
              { "courseId.programVersion": regex },
              { "courseId.code": regex },
              { "courseId.name": regex },
              { "courseId.section": regex },
            ],
          },
        });
      }

      pipeline.push({ $sort: { isActive: -1, createdAt: -1 } });

      let assignments = [];
      let total = 0;
      let page = 1;
      let limit = 0;

      if (!paginate) {
        assignments = await TeacherCourseAssignment.aggregate(pipeline);
        total = assignments.length;
        limit = total || 1;
      } else {
        const pagination = parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 });
        page = pagination.page;
        limit = pagination.limit;
        const skip = pagination.skip;

        const [countRows, pagedRows] = await Promise.all([
          TeacherCourseAssignment.aggregate([...pipeline, { $count: "total" }]),
          TeacherCourseAssignment.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]),
        ]);

        total = countRows[0]?.total || 0;
        assignments = pagedRows;
      }

      return res.json({
        status: "success",
        data: assignments.map(mapAssignment),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / Math.max(limit, 1))),
          hasNext: page * Math.max(limit, 1) < total,
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
  "/assignments",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin"),
  async (req, res) => {
    try {
      const institutionId = resolveInstitutionIdForRequest(req);
      const teacherId = String(req.body.teacherId || "").trim();
      const courseId = String(req.body.courseId || "").trim();

      if (!teacherId || !courseId) {
        return res.status(400).json({
          status: "error",
          message: "teacherId and courseId are required",
        });
      }

      const [teacher, course] = await Promise.all([
        AuthUser.findOne({ _id: teacherId, institutionId }).select("name email role isActive"),
        Course.findOne({ _id: courseId, institutionId }).select("program programVersion code name section daysOfWeek startTime endTime deliveryMode attendancePolicy isActive"),
      ]);

      if (!teacher || teacher.role !== "teacher") {
        return res.status(404).json({
          status: "error",
          message: "Teacher not found",
        });
      }
      if (!teacher.isActive) {
        return res.status(400).json({
          status: "error",
          message: "Teacher is inactive",
        });
      }
      if (!course || !course.isActive) {
        return res.status(404).json({
          status: "error",
          message: "Course not found",
        });
      }

      const assignment = await TeacherCourseAssignment.findOneAndUpdate(
        { institutionId, teacherId: teacher._id, courseId: course._id },
        {
          $set: {
            isActive: true,
            assignedBy: req.authUser._id,
          },
          $setOnInsert: {
            institutionId,
          },
        },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
        }
      )
        .populate("teacherId", "name email role isActive")
        .populate("courseId", "program programVersion code name section daysOfWeek startTime endTime deliveryMode attendancePolicy isActive");

      return res.status(201).json({
        status: "success",
        message: "Teacher assigned to course",
        data: mapAssignment(assignment),
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

router.get(
  "/courses/:courseId/enrollments",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin", "institution_user", "teacher"),
  async (req, res) => {
    try {
      const institutionId = resolveInstitutionIdForRequest(req);
      const courseId = String(req.params.courseId || "").trim();
      if (!courseId) {
        return res.status(400).json({
          status: "error",
          message: "courseId is required",
        });
      }

      const canAccess = await ensureCourseAccess(req.authUser, courseId, institutionId);
      if (!canAccess) {
        return res.status(403).json({
          status: "error",
          message: "You do not have access to this course",
        });
      }

      const query = String(req.query.q || "").trim().toUpperCase();
      const hasPagingParams = req.query.page !== undefined || req.query.limit !== undefined;
      const paginate = hasPagingParams;
      const filter = { institutionId, courseId };
      if (query) {
        filter.$or = [
          { universityRollNo: { $regex: query, $options: "i" } },
          { fullName: { $regex: query, $options: "i" } },
          { section: { $regex: query, $options: "i" } },
          { classRollNo: { $regex: query, $options: "i" } },
        ];
      }

      let rows = [];
      let total = 0;
      let page = 1;
      let limit = 0;

      if (!paginate) {
        rows = await CourseEnrollment.find(filter).sort({
          isActive: -1,
          universityRollNo: 1,
        });
        total = rows.length;
        limit = total || 1;
      } else {
        const pagination = parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 });
        page = pagination.page;
        limit = pagination.limit;
        const skip = pagination.skip;

        [total, rows] = await Promise.all([
          CourseEnrollment.countDocuments(filter),
          CourseEnrollment.find(filter)
            .sort({
              isActive: -1,
              universityRollNo: 1,
            })
            .skip(skip)
            .limit(limit),
        ]);
      }

      return res.json({
        status: "success",
        data: rows.map(mapEnrollment),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / Math.max(limit, 1))),
          hasNext: page * Math.max(limit, 1) < total,
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
  "/courses/:courseId/enrollments",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin"),
  async (req, res) => {
    try {
      const institutionId = resolveInstitutionIdForRequest(req);
      const courseId = String(req.params.courseId || "").trim();
      if (!courseId) {
        return res.status(400).json({
          status: "error",
          message: "courseId is required",
        });
      }

      const normalized = normalizeEnrollmentRow(req.body || {});
      if (normalized.error) {
        return res.status(400).json({
          status: "error",
          message: normalized.error,
        });
      }

      const course = await Course.findOne({ _id: courseId, institutionId, isActive: true }).select("_id");
      if (!course) {
        return res.status(404).json({
          status: "error",
          message: "Course not found",
        });
      }

      const identifierCondition = {
        institutionId,
        courseId,
        $or: [
          { email: normalized.email },
          { universityRollNo: normalized.universityRollNo },
        ],
      };

      const enrollment = await CourseEnrollment.findOneAndUpdate(
        identifierCondition,
        {
          $set: {
            fullName: normalized.fullName,
            section: normalized.section,
            classRollNo: normalized.classRollNo,
            email: normalized.email,
            isActive: req.body.isActive !== false,
            updatedBy: req.authUser._id,
          },
          $setOnInsert: {
            institutionId,
            createdBy: req.authUser._id,
          },
        },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
        }
      );

      return res.status(201).json({
        status: "success",
        message: "Enrollment saved",
        data: mapEnrollment(enrollment),
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
  "/courses/:courseId/enrollments/bulk",
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin"),
  async (req, res) => {
    try {
      const institutionId = resolveInstitutionIdForRequest(req);
      const courseId = String(req.params.courseId || "").trim();
      if (!courseId) {
        return res.status(400).json({
          status: "error",
          message: "courseId is required",
        });
      }

      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (!rows.length) {
        return res.status(400).json({
          status: "error",
          message: "rows must be a non-empty array",
        });
      }

      const replace = req.body?.replace === true;

      const course = await Course.findOne({ _id: courseId, institutionId, isActive: true }).select("_id");
      if (!course) {
        return res.status(404).json({
          status: "error",
          message: "Course not found",
        });
      }

      const normalizedRows = [];
      const errors = [];
      rows.forEach((row, index) => {
        const normalized = normalizeEnrollmentRow(row || {});
        if (normalized.error) {
          errors.push({
            row: index + 1,
            message: normalized.error,
          });
        } else {
          normalizedRows.push(normalized);
        }
      });

      if (errors.length) {
        return res.status(400).json({
          status: "error",
          message: "Invalid rows in bulk enrollment payload",
          errors,
        });
      }

      const uniqueByEmail = new Map();
      normalizedRows.forEach((row) => {
        uniqueByEmail.set(row.email, row);
      });
      const dedupedRows = Array.from(uniqueByEmail.values());

      await Promise.all(
        dedupedRows.map((row) =>
          CourseEnrollment.findOneAndUpdate(
            {
              institutionId,
              courseId,
              $or: [{ email: row.email }, { universityRollNo: row.universityRollNo }],
            },
            {
              $set: {
                fullName: row.fullName,
                section: row.section,
                classRollNo: row.classRollNo,
                email: row.email,
                isActive: true,
                updatedBy: req.authUser._id,
              },
              $setOnInsert: {
                institutionId,
                createdBy: req.authUser._id,
              },
            },
            {
              new: true,
              upsert: true,
              setDefaultsOnInsert: true,
            }
          )
        )
      );

      if (replace) {
        await CourseEnrollment.updateMany(
          {
            institutionId,
            courseId,
            email: { $nin: dedupedRows.map((row) => row.email) },
          },
          {
            $set: {
              isActive: false,
              updatedBy: req.authUser._id,
            },
          }
        );
      }

      const total = await CourseEnrollment.countDocuments({ institutionId, courseId });
      const active = await CourseEnrollment.countDocuments({ institutionId, courseId, isActive: true });

      return res.status(201).json({
        status: "success",
        message: "Bulk enrollment completed",
        data: {
          received: rows.length,
          imported: dedupedRows.length,
          totalEnrollments: total,
          activeEnrollments: active,
          replaceMode: replace,
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

module.exports = router;
