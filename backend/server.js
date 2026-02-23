
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
require("dotenv").config();
const path = require('path');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const crypto = require('crypto');
const net = require("net");
const helmet = require("helmet");
//const sha256 = require('./sha256');
const { execSync } = require('child_process');

// Import models and routes
const User = require("./models/User");
const Attendance = require("./models/Attendance");
const StudentProfile = require("./models/StudentProfile");
const AuthUser = require("./models/AuthUser");
const Institution = require("./models/Institution");
const Course = require("./models/Course");
const CourseEnrollment = require("./models/CourseEnrollment");
const TeacherCourseAssignment = require("./models/TeacherCourseAssignment");
const studentProfileRoutes = require("./routes/studentProfile");
const attendanceRoutes = require("./routes/attendance");
const authRoutes = require("./routes/auth");
const academicRoutes = require("./routes/academic");
const { requireAuth, requireRoles } = require("./middleware/auth");
const {
  resolveInstitutionIdForRequest,
  toInstitutionObjectId,
} = require("./middleware/institution");
const { generateQRCode, validateSession, getSessionDetails } = require('./qr-generator');

// --- NEW: Import algorithm modules ---
// Assuming these files exist in an 'algorithms' directory at the same level as server.js
// And they export functions as described in the thought process.
let dijkstra, profileOptimizer, graphTraversal;
try {
  dijkstra = require('./algorithms/dijkstra');
  profileOptimizer = require('./algorithms/profileOptimizer');
  graphTraversal = require('./algorithms/graphTraversal');
  console.log("Successfully loaded algorithm modules.");
} catch (err) {
  console.warn("Warning: Could not load one or more algorithm modules. Related endpoints might not work.", err.message);
  // Define dummy functions if modules are missing to prevent server crashes on require
  dijkstra = { findShortestPath: () => { throw new Error("Dijkstra module not loaded"); } };
  profileOptimizer = { getProfileRecommendations: () => { throw new Error("ProfileOptimizer module not loaded"); } };
  graphTraversal = { exploreCommunity: () => { throw new Error("GraphTraversal module not loaded"); } };
}
// --- END NEW ---


const requiredEnvVars = ['MONGO_URI'];
requiredEnvVars.forEach(envVar => {
  if (!process.env[envVar]) {
    console.error(`${envVar} environment variable is required`);
    process.exit(1);
  }
});

const app = express();

// Configuration Constants
const ATTENDANCE_REQUIRE_ENROLLMENT = process.env.ATTENDANCE_REQUIRE_ENROLLMENT !== "false";
const COURSE_DELIVERY_MODES = new Set(["in_person", "online", "hybrid"]);
const DEFAULT_ATTENDANCE_POLICY = {
  singleDevicePerDay: true,
  requireSignature: true,
  requireEnrollment: ATTENDANCE_REQUIRE_ENROLLMENT,
  requireIpAllowlist: false,
  ipAllowlist: [],
  requireGeofence: false,
  geofence: {
    lat: null,
    lng: null,
    radiusMeters: 120,
  },
};

const QR_CODE_DIR = path.join(__dirname, '../frontend/public/qrcodes');
const INSTITUTION_LOGO_DIR =
  process.env.INSTITUTION_LOGO_DIR || path.join(__dirname, '../frontend/public/institution-logos');

// Middleware Setup
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": [
          "'self'",
          "https://cdn.tailwindcss.com",
          "https://cdn.jsdelivr.net",
          "'unsafe-inline'"
        ],
        "style-src": [
          "'self'",
          "https://fonts.googleapis.com",
          "https://cdn.jsdelivr.net",
          "https://cdnjs.cloudflare.com",
          "'unsafe-inline'"
        ],
        "font-src": [
          "'self'",
          "https://fonts.gstatic.com",
          "https://cdnjs.cloudflare.com"
        ],
        "img-src": [
          "'self'",
          "data:",
          "https://ui-avatars.com",
          "https:"
        ]
      }
    }
  })
);


app.use(cors());
app.use(express.json({ limit: "6mb" }));
app.use(express.static(path.join(__dirname, '../frontend')));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});


// QR Code Directory Setup
try {
  if (!fs.existsSync(QR_CODE_DIR)) {
    fs.mkdirSync(QR_CODE_DIR, { recursive: true });
    console.log(` Created QR code directory at: ${QR_CODE_DIR}`);
  }

  // Clean up old QR codes on startup
  fs.readdir(QR_CODE_DIR, (err, files) => {
    if (err) {
      console.error('Startup cleanup error:', err);
      return;
    }
    
    const now = Date.now();
    files.forEach(file => {
      if (file.startsWith('qr_') && file.endsWith('.png')) {
        const fileTimestamp = parseInt(file.split('_')[1].split('.')[0]);
        if (isNaN(fileTimestamp) || (now - fileTimestamp > 1.5 * 60 * 1000)) {
          fs.unlink(path.join(QR_CODE_DIR, file), err => {
            if (err) console.error('Error deleting file:', file, err);
          });
        }
      }
    });
  });
  
  app.use('/qrcodes', express.static(QR_CODE_DIR, {
    maxAge: '1h', // Cache for 1 hour
    setHeaders: (res, path) => {
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    }
}));
  console.log(` Serving QR codes from: ${QR_CODE_DIR}`);
} 
catch (err) {
  console.error(' Failed to setup QR code directory:', err);
  process.exit(1);
}

// Institution logo directory setup
try {
  if (!fs.existsSync(INSTITUTION_LOGO_DIR)) {
    fs.mkdirSync(INSTITUTION_LOGO_DIR, { recursive: true });
    console.log(` Created institution logo directory at: ${INSTITUTION_LOGO_DIR}`);
  }

  app.use('/institution-logos', express.static(INSTITUTION_LOGO_DIR, {
    maxAge: '7d',
    setHeaders: (res) => {
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    }
  }));
  console.log(` Serving institution logos from: ${INSTITUTION_LOGO_DIR}`);
} catch (err) {
  console.error(' Failed to setup institution logo directory:', err);
}

