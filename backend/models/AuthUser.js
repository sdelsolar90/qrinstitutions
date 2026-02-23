const mongoose = require("mongoose");

const authUserSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: ["superadmin", "admin", "institution_admin", "institution_user", "teacher"],
      default: "teacher",
      required: true,
    },
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      default: null,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "authusers",
  }
);

authUserSchema.index({ role: 1, isActive: 1, name: 1 }, { name: "authuser_role_active_name_idx" });
authUserSchema.index({ isActive: 1, email: 1 }, { name: "authuser_active_email_idx" });
authUserSchema.index(
  { institutionId: 1, role: 1, isActive: 1, name: 1 },
  { name: "authuser_institution_role_active_name_idx" }
);

module.exports = mongoose.model("AuthUser", authUserSchema);
