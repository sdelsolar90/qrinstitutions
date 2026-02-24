const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Institution = require("../models/Institution");
const AuthUser = require("../models/AuthUser");
const Course = require("../models/Course");
const TeacherCourseAssignment = require("../models/TeacherCourseAssignment");
const CourseEnrollment = require("../models/CourseEnrollment");
const Attendance = require("../models/Attendance");
const User = require("../models/User");
const StudentProfile = require("../models/StudentProfile");

const DEFAULTS = {
  reset: true,
  institutions: 5,
  teachersPerInstitution: 20,
  institutionUsersPerInstitution: 3,
  coursesPerInstitution: 1000,
  studentsPerInstitution: 1200,
  enrollmentsPerCourse: 25,
  attendanceRowsPerCourse: 8,
  seedPrefix: "TST",
  timezone: "America/Lima",
  defaultPassword: "Test12345!",
  superadminEmail: "superadmin@enigma.test",
  superadminName: "Platform Superadmin",
  platformAdminEmail: "admin@enigma.test",
  platformAdminName: "Platform Admin",
  batchSize: 1500,
};

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number.parseInt(String(raw), 10);
  return Number.isFinite(value) ? value : fallback;
}

function envBool(name, fallback) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function buildConfig() {
  return {
    reset: envBool("SEED_RESET", DEFAULTS.reset),
    institutions: Math.max(1, envInt("SEED_INSTITUTIONS", DEFAULTS.institutions)),
    teachersPerInstitution: Math.max(
      1,
      envInt("SEED_TEACHERS_PER_INSTITUTION", DEFAULTS.teachersPerInstitution)
    ),
    institutionUsersPerInstitution: Math.max(
      1,
      envInt(
        "SEED_INSTITUTION_USERS_PER_INSTITUTION",
        DEFAULTS.institutionUsersPerInstitution
      )
    ),
    coursesPerInstitution: Math.max(
      1,
      envInt("SEED_COURSES_PER_INSTITUTION", DEFAULTS.coursesPerInstitution)
    ),
    studentsPerInstitution: Math.max(
      1,
      envInt("SEED_STUDENTS_PER_INSTITUTION", DEFAULTS.studentsPerInstitution)
    ),
    enrollmentsPerCourse: Math.max(
      1,
      envInt("SEED_ENROLLMENTS_PER_COURSE", DEFAULTS.enrollmentsPerCourse)
    ),
    attendanceRowsPerCourse: Math.max(
      0,
      envInt("SEED_ATTENDANCE_ROWS_PER_COURSE", DEFAULTS.attendanceRowsPerCourse)
    ),
    seedPrefix: String(process.env.SEED_PREFIX || DEFAULTS.seedPrefix)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8) || DEFAULTS.seedPrefix,
    timezone: String(process.env.SEED_TIMEZONE || DEFAULTS.timezone).trim() || DEFAULTS.timezone,
    defaultPassword:
      String(process.env.SEED_DEFAULT_PASSWORD || DEFAULTS.defaultPassword).trim() ||
      DEFAULTS.defaultPassword,
    superadminEmail:
      String(process.env.SEED_SUPERADMIN_EMAIL || DEFAULTS.superadminEmail)
        .trim()
        .toLowerCase() || DEFAULTS.superadminEmail,
    superadminName:
      String(process.env.SEED_SUPERADMIN_NAME || DEFAULTS.superadminName).trim() ||
      DEFAULTS.superadminName,
    platformAdminEmail:
      String(process.env.SEED_PLATFORM_ADMIN_EMAIL || DEFAULTS.platformAdminEmail)
        .trim()
        .toLowerCase() || DEFAULTS.platformAdminEmail,
    platformAdminName:
      String(process.env.SEED_PLATFORM_ADMIN_NAME || DEFAULTS.platformAdminName).trim() ||
      DEFAULTS.platformAdminName,
    batchSize: Math.max(250, envInt("SEED_BATCH_SIZE", DEFAULTS.batchSize)),
  };
}

