const mongoose = require("mongoose");

const teacherCourseAssignmentSchema = new mongoose.Schema(
  {
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
      index: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuthUser",
      required: true,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuthUser",
      required: true,
    },
  },
  {
    timestamps: true,
    collection: "teachercourseassignments",
  }
);

teacherCourseAssignmentSchema.index(
  { institutionId: 1, teacherId: 1, courseId: 1 },
  { unique: true, name: "institution_teacher_course_unique_idx" }
);
teacherCourseAssignmentSchema.index(
  { institutionId: 1, isActive: 1, createdAt: -1 },
  { name: "institution_assignment_active_created_idx" }
);
teacherCourseAssignmentSchema.index(
  { institutionId: 1, teacherId: 1, isActive: 1, createdAt: -1 },
  { name: "institution_assignment_teacher_active_created_idx" }
);
teacherCourseAssignmentSchema.index(
  { institutionId: 1, courseId: 1, isActive: 1 },
  { name: "institution_assignment_course_active_idx" }
);

module.exports = mongoose.model("TeacherCourseAssignment", teacherCourseAssignmentSchema);