// Rate limiting for QR generation
const qrLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  handler: (req, res) => {
    console.log(`Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      status: "error",
      message: "Too many QR requests. Please wait a minute."
    });
  },
  standardHeaders: true,
  legacyHeaders: false
});

async function getAssignedCourseIdsForTeacher(teacherId, institutionId) {
  const assignments = await TeacherCourseAssignment.find({
    institutionId,
    teacherId,
    isActive: true
  }).select("courseId");

  return assignments
    .map((assignment) => assignment.courseId)
    .filter(Boolean)
    .map((courseId) => String(courseId));
}

function buildCourseScopedFilter(courseId, allowedCourseIds, institutionId) {
  if (!Array.isArray(allowedCourseIds)) {
    if (courseId) {
      return { institutionId, courseId };
    }
    return { institutionId };
  }

  if (!allowedCourseIds.length) {
    return null;
  }

  if (courseId) {
    if (!allowedCourseIds.includes(String(courseId))) {
      return "forbidden";
    }
    return { institutionId, courseId };
  }

  return { institutionId, courseId: { $in: allowedCourseIds } };
}


// Routes
app.use("/api/auth", authRoutes);
app.use("/api/academic", academicRoutes);
app.use("/api/students", studentProfileRoutes);
app.use("/api/attendance", attendanceRoutes);

app.get(
  '/api/students/by-attendance-range',
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin", "institution_user"),
  async (req, res) => {
    try {
        const institutionId = resolveInstitutionIdForRequest(req);
        const institutionObjectId = toInstitutionObjectId(institutionId);
        const { min, max } = req.query;
        
        // Validate inputs
        if (!min || !max) {
            return res.status(400).json({ 
                error: 'Both min and max percentage parameters are required' 
            });
        }
        
        const minPercentage = parseFloat(min);
        const maxPercentage = parseFloat(max);
        
        if (isNaN(minPercentage)) {
            return res.status(400).json({ 
                error: 'Minimum percentage must be a number' 
            });
        }
        
        if (isNaN(maxPercentage)) {
            return res.status(400).json({ 
                error: 'Maximum percentage must be a number' 
            });
        }
        
        if (minPercentage < 0 || maxPercentage > 100) {
            return res.status(400).json({ 
                error: 'Percentages must be between 0 and 100' 
            });
        }
        
        if (minPercentage > maxPercentage) {
            return res.status(400).json({ 
                error: 'Minimum percentage cannot be greater than maximum' 
            });
        }

        // Get all unique class dates (for calculating total possible classes)
        const allDates = await Attendance.find({ institutionId }).distinct('date');
        const totalClasses = allDates.length;
        
        if (totalClasses === 0) {
            return res.json({ 
                status: "success", 
                data: [] 
            });
        }

        // Aggregation to get students with attendance in range
       const results = await StudentProfile.aggregate([
    {
        $match: {
            institutionId: institutionObjectId
        }
    },
    {
        $lookup: {
            from: "users",  // Join with User collection
            let: { rollNo: "$universityRollNo", institutionId: "$institutionId" },
            pipeline: [
                {
                    $match: {
                        $expr: {
                            $and: [
                                { $eq: ["$universityRollNo", "$$rollNo"] },
                                { $eq: ["$institutionId", "$$institutionId"] }
                            ]
                        }
                    }
                }
            ],
            as: "user"
        }
    },
    {
        $lookup: {
            from: "attendances",
            let: { rollNo: "$universityRollNo" },
            pipeline: [
                { 
                    $match: { 
                        $expr: { 
                            $and: [
                                { $eq: ["$universityRollNo", "$$rollNo"] },
                                { $eq: ["$status", "present"] },
                                { $eq: ["$institutionId", institutionObjectId] }
                            ]
                        }
                    }
                },
                { $count: "presentDays" }
            ],
            as: "attendance"
        }
    },
    {
        $addFields: {
            presentDays: { $ifNull: [{ $arrayElemAt: ["$attendance.presentDays", 0] }, 0] },
            totalClasses: totalClasses,
            attendancePercentage: {
                $round: [
                    { 
                        $multiply: [
                            { 
                                $divide: [
                                    { $ifNull: [{ $arrayElemAt: ["$attendance.presentDays", 0] }, 0] },
                                    totalClasses
                                ] 
                            },
                            100
                        ] 
                    }
                ]
            },
            // Handle both data structures
            name: {
                $ifNull: [
                    { $arrayElemAt: ["$user.name", 0] },
                    { $arrayElemAt: ["$user.personalInfo.fullName", 0] },
                    "N/A"
                ]
            },
            section: {
                $ifNull: [
                    { $arrayElemAt: ["$user.section", 0] },
                    { $arrayElemAt: ["$user.academicInfo.section", 0] },
                    "N/A"
                ]
            }
        }
    },
    {
        $match: {
            attendancePercentage: { $gte: minPercentage, $lte: maxPercentage }
        }
    },
    {
        $sort: { attendancePercentage: -1 }
    },
    {
        $project: {
            universityRollNo: 1,
            name: 1,
            section: 1,
            attendancePercentage: 1,
            presentDays: 1,
            totalClasses: 1,
            _id: 0
        }
    }
]);

        // --- MANUAL SORTING (Bubble Sort, descending by attendancePercentage) ---
        if (results && results.length > 1) {
            const n = results.length;
            for (let i = 0; i < n - 1; i++) {
                for (let j = 0; j < n - i - 1; j++) {
                    // Sort in descending order of attendancePercentage
                    if (results[j].attendancePercentage < results[j + 1].attendancePercentage) {
                        // Swap elements
                        const temp = results[j];
                        results[j] = results[j + 1];
                        results[j + 1] = temp;
                    }
                }
            }
        }
        // --- END MANUAL SORTING ---

        res.json({ 
            status: "success",
            data: results 
        });

    } catch (error) {
        if (error.status) {
            return res.status(error.status).json({
                status: "error",
                message: error.message
            });
        }
        console.error("Error fetching students by attendance range:", error);
        res.status(500).json({ 
            status: "error", 
            message: error.message 
        });
    }
});
app.get(
  '/api/attendance/dates',
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin", "institution_user", "teacher"),
  async (req, res) => {
  try {
    const institutionId = resolveInstitutionIdForRequest(req);
    const { courseId } = req.query;
    let filter = { institutionId };

    if (req.authUser.role === "teacher") {
      const teacherCourseIds = await getAssignedCourseIdsForTeacher(req.authUser._id, institutionId);
      filter = buildCourseScopedFilter(courseId, teacherCourseIds, institutionId);
      if (filter === null) {
        return res.json({ status: "success", data: [] });
      }
      if (filter === "forbidden") {
        return res.status(403).json({ status: "error", message: "Course not assigned to this teacher" });
      }
    } else {
      filter = buildCourseScopedFilter(courseId, null, institutionId);
    }

    const dates = await Attendance.find(filter).distinct('date');
    res.json({ status: "success", data: dates });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ status: "error", message: error.message });
    }
    console.error("Error fetching attendance dates:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});
app.get(
  '/api/attendance/by-date',
  requireAuth,
  requireRoles("superadmin", "admin", "institution_admin", "institution_user", "teacher"),
  async (req, res) => {
    try {
        const institutionId = resolveInstitutionIdForRequest(req);
        const { date, courseId } = req.query;
        if (!date) {
            return res.status(400).json({ error: 'Date parameter is required' });
        }

        let filter = { institutionId };
        if (req.authUser.role === "teacher") {
            const teacherCourseIds = await getAssignedCourseIdsForTeacher(req.authUser._id, institutionId);
            filter = buildCourseScopedFilter(courseId, teacherCourseIds, institutionId);
            if (filter === null) {
                return res.json({ status: "success", data: [] });
            }
            if (filter === "forbidden") {
                return res.status(403).json({ status: "error", message: "Course not assigned to this teacher" });
            }
        } else {
            filter = buildCourseScopedFilter(courseId, null, institutionId);
        }

        const attendance = await Attendance.find({ 
            ...filter,
            date: date,
            status: 'present'
        }).sort({ universityRollNo: 1 });

        res.json({ 
            status: "success",
            data: attendance 
        });
    } catch (error) {
        if (error.status) {
            return res.status(error.status).json({ status: "error", message: error.message });
        }
        console.error("Error fetching attendance by date:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});
// QR Code Generation Endpoint
// ... (other parts of server.js) ...

// QR Code Generation Endpoint
app.get("/api/generate-qr", requireAuth, requireRoles("teacher"), qrLimiter, async (req, res) => {
  try {
    const institutionId = resolveInstitutionIdForRequest(req);
    const { courseId } = req.query;
    if (!courseId) {
      return res.status(400).json({
        status: "error",
        message: "courseId is required to generate QR"
      });
    }

    const course = await Course.findOne({ _id: courseId, institutionId, isActive: true }).select("code name section");
    if (!course) {
      return res.status(404).json({
        status: "error",
        message: "Course not found"
      });
    }

    if (req.authUser.role === "teacher") {
      const assignment = await TeacherCourseAssignment.findOne({
        institutionId,
        teacherId: req.authUser._id,
        courseId: course._id,
        isActive: true
      }).select("_id");

      if (!assignment) {
        return res.status(403).json({
          status: "error",
          message: "Teacher is not assigned to this course"
        });
      }
    }

    console.log(`Generating QR code for IP: ${req.ip} course=${course.code}-${course.section}`);
    const qrData = await generateQRCode(req.ip, {
      generatedBy: String(req.authUser._id),
      generatedByRole: req.authUser.role,
      generatedByName: req.authUser.name,
      institutionId,
      courseId: String(course._id),
      courseCode: course.code,
      courseName: course.name,
      section: course.section
    });
    
    console.log(` Generated QR code at: ${qrData.qrImage}`);
    res.json({
      status: "success",
      qrImage: qrData.qrImage,
      sessionId: qrData.sessionId,
      expiresIn: qrData.expiresIn,
      sessionContext: qrData.sessionContext
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({
        status: "error",
        message: error.message,
      });
    }
    console.error("QR generation error:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to generate QR code",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ... (rest of server.js) ...
app.post('/api/consistent-hash', async (req, res) => {
    try {
        const { input } = req.body;
        
        if (typeof input !== 'string' || !input.trim()) {
            return res.status(400).json({ error: 'Input must be a non-empty string' });
        }

        const escapedInput = input
            .replace(/"/g, '\\"')
            .replace(/\$/g, '\\$')
            .replace(/`/g, '\\`');

        const command = `java ConsistentHash "${escapedInput}"`;
        
        const result = execSync(command, { 
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'ignore'],
            timeout: 5000
        });

        if (!/^[0-9a-f]{8}$/.test(result.trim())) {
            throw new Error('Invalid hash format from Java');
        }

        res.json({ fingerprint: result.trim() });
    } catch (error) {
        console.error("Consistent hash error:", error);
        const jsHash = consistentHashJS(req.body.input);
        res.status(500).json({ 
            error: 'Java hashing failed. Used JS fallback.',
            fingerprint: jsHash 
        });
    }
});

