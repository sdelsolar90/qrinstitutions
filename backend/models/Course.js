const mongoose = require("mongoose");

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_CODES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const DELIVERY_MODES = ["in_person", "online", "hybrid"];

const courseSchema = new mongoose.Schema(
  {
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
      index: true,
    },
    program: {
      type: String,
      default: "General",
      trim: true,
    },
    programVersion: {
      type: String,
      default: "1",
      trim: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    section: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    academicYear: {
      type: String,
      default: "",
      trim: true,
    },
    daysOfWeek: {
      type: [String],
      default: [],
      validate: {
        validator: (days) => Array.isArray(days) && days.every((day) => DAY_CODES.includes(day)),
        message: "Invalid day code in daysOfWeek",
      },
    },
    startTime: {
      type: String,
      default: "",
      validate: {
        validator: (value) => !value || TIME_PATTERN.test(value),
        message: "startTime must be in HH:mm format",
      },
    },
    endTime: {
      type: String,
      default: "",
      validate: {
        validator: (value) => !value || TIME_PATTERN.test(value),
        message: "endTime must be in HH:mm format",
      },
    },
    deliveryMode: {
      type: String,
      enum: DELIVERY_MODES,
      default: "in_person",
      index: true,
    },
    attendancePolicy: {
      singleDevicePerDay: {
        type: Boolean,
        default: true,
      },
      requireSignature: {
        type: Boolean,
        default: true,
      },
      requireEnrollment: {
        type: Boolean,
        default: process.env.ATTENDANCE_REQUIRE_ENROLLMENT !== "false",
      },
      requireIpAllowlist: {
        type: Boolean,
        default: false,
      },
      ipAllowlist: {
        type: [String],
        default: [],
        set: (values) => {
          if (!Array.isArray(values)) return [];
          return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
        },
      },
      requireGeofence: {
        type: Boolean,
        default: false,
      },
      geofence: {
        lat: {
          type: Number,
          default: null,
        },
        lng: {
          type: Number,
          default: null,
        },
        radiusMeters: {
          type: Number,
          default: 120,
          min: 10,
          max: 100000,
        },
      },
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
  },
  {
    timestamps: true,
    collection: "courses",
  }
);

courseSchema.index(
  { institutionId: 1, code: 1, section: 1 },
  { unique: true, name: "institution_course_code_section_idx" }
);
courseSchema.index(
  { institutionId: 1, isActive: 1, program: 1, programVersion: 1, code: 1, section: 1 },
  { name: "institution_course_active_program_version_code_section_idx" }
);
courseSchema.index(
  { institutionId: 1, isActive: 1, name: 1 },
  { name: "institution_course_active_name_idx" }
);

module.exports = mongoose.model("Course", courseSchema);