function pad(num, size) {
  return String(num).padStart(size, "0");
}

function addMinutesToTime(time, delta) {
  const [h, m] = String(time || "08:00")
    .split(":")
    .map((part) => Number.parseInt(part, 10));
  let total = (h * 60 + m + delta) % (24 * 60);
  if (total < 0) total += 24 * 60;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${pad(hh, 2)}:${pad(mm, 2)}`;
}

function chunked(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function insertManyInBatches(model, docs, batchSize) {
  let total = 0;
  for (const group of chunked(docs, batchSize)) {
    if (!group.length) continue;
    const inserted = await model.insertMany(group, { ordered: false });
    total += inserted.length;
  }
  return total;
}

function makeInstitutionPayload(index, prefix, timezone) {
  const number = index + 1;
  const code = `${prefix}${pad(number, 2)}`;
  return {
    name: `Institution ${number}`,
    code,
    shortName: `Inst ${number}`,
    type: "university",
    timezone,
    termSystem: "semester",
    academicYearLabel: "2026-I",
    gradingScale: "0-20",
    website: `https://institution-${number}.example.edu`,
    contactEmail: `contact+${code.toLowerCase()}@example.edu`,
    contactPhone: `+51-1-555-${pad(number, 4)}`,
    country: "Peru",
    state: "Lima",
    city: "Lima",
    addressLine1: `Campus Principal ${number}`,
    postalCode: `LIM${pad(number, 3)}`,
    isActive: true,
  };
}

function buildCourseDays(index) {
  const options = [
    ["MON", "WED"],
    ["TUE", "THU"],
    ["MON", "WED", "FRI"],
    ["SAT"],
    ["FRI"],
  ];
  return options[index % options.length];
}

function buildCourseTime(index) {
  const starts = ["07:00", "08:30", "10:00", "11:30", "14:00", "15:30", "17:00", "18:30"];
  const start = starts[index % starts.length];
  return {
    startTime: start,
    endTime: addMinutesToTime(start, 90),
  };
}

function buildProgram(index) {
  const programs = [
    ["Ingenieria de Software", "2024"],
    ["Administracion", "2025"],
    ["Contabilidad", "2025"],
    ["Derecho", "2026"],
    ["Marketing", "2024"],
    ["Psicologia", "2026"],
    ["Arquitectura", "2025"],
    ["Ciencias de Datos", "2026"],
  ];
  return {
    program: programs[index % programs.length][0],
    programVersion: programs[index % programs.length][1],
  };
}

function buildDeliveryMode(index) {
  const modes = ["in_person", "online", "hybrid"];
  return modes[index % modes.length];
}

function buildAttendancePolicy(deliveryMode) {
  if (deliveryMode === "online") {
    return {
      singleDevicePerDay: true,
      requireSignature: false,
      requireEnrollment: true,
      requireIpAllowlist: false,
      ipAllowlist: [],
      requireGeofence: false,
      geofence: {
        lat: null,
        lng: null,
        radiusMeters: 120,
      },
    };
  }

  if (deliveryMode === "hybrid") {
    return {
      singleDevicePerDay: true,
      requireSignature: true,
      requireEnrollment: true,
      requireIpAllowlist: false,
      ipAllowlist: [],
      requireGeofence: false,
      geofence: {
        lat: null,
        lng: null,
        radiusMeters: 120,
      },
    };
  }

  return {
    singleDevicePerDay: true,
    requireSignature: true,
    requireEnrollment: true,
    requireIpAllowlist: true,
    ipAllowlist: ["127.0.0.1", "::1"],
    requireGeofence: false,
    geofence: {
      lat: null,
      lng: null,
      radiusMeters: 120,
    },
  };
}

function buildDateOffset(daysBack) {
  const current = new Date();
  current.setDate(current.getDate() - daysBack);
  return current.toISOString().split("T")[0];
}

function randomHex(size) {
  return crypto.randomBytes(size).toString("hex");
}