function consistentHashJS(input) {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

app.post("/api/validate-session", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({
        valid: false,
        message: "Session ID required"
      });
    }

    const sessionDetails = getSessionDetails(sessionId);
    const isValid = Boolean(sessionDetails);
    let courseDeliveryMode = "in_person";
    let attendancePolicy = normalizeAttendancePolicy({}, courseDeliveryMode);

    let institutionBrand = null;
    if (isValid && sessionDetails.institutionId) {
      const institutionId = String(sessionDetails.institutionId);
      if (mongoose.Types.ObjectId.isValid(institutionId)) {
        const institution = await Institution.findById(institutionId).select('name shortName logoUrl');
        if (institution) {
          institutionBrand = {
            id: String(institution._id),
            name: institution.shortName || institution.name || '',
            logoUrl: institution.logoUrl || ''
          };
        }
      }
    }

    if (isValid && sessionDetails.institutionId && sessionDetails.courseId) {
      const institutionId = String(sessionDetails.institutionId);
      const courseId = String(sessionDetails.courseId);
      if (mongoose.Types.ObjectId.isValid(institutionId) && mongoose.Types.ObjectId.isValid(courseId)) {
        const course = await Course.findOne({
          _id: courseId,
          institutionId,
          isActive: true,
        }).select("deliveryMode attendancePolicy code name section");
        if (course) {
          courseDeliveryMode = normalizeDeliveryMode(course.deliveryMode);
          attendancePolicy = normalizeAttendancePolicy(course.attendancePolicy, courseDeliveryMode);
        }
      }
    }

    res.json({
      valid: isValid,
      message: isValid ? "Valid session" : "Invalid or expired session ID",
      session: isValid
        ? {
            policy: {
              singleDevicePerDay: attendancePolicy.singleDevicePerDay,
              requireSignature: attendancePolicy.requireSignature,
              requireEnrollment: attendancePolicy.requireEnrollment,
              requireIpAllowlist: attendancePolicy.requireIpAllowlist,
              requireGeofence: attendancePolicy.requireGeofence,
            },
            institutionId: sessionDetails.institutionId || null,
            institutionBrand,
            courseId: sessionDetails.courseId,
            courseCode: sessionDetails.courseCode,
            courseName: sessionDetails.courseName,
            section: sessionDetails.section,
            courseDeliveryMode,
            requiresLocation: attendancePolicy.requireGeofence === true,
            requiresSignature: attendancePolicy.requireSignature !== false,
          }
        : null
    });
  } catch (error) {
    console.error("Session validation error:", error);
    res.status(500).json({
      valid: false,
      message: "Validation error"
    });
  }
});
app.get('/verify-attendance', (req, res) => {
    try {
        console.log('Raw query data:', req.query.data);
        const dataStr = decodeURIComponent(req.query.data);
        const data = JSON.parse(dataStr);
        console.log('Parsed data:', data);

        if (!data?.sessionId || !data?.timestamp || !data?.hash) {
            console.log('Missing fields in data:', data);
            return res.status(400).send('Invalid QR code data: Missing fields');
        }

        const secretKey = process.env.QR_SECRET_KEY || 'default-secret-key';
        console.log('Using secret key:', secretKey);
        
        const hashInput = data.sessionId + data.timestamp + secretKey;
        console.log('Hash input string:', hashInput);
        
        const expectedHash = sha256(hashInput);
        console.log('Expected hash:', expectedHash);
        console.log('Received hash:', data.hash);

        if (data.hash !== expectedHash) {
            console.log('Hash mismatch details:', {
                input: hashInput,
                expected: expectedHash,
                received: data.hash
            });
            return res.status(400).send('Invalid QR code: Hash mismatch');
        }

        const currentTime = Date.now();
        const qrExpiryTime = 15 * 60 * 1000;
        if (currentTime - data.timestamp > qrExpiryTime) {
            return res.status(400).send('QR code expired');
        }

        const sessionDetails = getSessionDetails(data.sessionId);
        const institutionQuery = sessionDetails?.institutionId
          ? `&institutionId=${encodeURIComponent(String(sessionDetails.institutionId))}`
          : "";
        res.redirect(`/index.html?sessionId=${data.sessionId}${institutionQuery}`);
    }  catch (error) {
        console.error('QR validation error:', error);
        res.status(400).send('Invalid QR code data');
    }
});

