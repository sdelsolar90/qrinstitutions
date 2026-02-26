const mongoose = require("mongoose");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function normalizeUpper(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

const courseEnrollmentSchema = new mongoose.Schema(
  {
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
      index: true,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
      required: true,
      index: true,
    },
    universityRollNo: {
      type: String,
      required: true,
      trim: true,
      set: normalizeUpper,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      validate: {
        validator: (value) => EMAIL_PATTERN.test(String(value || "")),
        message: "Invalid email format",
      },
      set: normalizeEmail,
      index: true,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    section: {
      type: String,
      required: true,
      trim: true,
      set: normalizeUpper,
    },
    classRollNo: {
      type: String,
      required: true,
      trim: true,
      set: normalizeUpper,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuthUser",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuthUser",
      required: true,
    },
  },
  {
    timestamps: true,
    collection: "courseenrollments",
  }
);

courseEnrollmentSchema.index(
  { institutionId: 1, courseId: 1, universityRollNo: 1 },
  { unique: true, name: "institution_course_enrollment_unique_idx" }
);
courseEnrollmentSchema.index(
  { institutionId: 1, courseId: 1, isActive: 1, universityRollNo: 1 },
  { name: "institution_course_active_rollno_idx" }
);
courseEnrollmentSchema.index(
  { institutionId: 1, courseId: 1, section: 1, classRollNo: 1 },
  { name: "institution_course_section_classroll_idx" }
);
courseEnrollmentSchema.index(
  { institutionId: 1, courseId: 1, isActive: 1, fullName: 1 },
  { name: "institution_course_active_fullname_idx" }
);
courseEnrollmentSchema.index(
  { institutionId: 1, universityRollNo: 1 },
  { name: "institution_enrollment_rollno_idx" }
);
courseEnrollmentSchema.index(
  { institutionId: 1, courseId: 1, email: 1 },
  {
    unique: true,
    name: "institution_course_email_unique_idx",
    partialFilterExpression: { email: { $type: "string", $ne: "" } },
  }
);
courseEnrollmentSchema.index(
  { institutionId: 1, email: 1 },
  {
    name: "institution_email_idx",
    partialFilterExpression: { email: { $type: "string", $ne: "" } },
  }
);

module.exports = mongoose.model("CourseEnrollment", courseEnrollmentSchema);