async function clearData() {
  await Promise.all([
    Attendance.deleteMany({}),
    CourseEnrollment.deleteMany({}),
    TeacherCourseAssignment.deleteMany({}),
    Course.deleteMany({}),
    User.deleteMany({}),
    StudentProfile.deleteMany({}),
    AuthUser.deleteMany({}),
    Institution.deleteMany({}),
  ]);
}

async function seedInstitution({
  institutionIndex,
  institution,
  institutionAdmin,
  teachers,
  institutionUsers,
  students,
  config,
}) {
  const institutionId = institution._id;
  const courseDocs = [];

  for (let i = 0; i < config.coursesPerInstitution; i += 1) {
    const program = buildProgram(i);
    const time = buildCourseTime(i);
    const daysOfWeek = buildCourseDays(i);
    const deliveryMode = buildDeliveryMode(i);
    const sectionChar = String.fromCharCode(65 + (i % 8));
    courseDocs.push({
      institutionId,
      program: program.program,
      programVersion: program.programVersion,
      code: `${institution.code}-C${pad(i + 1, 4)}`,
      name: `${program.program} ${i + 1}`,
      section: sectionChar,
      academicYear: "2026-I",
      daysOfWeek,
      startTime: time.startTime,
      endTime: time.endTime,
      deliveryMode,
      attendancePolicy: buildAttendancePolicy(deliveryMode),
      isActive: true,
      createdBy: institutionAdmin._id,
    });
  }

  const createdCourses = [];
  for (const group of chunked(courseDocs, config.batchSize)) {
    if (!group.length) continue;
    const inserted = await Course.insertMany(group, { ordered: false });
    createdCourses.push(...inserted);
  }

  const assignmentDocs = createdCourses.map((course, idx) => ({
    institutionId,
    teacherId: teachers[idx % teachers.length]._id,
    courseId: course._id,
    isActive: true,
    assignedBy: institutionAdmin._id,
  }));
  await insertManyInBatches(TeacherCourseAssignment, assignmentDocs, config.batchSize);

  const enrollmentsPerCourse = Math.min(config.enrollmentsPerCourse, students.length);
  const enrollmentDocs = [];
  const attendanceDocs = [];
  const datePool = [buildDateOffset(0), buildDateOffset(1), buildDateOffset(2), buildDateOffset(7)];

  for (let courseIndex = 0; courseIndex < createdCourses.length; courseIndex += 1) {
    const course = createdCourses[courseIndex];
    const section = String(course.section || "A").toUpperCase();
    const base = (courseIndex * 37) % students.length;
    const selectedStudents = [];

    for (let j = 0; j < enrollmentsPerCourse; j += 1) {
      const student = students[(base + j * 13) % students.length];
      selectedStudents.push(student);
      enrollmentDocs.push({
        institutionId,
        courseId: course._id,
        universityRollNo: student.universityRollNo,
        fullName: student.name,
        section,
        classRollNo: `R${pad(((base + j) % 999) + 1, 3)}`,
        isActive: true,
        createdBy: institutionAdmin._id,
        updatedBy: institutionAdmin._id,
      });
    }

    const attendanceCount = Math.min(config.attendanceRowsPerCourse, selectedStudents.length);
    const generatedByTeacher = teachers[courseIndex % teachers.length];

    for (let k = 0; k < attendanceCount; k += 1) {
      const student = selectedStudents[k];
      const date = datePool[(courseIndex + k) % datePool.length];
      attendanceDocs.push({
        institutionId,
        name: student.name,
        studentEmail: student.email,
        universityRollNo: student.universityRollNo,
        section,
        classRollNo: `R${pad(((base + k) % 999) + 1, 3)}`,
        sessionId: `${institution.code.toLowerCase()}-${courseIndex + 1}-${date.replace(/-/g, "")}`,
        courseId: course._id,
        courseCode: course.code,
        courseName: course.name,
        generatedBy: generatedByTeacher._id,
        generatedByRole: generatedByTeacher.role,
        date,
        time: `${pad(7 + ((k + courseIndex) % 10), 2)}:${pad((k * 7) % 60, 2)}:00`,
        location: {
          lat: -12.0464 + institutionIndex * 0.02,
          lng: -77.0428 + institutionIndex * 0.02,
        },
        deviceFingerprint: `fp-${randomHex(8)}`,
        ipAddress: "127.0.0.1",
        userAgent: "Mozilla/5.0 SeedBot",
        courseDeliveryMode: course.deliveryMode || "in_person",
        attendancePolicySnapshot: course.attendancePolicy || {},
        status: "present",
        studentId: student.userId,
      });
    }
  }

  const enrollmentCount = await insertManyInBatches(
    CourseEnrollment,
    enrollmentDocs,
    config.batchSize
  );
  const attendanceCount = await insertManyInBatches(Attendance, attendanceDocs, config.batchSize);

  return {
    institutionCode: institution.code,
    institutionName: institution.name,
    authUsers: 1 + institutionUsers.length + teachers.length,
    teachers: teachers.length,
    institutionUsers: institutionUsers.length,
    students: students.length,
    courses: createdCourses.length,
    assignments: assignmentDocs.length,
    enrollments: enrollmentCount,
    attendances: attendanceCount,
  };
}