function getDistanceFromLatLngInMeters(lat1, lng1, lat2, lng2) {
    try {
        const command = `java Haversine ${lat1} ${lng1} ${lat2} ${lng2}`;
        const result = execSync(command, { 
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'ignore']
        });
        return parseFloat(result.trim());
    } catch (error) {
        console.error("Java Haversine Error:", error.message);
        const toRad = angle => (angle * Math.PI) / 180;
        const R = 6371000;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                  Math.sin(dLng / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }
}

function sha256(input) {
    try {
        const escapedInput = input.replace(/"/g, '\\"');
        const command = `java SHA256 "${escapedInput}"`;
        const result = execSync(command, { 
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'ignore']
        });
        return result.trim();
    } catch (error) {
        console.error("Java SHA-256 Error:", error.message);
        // Fallback to crypto module if Java fails (more robust)
        console.warn("Java SHA-256 failed. Using Node.js crypto fallback.");
        return crypto.createHash('sha256').update(input).digest('hex');
        // throw new Error("Failed to compute SHA-256 hash"); // Original behavior
    }
}

function normalizeUpper(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function namesMatch(left, right) {
  if (!left || !right) return true;
  return normalizeName(left) === normalizeName(right);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^$()|[\]\\]/g, "\\$&");
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
  if (!COURSE_DELIVERY_MODES.has(normalized)) return "in_person";
  return normalized;
}

function normalizeIpAllowlist(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function normalizeAttendancePolicy(rawPolicy, deliveryMode = "in_person") {
  const source = rawPolicy && typeof rawPolicy === "object" ? rawPolicy : {};
  const geofenceSource = source.geofence && typeof source.geofence === "object" ? source.geofence : {};

  return {
    deliveryMode,
    singleDevicePerDay: normalizeBoolean(source.singleDevicePerDay, DEFAULT_ATTENDANCE_POLICY.singleDevicePerDay),
    requireSignature: normalizeBoolean(source.requireSignature, DEFAULT_ATTENDANCE_POLICY.requireSignature),
    requireEnrollment: normalizeBoolean(source.requireEnrollment, DEFAULT_ATTENDANCE_POLICY.requireEnrollment),
    requireIpAllowlist: normalizeBoolean(source.requireIpAllowlist, DEFAULT_ATTENDANCE_POLICY.requireIpAllowlist),
    ipAllowlist: normalizeIpAllowlist(source.ipAllowlist),
    requireGeofence: normalizeBoolean(source.requireGeofence, DEFAULT_ATTENDANCE_POLICY.requireGeofence),
    geofence: {
      lat: toNullableNumber(geofenceSource.lat),
      lng: toNullableNumber(geofenceSource.lng),
      radiusMeters: Math.max(
        10,
        Math.min(100000, toNullableNumber(geofenceSource.radiusMeters) ?? DEFAULT_ATTENDANCE_POLICY.geofence.radiusMeters)
      ),
    },
  };
}

function normalizeClientIp(value) {
  const first = String(value || "").split(",")[0].trim().toLowerCase();
  if (!first) return "";
  return first.startsWith("::ffff:") ? first.slice(7) : first;
}

function getClientIpFromRequest(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return normalizeClientIp(forwarded);
  return normalizeClientIp(req.ip || req.socket?.remoteAddress || "");
}

function ipv4ToInt(ipv4) {
  const parts = String(ipv4 || "").split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const numeric = Number(part);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 255) return null;
    value = (value << 8) + numeric;
  }
  return value >>> 0;
}

function isIpv4CidrMatch(ip, cidr) {
  const [baseIp, prefixLengthRaw] = String(cidr || "").split("/");
  const prefixLength = Number(prefixLengthRaw);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(baseIp);
  if (ipInt === null || baseInt === null) return false;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isIpAllowedByAllowlist(clientIp, allowlist) {
  const ip = normalizeClientIp(clientIp);
  if (!ip || !Array.isArray(allowlist) || !allowlist.length) return false;

  return allowlist.some((entryRaw) => {
    const entry = normalizeClientIp(entryRaw);
    if (!entry) return false;

    if (entry.includes("/")) {
      return isIpv4CidrMatch(ip, entry);
    }

    if (net.isIP(ip) && net.isIP(entry) && ip === entry) return true;
    return ip === entry;
  });
}

function normalizeSignatureDataUrl(value) {
  return String(value || "").trim();
}

function validateSignatureDataUrl(signatureDataUrl) {
  if (!signatureDataUrl) {
    return "Signature is required";
  }

  if (!signatureDataUrl.startsWith("data:image/png;base64,")) {
    return "Invalid signature format";
  }

  if (signatureDataUrl.length > 700000) {
    return "Signature image is too large";
  }

  const base64 = signatureDataUrl.split(",")[1] || "";
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) {
    return "Invalid signature encoding";
  }

  let buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch (error) {
    return "Invalid signature data";
  }

  if (!buffer || buffer.length < 120 || buffer.length > 500000) {
    return "Invalid signature data size";
  }

  return null;
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    dbState: mongoose.connection.readyState,
    uptime: process.uptime()
  });
});

