const mongoose = require("mongoose");

const institutionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    shortName: {
      type: String,
      trim: true,
      default: "",
    },
    type: {
      type: String,
      trim: true,
      lowercase: true,
      enum: ["university", "school", "college", "institute", "other"],
      default: "university",
    },
    logoUrl: {
      type: String,
      trim: true,
      default: "",
    },
    website: {
      type: String,
      trim: true,
      default: "",
    },
    contactEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    contactPhone: {
      type: String,
      trim: true,
      default: "",
    },
    country: {
      type: String,
      trim: true,
      default: "",
    },
    state: {
      type: String,
      trim: true,
      default: "",
    },
    city: {
      type: String,
      trim: true,
      default: "",
    },
    addressLine1: {
      type: String,
      trim: true,
      default: "",
    },
    addressLine2: {
      type: String,
      trim: true,
      default: "",
    },
    postalCode: {
      type: String,
      trim: true,
      default: "",
    },
    timezone: {
      type: String,
      trim: true,
      default: "UTC",
    },
    termSystem: {
      type: String,
      trim: true,
      lowercase: true,
      enum: ["semester", "trimester", "quarter", "annual", "other"],
      default: "semester",
    },
    academicYearLabel: {
      type: String,
      trim: true,
      default: "",
    },
    gradingScale: {
      type: String,
      trim: true,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuthUser",
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "institutions",
  }
);

institutionSchema.index({ code: 1 }, { unique: true, name: "institution_code_unique_idx" });
institutionSchema.index({ name: 1 }, { unique: true, name: "institution_name_unique_idx" });
institutionSchema.index({ isActive: 1, name: 1 }, { name: "institution_active_name_idx" });

module.exports = mongoose.model("Institution", institutionSchema);