async function run() {
  const config = buildConfig();
  const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/attendance";

  console.log("Seed config:", JSON.stringify(config, null, 2));
  console.log(`Connecting to MongoDB: ${mongoUri}`);
  await mongoose.connect(mongoUri);
  console.log("MongoDB connected");

  if (config.reset) {
    console.log("Clearing existing data...");
    await clearData();
    console.log("Data cleared");
  }

  const passwordHash = await bcrypt.hash(config.defaultPassword, 12);

  const institutionDocs = [];
  for (let i = 0; i < config.institutions; i += 1) {
    institutionDocs.push(makeInstitutionPayload(i, config.seedPrefix, config.timezone));
  }
  const institutions = await Institution.insertMany(institutionDocs, { ordered: false });

  const superadmin = await AuthUser.create({
    name: config.superadminName,
    email: config.superadminEmail,
    passwordHash,
    role: "superadmin",
    institutionId: institutions[0]._id,
    isActive: true,
    lastLoginAt: new Date(),
  });

  const platformAdmin = await AuthUser.create({
    name: config.platformAdminName,
    email: config.platformAdminEmail,
    passwordHash,
    role: "admin",
    institutionId: institutions[0]._id,
    isActive: true,
    lastLoginAt: new Date(),
  });

  const summaries = [];

  for (let instIndex = 0; instIndex < institutions.length; instIndex += 1) {
    const institution = institutions[instIndex];
    const instTag = institution.code.toLowerCase();

    const institutionAdmin = await AuthUser.create({
      name: `Admin ${institution.name}`,
      email: `admin+${instTag}@example.edu`,
      passwordHash,
      role: "institution_admin",
      institutionId: institution._id,
      isActive: true,
      lastLoginAt: new Date(),
    });

    const institutionUserDocs = [];
    for (let i = 0; i < config.institutionUsersPerInstitution; i += 1) {
      institutionUserDocs.push({
        name: `Academic User ${i + 1} ${institution.code}`,
        email: `user${i + 1}+${instTag}@example.edu`,
        passwordHash,
        role: "institution_user",
        institutionId: institution._id,
        isActive: true,
      });
    }
    const institutionUsers = await AuthUser.insertMany(institutionUserDocs, { ordered: false });

    const teacherDocs = [];
    for (let i = 0; i < config.teachersPerInstitution; i += 1) {
      teacherDocs.push({
        name: `Teacher ${i + 1} ${institution.code}`,
        email: `teacher${pad(i + 1, 2)}+${instTag}@example.edu`,
        passwordHash,
        role: "teacher",
        institutionId: institution._id,
        isActive: true,
      });
    }
    const teachers = await AuthUser.insertMany(teacherDocs, { ordered: false });

    const students = [];
    const studentUsers = [];
    const studentProfiles = [];
    for (let i = 0; i < config.studentsPerInstitution; i += 1) {
      const studentNo = i + 1;
      const universityRollNo = `${institution.code}-STU-${pad(studentNo, 5)}`;
      const section = String.fromCharCode(65 + (i % 8));
      const name = `Student ${studentNo} ${institution.code}`;
      const email = `student${pad(studentNo, 5)}+${instTag}@example.edu`;
      studentUsers.push({
        institutionId: institution._id,
        name,
        email,
        universityRollNo,
        section,
        classRollNo: `CR-${pad((i % 999) + 1, 3)}`,
      });
      studentProfiles.push({
        institutionId: institution._id,
        universityRollNo,
        personalInfo: {
          fullName: name,
          email,
          contactNumber: `+51-9${pad(10000000 + i, 8)}`,
          address: `Address ${studentNo}, Lima`,
        },
        academicInfo: {
          universityName: institution.name,
          classRollNo: `CR-${pad((i % 999) + 1, 3)}`,
          regNo: `${institution.code}-REG-${pad(studentNo, 5)}`,
          department: "General",
          courseDuration: "5 years",
          admissionYear: "2024",
          gradYear: "2028",
          section,
          academicYear: "2026-I",
          attendancePercentage: 0,
          cgpa: 0,
        },
      });
      students.push({
        name,
        email,
        universityRollNo,
        section,
      });
    }

    const createdStudentUsers = [];
    for (const group of chunked(studentUsers, config.batchSize)) {
      if (!group.length) continue;
      const inserted = await User.insertMany(group, { ordered: false });
      createdStudentUsers.push(...inserted);
    }

    await insertManyInBatches(StudentProfile, studentProfiles, config.batchSize);

    createdStudentUsers.forEach((studentUser, idx) => {
      students[idx].userId = studentUser._id;
    });

    const summary = await seedInstitution({
      institutionIndex: instIndex,
      institution,
      institutionAdmin,
      teachers,
      institutionUsers,
      students,
      config,
    });
    summaries.push(summary);
    console.log(
      `[${institution.code}] seeded -> teachers=${summary.teachers}, courses=${summary.courses}, enrollments=${summary.enrollments}, attendances=${summary.attendances}`
    );
  }

  const totals = summaries.reduce(
    (acc, row) => {
      acc.institutions += 1;
      acc.authUsers += row.authUsers;
      acc.teachers += row.teachers;
      acc.institutionUsers += row.institutionUsers;
      acc.students += row.students;
      acc.courses += row.courses;
      acc.assignments += row.assignments;
      acc.enrollments += row.enrollments;
      acc.attendances += row.attendances;
      return acc;
    },
    {
      institutions: 0,
      authUsers: 2,
      teachers: 0,
      institutionUsers: 0,
      students: 0,
      courses: 0,
      assignments: 0,
      enrollments: 0,
      attendances: 0,
    }
  );

  console.log("\nSeed completed");
  console.table(summaries);
  console.log("Totals:", totals);
  console.log("\nTest credentials:");
  console.log(`  superadmin: ${config.superadminEmail} / ${config.defaultPassword}`);
  console.log(`  admin:      ${config.platformAdminEmail} / ${config.defaultPassword}`);
  const firstInstTag = `${config.seedPrefix.toLowerCase()}01`;
  console.log(
    `  institution_admin example: admin+${firstInstTag}@example.edu / ${config.defaultPassword}`
  );
  console.log(
    `  teacher example:           teacher01+${firstInstTag}@example.edu / ${config.defaultPassword}`
  );
  console.log(
    `  institution_user example:  user1+${firstInstTag}@example.edu / ${config.defaultPassword}`
  );

  await mongoose.disconnect();
  console.log("MongoDB disconnected");
}

run().catch(async (error) => {
  console.error("Seed failed:", error);
  try {
    await mongoose.disconnect();
  } catch (disconnectError) {
    console.error("Disconnect after failure failed:", disconnectError);
  }
  process.exit(1);
});