function validateAttendance(req, res, next) {
  const required = ['name', 'email', 'deviceFingerprint'];
  const missing = required.filter((field) => !req.body[field]);

  if (missing.length) {
    return res.status(400).json({
      status: 'error',
      message: `Missing required fields: ${missing.join(', ')}`,
    });
  }

  next();
}

app.post('/mark-attendance', validateAttendance, async (req, res) => {
  try {
    const { deviceFingerprint, sessionId } = req.body;
    const normalizedSignatureDataUrl = normalizeSignatureDataUrl(req.body.signatureDataUrl);
    const submittedEmail = normalizeEmail(req.body.email);
    const submittedName = String(req.body.name || '').trim();
    const parsedLocation = req.body.location && typeof req.body.location === "object"
      ? {
          lat: Number(req.body.location.lat),
          lng: Number(req.body.location.lng),
        }
      : null;
    const hasValidLocation = Boolean(
      parsedLocation &&
      Number.isFinite(parsedLocation.lat) &&
      Number.isFinite(parsedLocation.lng)
    );

    if (!sessionId) {
      return res.status(400).json({
        status: 'error',
        message: 'Session ID is required',
      });
    }

    if (!submittedName) {
      return res.status(400).json({
        status: 'error',
        message: 'Full name is required',
      });
    }

    if (!isValidEmail(submittedEmail)) {
      return res.status(400).json({
        status: 'error',
        message: 'Valid email is required',
      });
    }

    const sessionDetails = getSessionDetails(sessionId);
    if (!sessionDetails) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid or expired session. Please scan a fresh QR.',
      });
    }

    if (!sessionDetails.courseId) {
      return res.status(400).json({
        status: 'error',
        message: 'Session is not linked to a course',
      });
    }

    if (!sessionDetails.institutionId) {
      return res.status(400).json({
        status: 'error',
        message: 'Session is not linked to an institution',
      });
    }

    const institutionId = String(sessionDetails.institutionId);
    const today = new Date().toISOString().split('T')[0];
    const clientIp = getClientIpFromRequest(req);
    const userAgent = String(req.headers["user-agent"] || "");

    const course = await Course.findOne({
      _id: sessionDetails.courseId,
      institutionId,
      isActive: true,
    }).select("code name section deliveryMode attendancePolicy");
    if (!course) {
      return res.status(404).json({
        status: "error",
        message: "Course not found or inactive",
      });
    }
    const deliveryMode = normalizeDeliveryMode(course.deliveryMode);
    const attendancePolicy = normalizeAttendancePolicy(course.attendancePolicy, deliveryMode);

    if (attendancePolicy.requireIpAllowlist) {
      if (!attendancePolicy.ipAllowlist.length) {
        return res.status(400).json({
          status: "error",
          message: "Course policy requires IP allowlist but no ranges are configured",
        });
      }
      if (!isIpAllowedByAllowlist(clientIp, attendancePolicy.ipAllowlist)) {
        return res.status(403).json({
          status: "error",
          message: "Attendance is only allowed from approved campus network ranges",
        });
      }
    }

    let distance = null;
    if (attendancePolicy.requireGeofence) {
      if (!hasValidLocation) {
        return res.status(400).json({
          status: "error",
          message: "This course requires geolocation. Enable location and try again.",
        });
      }
      const geofenceLat = attendancePolicy.geofence?.lat;
      const geofenceLng = attendancePolicy.geofence?.lng;
      const geofenceRadius = attendancePolicy.geofence?.radiusMeters || 120;
      if (!Number.isFinite(geofenceLat) || !Number.isFinite(geofenceLng)) {
        return res.status(400).json({
          status: "error",
          message: "Course geofence is not configured. Contact your administrator.",
        });
      }
      distance = getDistanceFromLatLngInMeters(parsedLocation.lat, parsedLocation.lng, geofenceLat, geofenceLng);
      if (distance > geofenceRadius) {
        return res.status(400).json({
          status: "error",
          message: `You must be within ${geofenceRadius} meters of the class location. Current distance: ${distance.toFixed(0)}m`,
        });
      }
    }

    if (attendancePolicy.requireSignature) {
      const signatureValidationError = validateSignatureDataUrl(normalizedSignatureDataUrl);
      if (signatureValidationError) {
        return res.status(400).json({
          status: 'error',
          message: signatureValidationError,
        });
      }
    } else if (normalizedSignatureDataUrl) {
      const optionalSignatureError = validateSignatureDataUrl(normalizedSignatureDataUrl);
      if (optionalSignatureError) {
        return res.status(400).json({
          status: "error",
          message: optionalSignatureError,
        });
      }
    }

    const signatureHash = normalizedSignatureDataUrl
      ? crypto.createHash('sha256').update(normalizedSignatureDataUrl.split(',')[1]).digest('hex')
      : null;

    const nameRegex = new RegExp(`^${escapeRegex(submittedName)}$`, 'i');
    const enrollment = await CourseEnrollment.findOne({
      institutionId,
      courseId: sessionDetails.courseId,
      isActive: true,
      $or: [
        { universityRollNo: submittedEmail },
        { universityRollNo: submittedEmail.toUpperCase() },
        { fullName: nameRegex },
      ],
    });

    if (!enrollment && attendancePolicy.requireEnrollment) {
      return res.status(400).json({
        status: "error",
        message: "You are not enrolled in this course roster",
      });
    }

    if (enrollment && !namesMatch(enrollment.fullName, submittedName)) {
      return res.status(400).json({
        status: 'error',
        message: 'Student name does not match course enrollment record',
      });
    }

    const canonicalStudentId = submittedEmail;
    const canonicalName = enrollment?.fullName || submittedName;
    const canonicalSection = enrollment?.section || normalizeUpper(course.section || sessionDetails.section || '') || 'N/A';
    const canonicalClassRollNo = enrollment?.classRollNo || 'N/A';

    const [existing, existingDevice] = await Promise.all([
      Attendance.findOne({
        institutionId,
        date: today,
        courseId: sessionDetails.courseId,
        $or: [{ studentEmail: canonicalStudentId }, { universityRollNo: canonicalStudentId }],
      }),
      attendancePolicy.singleDevicePerDay
        ? Attendance.findOne({ institutionId, deviceFingerprint, date: today, courseId: sessionDetails.courseId })
        : Promise.resolve(null),
    ]);

    if (existing) {
      return res.status(400).json({
        status: 'error',
        message: "You've already marked attendance for this course today",
      });
    }

    if (attendancePolicy.singleDevicePerDay && existingDevice) {
      return res.status(400).json({
        status: 'error',
        message: 'This device has already been used for this course today',
      });
    }

    const student = await User.findOneAndUpdate(
      { institutionId, universityRollNo: canonicalStudentId },
      {
        $set: {
          name: canonicalName,
          email: canonicalStudentId,
        },
        $setOnInsert: {
          institutionId,
          section: canonicalSection,
          classRollNo: canonicalClassRollNo,
        },
      },
      { new: true, upsert: true }
    );

    const attendance = await Attendance.create({
      institutionId,
      name: canonicalName,
      studentEmail: canonicalStudentId,
      universityRollNo: canonicalStudentId,
      section: canonicalSection,
      classRollNo: canonicalClassRollNo,
      date: today,
      time: new Date().toLocaleTimeString('en-IN', { hour12: false }),
      sessionId,
      courseId: sessionDetails.courseId,
      courseCode: course.code || sessionDetails.courseCode,
      courseName: course.name || sessionDetails.courseName,
      generatedBy: sessionDetails.generatedBy,
      generatedByRole: sessionDetails.generatedByRole,
      status: 'present',
      studentId: student._id,
      distanceFromClass: distance,
      location: hasValidLocation ? parsedLocation : undefined,
      deviceFingerprint,
      signatureDataUrl: normalizedSignatureDataUrl || undefined,
      signatureHash: signatureHash || undefined,
      ipAddress: clientIp || null,
      userAgent,
      courseDeliveryMode: deliveryMode,
      attendancePolicySnapshot: attendancePolicy,
    });

    res.json({
      status: 'success',
      message: 'Attendance marked successfully',
      data: attendance,
    });
  } catch (error) {
    console.error('Attendance error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});
app.get('/api/students/profile', async (req, res) => {
    try {
        const { rollNo } = req.query;
        const institutionId = String(req.query.institutionId || "").trim();
        console.log(`[PROFILE] Attempting to find profile for rollNo: ${rollNo}`); // ADD THIS
        const filter = { universityRollNo: rollNo };
        if (institutionId) filter.institutionId = institutionId;
        const student = await StudentProfile.findOne(filter);
        
        if (!student) {
            console.log(`[PROFILE] Student not found: ${rollNo}`); // ADD THIS
            return res.status(404).json({ error: 'Student not found' });
        }
        console.log(`[PROFILE] Student found:`, student); // ADD THIS
        res.json({ data: student });
    } catch (error) {
        console.error(`[PROFILE] Error fetching profile for ${rollNo}:`, error); // ADD THIS
        res.status(500).json({ error: error.message });
    }
});
app.get('/api/students/notifications', async (req, res) => {
  const { rollNo } = req.query;
  // TODO: Replace with real data lookup
  const dummyNotifications = [
    { text: "Assignment deadline extended!", timestamp: new Date(), read: false },
    { text: "New grades posted.", timestamp: new Date(), read: true }
  ];
  res.json({ data: dummyNotifications });
});

app.post('/api/students/notifications/read', (req, res) => {
  const { rollNo } = req.body;
  // TODO: Implement actual DB update here
  console.log(`Marking all notifications as read for rollNo: ${rollNo}`);
  res.json({ status: 'success' });
});

app.get("/api/students/:rollNo/attendance", async (req, res) => {
    try {
        const { rollNo } = req.params;
        const period = req.query.period || 'current';
        const institutionId = String(req.query.institutionId || "").trim();
        
        const studentFilter = { universityRollNo: rollNo };
        if (institutionId) studentFilter.institutionId = institutionId;
        const student = await StudentProfile.findOne(studentFilter);
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }

        const dateRange = {
            current: () => ({ 
                start: new Date(new Date().setMonth(new Date().getMonth() - 4)), 
                end: new Date() 
            }),
            last: () => ({ 
                start: new Date(new Date().setMonth(new Date().getMonth() - 8)), 
                end: new Date(new Date().setMonth(new Date().getMonth() - 4)) 
            }),
            year: () => ({ 
                start: new Date(new Date().setFullYear(new Date().getFullYear() - 1)), 
                end: new Date() 
            })
        };

        const { start, end } = dateRange[period] ? dateRange[period]() : dateRange.current();

        const attendanceFilterBase = {};
        if (institutionId) attendanceFilterBase.institutionId = institutionId;

        const allAttendance = await Attendance.find({
            ...attendanceFilterBase,
            date: {
                $gte: new Date(start).toISOString().split('T')[0],
                $lte: new Date(end).toISOString().split('T')[0]
            }
        }).distinct('date');

        const totalClasses = allAttendance.length;

        const attendance = await Attendance.find({
            ...attendanceFilterBase,
            universityRollNo: rollNo,
            date: {
                $gte: new Date(start).toISOString().split('T')[0],
                $lte: new Date(end).toISOString().split('T')[0]
            }
        }).sort({ date: 1 });

        const presentDays = attendance.filter(a => a.status === 'present').length;
        const percentage = totalClasses > 0 ? Math.round((presentDays / totalClasses) * 100) : 0;

        const monthlyData = attendance.reduce((acc, record) => {
            const monthYear = new Date(record.date).toLocaleString('default', { month: 'short', year: 'numeric' });
            if (!acc[monthYear]) acc[monthYear] = { present: 0, total: 0 };
            // This total might be per student, not overall if a class was held but student was absent.
            // For overall total, we'd need all class dates.
            // The current logic for monthlyData seems to count days the student had a record.
            // Let's assume for now this is fine for the chart.
            const dateKey = new Date(record.date).toISOString().split('T')[0];
            // Count total based on all class dates in that month
            // This part is tricky, depends on how `allAttendance` (all unique class dates) is used here.
            // For simplicity, current approach is okay.
            acc[monthYear].total++; // This counts student's records
            if (record.status === 'present') acc[monthYear].present++;
            return acc;
        }, {});

        const labels = Object.keys(monthlyData);
        const studentAttendance = labels.map(label => 
            monthlyData[label].total > 0 ? Math.round((monthlyData[label].present / monthlyData[label].total) * 100) : 0
        );

        res.json({
            status: "success",
            data: {
                attendanceRecords: attendance,
                attendancePercentage: percentage,
                totalClasses: totalClasses,
                presentDays: presentDays,
                chartData: {
                    labels,
                    studentAttendance,
                    departmentAverage: studentAttendance.map(p => Math.max(70, Math.min(95, p + (Math.random() * 10 - 5))))
                }
            }
        });

    } catch (error) {
        console.error("Error fetching attendance:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});
app.get('/api/students/:rollNo/documents', async (req, res) => {
  const { rollNo } = req.params;
  // Dummy data, replace with DB lookup
  res.json({
    data: {
      idCardUrl: null, // or 'path/to/idcard.pdf'
      resumeUrl: null, // or 'path/to/resume.pdf'
      feeReceipts: [], // or [{ name: 'Sem1_Receipt.pdf', url: '...' }]
      gradeSheets: []  // or [{ name: 'Sem1_Grades.pdf', url: '...' }]
    }
  });
});


// --- NEW ALGORITHM ENDPOINTS ---

// Dijkstra: Shortest path from hostel to class
app.get('/api/navigation/shortest-path', async (req, res) => {
    try {
        const { start, end } = req.query;
        if (!start || !end) {
            return res.status(400).json({ status: "error", message: "Start and end locations are required." });
        }

        // Placeholder: graphData should represent your campus map (nodes, edges, weights)
        // This would typically be loaded from a database or a configuration file.
        const graphData = {
            nodes: ["HostelA", "HostelB", "Library", "Mess", "AdminBuilding", "CSEDept", "ECEdept", "MainGate"],
            edges: [
                { from: "HostelA", to: "Mess", weight: 5 }, // weight could be distance in meters or time in minutes
                { from: "HostelA", to: "Library", weight: 7 },
                { from: "Mess", to: "CSEDept", weight: 10 },
                { from: "Library", to: "CSEDept", weight: 6 },
                { from: "Library", to: "AdminBuilding", weight: 3 },
                { from: "AdminBuilding", to: "ECEdept", weight: 4 },
                { from: "CSEDept", to: "ECEdept", weight: 2 },
                { from: "MainGate", to: "HostelA", weight: 15 },
                { from: "MainGate", to: "AdminBuilding", weight: 8 },
            ]
        };
        
        if (!graphData.nodes.includes(start) || !graphData.nodes.includes(end)) {
             return res.status(404).json({ status: "error", message: "One or both locations not found in map data." });
        }

        const result = dijkstra.findShortestPath(start, end, graphData);
        
        if (!result || result.path.length === 0) {
            return res.status(404).json({ status: "success", message: `No path found from ${start} to ${end}.`, data: result });
        }

        res.json({ status: "success", data: result });

    } catch (error) {
        console.error("Dijkstra shortest path error:", error);
        if (error.message.includes("module not loaded")) {
             return res.status(501).json({ status: "error", message: "Navigation module is not available." });
        }
        res.status(500).json({ status: "error", message: error.message });
    }
});

// Knapsack/DP: Optimize profile recommendations
app.get('/api/students/:rollNo/recommendations', async (req, res) => {
    const { rollNo } = req.params;
    const { type } = req.query; // e.g., "course", "job", "skill"
    const institutionId = String(req.query.institutionId || "").trim();

    if (!type) {
        return res.status(400).json({ status: "error", message: "Recommendation type is required (e.g., 'course', 'job')." });
    }

    try {
        const profileFilter = { universityRollNo: rollNo };
        if (institutionId) profileFilter.institutionId = institutionId;
        const studentProfile = await StudentProfile.findOne(profileFilter);
        if (!studentProfile) {
            return res.status(404).json({ status: "error", message: "Student profile not found." });
        }

        // Placeholder: availableItems would come from a database or configuration
        // This is highly dependent on the 'type' of recommendation
        let availableItems = [];
        if (type === "course") {
            availableItems = [
                { id: "CS101", name: "Intro to Programming", difficulty: 2, relevance_tags: ["programming", "beginner"] },
                { id: "CS305", name: "Machine Learning", difficulty: 4, relevance_tags: ["ai", "ml", "advanced", "math"] },
                { id: "DS202", name: "Data Structures", difficulty: 3, relevance_tags: ["programming", "core"] },
                { id: "EE201", name: "Basic Electronics", difficulty: 3, relevance_tags: ["electronics", "hardware"] },
            ];
        } else if (type === "job") {
            availableItems = [
                { id: "JOB01", title: "Software Dev Intern", required_skills: ["javascript", "nodejs"], company: "TechCorp" },
                { id: "JOB02", title: "Data Analyst", required_skills: ["python", "sql", "statistics"], company: "DataDrivenLLC" },
                { id: "JOB03", title: "Hardware Engineer", required_skills: ["verilog", "circuit design"], company: "ChipMakers" },
            ];
        } else {
            return res.status(400).json({ status: "error", message: "Unsupported recommendation type." });
        }
        
        const recommendations = profileOptimizer.getProfileRecommendations(studentProfile.toObject(), type, availableItems);
        
        res.json({ status: "success", data: recommendations });

    } catch (error) {
        console.error("Profile recommendation error:", error);
         if (error.message.includes("module not loaded")) {
             return res.status(501).json({ status: "error", message: "Recommendation module is not available." });
        }
        res.status(500).json({ status: "error", message: error.message });
    }
});

// DFS/BFS: Community network or graph-based friend explorer
app.get('/api/students/:rollNo/community', async (req, res) => {
    const { rollNo } = req.params;
    const depth = parseInt(req.query.depth) || 2; // Default depth
    const algorithm = req.query.algorithm || 'bfs'; // 'bfs' or 'dfs'
    const institutionId = String(req.query.institutionId || "").trim();

    if (algorithm !== 'bfs' && algorithm !== 'dfs') {
        return res.status(400).json({ status: "error", message: "Invalid algorithm type. Use 'bfs' or 'dfs'." });
    }
    if (depth <= 0 || depth > 5) { // Cap depth to prevent excessive computation
        return res.status(400).json({ status: "error", message: "Depth must be between 1 and 5." });
    }

    try {
        const studentFilter = { universityRollNo: rollNo };
        if (institutionId) studentFilter.institutionId = institutionId;
        const studentExists = await StudentProfile.findOne(studentFilter).select('_id');
        if (!studentExists) {
            return res.status(404).json({ status: "error", message: "Starting student profile not found." });
        }

        // Placeholder: graphData representing student connections (friendships, classmates, project partners)
        // This would typically be constructed by querying relationships from the database.
        // For example, find all students in the same section, or explicit friend connections.
        // Let's mock a simple graph structure for now.
        const allStudents = await StudentProfile.find(institutionId ? { institutionId } : {})
          .select('universityRollNo name section')
          .lean();
        const mockConnections = [ // Simulate some connections
            { from: allStudents[0]?.universityRollNo, to: allStudents[1]?.universityRollNo, type: "classmate" },
            { from: allStudents[0]?.universityRollNo, to: allStudents[2]?.universityRollNo, type: "project_partner" },
            { from: allStudents[1]?.universityRollNo, to: allStudents[3]?.universityRollNo, type: "classmate" },
        ].filter(c => c.from && c.to); // Filter out undefined if not enough students

        const graphData = {
            students: allStudents.map(s => ({ id: s.universityRollNo, name: s.name, section: s.section })),
            connections: mockConnections
        };
        
        const communityData = graphTraversal.exploreCommunity(rollNo, graphData, depth, algorithm);
        
        res.json({ status: "success", data: communityData });

    } catch (error) {
        console.error("Community exploration error:", error);
        if (error.message.includes("module not loaded")) {
             return res.status(501).json({ status: "error", message: "Graph traversal module is not available." });
        }
        res.status(500).json({ status: "error", message: error.message });
    }
});

// --- END NEW ALGORITHM ENDPOINTS ---


// Error Handlers
app.use((req, res) => {
  res.status(404).json({ status: "error", message: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error(" Server error:", {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    url: req.url,
    method: req.method
  });
  res.status(500).json({ status: "error", message: "Internal server error" });
});

async function dropIndexIfExists(model, indexName) {
  try {
    const exists = await model.collection.indexExists(indexName);
    if (exists) {
      await model.collection.dropIndex(indexName);
      console.log(`Dropped legacy index: ${model.collection.collectionName}.${indexName}`);
    }
  } catch (error) {
    const message = String(error?.message || "");
    if (message.includes("index not found")) return;
    console.warn(`Could not drop index ${model.collection.collectionName}.${indexName}: ${message}`);
  }
}

async function ensureDefaultInstitutionAndBackfill() {
  let defaultInstitution = await Institution.findOne({ code: "MAIN" }).select("_id name code");
  if (!defaultInstitution) {
    defaultInstitution = await Institution.findOne().sort({ createdAt: 1 }).select("_id name code");
  }

  if (!defaultInstitution) {
    defaultInstitution = await Institution.create({
      name: "Main Institution",
      code: "MAIN",
      isActive: true,
      createdBy: null,
    });
    console.log("Created default institution MAIN");
  }

  const defaultInstitutionId = defaultInstitution._id;
  const missingInstitutionFilter = {
    $or: [{ institutionId: { $exists: false } }, { institutionId: null }],
  };

  const [authUsers, courses, assignments, enrollments, attendances, users, profiles] =
    await Promise.all([
      AuthUser.updateMany(missingInstitutionFilter, { $set: { institutionId: defaultInstitutionId } }),
      Course.updateMany(missingInstitutionFilter, { $set: { institutionId: defaultInstitutionId } }),
      TeacherCourseAssignment.updateMany(missingInstitutionFilter, { $set: { institutionId: defaultInstitutionId } }),
      CourseEnrollment.updateMany(missingInstitutionFilter, { $set: { institutionId: defaultInstitutionId } }),
      Attendance.updateMany(missingInstitutionFilter, { $set: { institutionId: defaultInstitutionId } }),
      User.updateMany(missingInstitutionFilter, { $set: { institutionId: defaultInstitutionId } }),
      StudentProfile.updateMany(missingInstitutionFilter, { $set: { institutionId: defaultInstitutionId } }),
    ]);

  console.log(
    "Institution backfill:",
    {
      authUsers: authUsers.modifiedCount || 0,
      courses: courses.modifiedCount || 0,
      assignments: assignments.modifiedCount || 0,
      enrollments: enrollments.modifiedCount || 0,
      attendances: attendances.modifiedCount || 0,
      users: users.modifiedCount || 0,
      profiles: profiles.modifiedCount || 0,
    }
  );

  return defaultInstitution;
}

async function ensureIndexes() {
  await dropIndexIfExists(Course, "course_code_section_idx");
  await dropIndexIfExists(TeacherCourseAssignment, "teacher_course_unique_idx");
  await dropIndexIfExists(CourseEnrollment, "course_enrollment_unique_idx");
  await dropIndexIfExists(CourseEnrollment, "course_section_classroll_idx");
  await dropIndexIfExists(CourseEnrollment, "enrollment_rollno_idx");
  await dropIndexIfExists(StudentProfile, "student_rollno_profile_idx");
  await dropIndexIfExists(StudentProfile, "universityRollNo_1");
  await dropIndexIfExists(User, "universityRollNo_1");
  await dropIndexIfExists(Attendance, "student_course_date_attendance_idx");
  await dropIndexIfExists(Attendance, "device_course_date_attendance_idx");
  await dropIndexIfExists(Attendance, "course_date_attendance_idx");

  await Institution.createIndexes([
    { key: { code: 1 }, name: "institution_code_unique_idx", unique: true },
    { key: { name: 1 }, name: "institution_name_unique_idx", unique: true },
  ]);

  await Attendance.createIndexes([
    { key: { institutionId: 1, universityRollNo: 1, courseId: 1, date: 1 }, name: "institution_student_course_date_attendance_idx" },
    { key: { institutionId: 1, deviceFingerprint: 1, courseId: 1, date: 1 }, name: "institution_device_course_date_attendance_idx" },
    { key: { institutionId: 1, courseId: 1, date: 1 }, name: "institution_course_date_attendance_idx" },
  ]);
  await StudentProfile.createIndexes([
    { key: { institutionId: 1, universityRollNo: 1 }, name: "institution_student_rollno_profile_idx", unique: true },
  ]);
  await User.createIndexes([
    { key: { institutionId: 1, universityRollNo: 1 }, name: "institution_user_rollno_unique_idx", unique: true },
  ]);
  await AuthUser.createIndexes([
    { key: { email: 1 }, name: "authuser_email_idx", unique: true },
    { key: { institutionId: 1, role: 1, isActive: 1, name: 1 }, name: "authuser_institution_role_active_name_idx" },
  ]);
  await Course.createIndexes([
    { key: { institutionId: 1, code: 1, section: 1 }, name: "institution_course_code_section_idx", unique: true },
  ]);
  await TeacherCourseAssignment.createIndexes([
    { key: { institutionId: 1, teacherId: 1, courseId: 1 }, name: "institution_teacher_course_unique_idx", unique: true },
  ]);
  await CourseEnrollment.createIndexes([
    { key: { institutionId: 1, courseId: 1, universityRollNo: 1 }, name: "institution_course_enrollment_unique_idx", unique: true },
    { key: { institutionId: 1, courseId: 1, section: 1, classRollNo: 1 }, name: "institution_course_section_classroll_idx" },
    { key: { institutionId: 1, universityRollNo: 1 }, name: "institution_enrollment_rollno_idx" },
  ]);
}

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log(" Connected to MongoDB");
    try {
      const defaultInstitution = await ensureDefaultInstitutionAndBackfill();
      await ensureIndexes();
      console.log(
        "Indexes ensured/created with institution scope for Attendance, StudentProfile, User, AuthUser, Course, TeacherCourseAssignment and CourseEnrollment.",
      );
      console.log(`Active default institution: ${defaultInstitution.name} (${defaultInstitution.code})`);
    } catch (err) {
      console.error("Index creation/ensuring error:", err);
    }
  })
  .catch(err => {
    console.error(" MongoDB connection error:", err);
    process.exit(1);
  });

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
