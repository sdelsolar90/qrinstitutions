const mongoose = require('mongoose');

const attendancesSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: "Institution", required: true, index: true },
  name: { type: String, required: true },
  studentEmail: { type: String, required: true, trim: true, lowercase: true },
  universityRollNo: { type: String, required: true },
  section: { type: String, required: true },
  classRollNo: { type: String, required: true },
  sessionId: { type: String, required: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: false },
  courseCode: { type: String, required: false },
  courseName: { type: String, required: false },
  generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AuthUser', required: false },
  generatedByRole: { type: String, required: false },
  date: { type: String, required: true },
  time: {
    type: String,
    default: () => new Date().toLocaleTimeString('en-IN', { hour12: false })
  },
  location: {
    lat: { type: Number, required: false },
    lng: { type: Number, required: false }
  },
  deviceFingerprint: { type: String, required: true },
  signatureDataUrl: { type: String, required: false, select: false },
  signatureHash: { type: String, required: false, select: false },
  ipAddress: { type: String, required: false },
  userAgent: { type: String, required: false },
  courseDeliveryMode: { type: String, required: false, default: "in_person" },
  attendancePolicySnapshot: { type: Object, required: false },
  distanceFromClass: { type: Number, required: false },
  status: { type: String, default: "present" },
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
  timestamps: true
});

// Create indexes
attendancesSchema.index({ institutionId: 1, studentEmail: 1, courseId: 1, date: 1 });
attendancesSchema.index({ institutionId: 1, universityRollNo: 1, courseId: 1, date: 1 });
attendancesSchema.index({ institutionId: 1, deviceFingerprint: 1, courseId: 1, date: 1 });
attendancesSchema.index({ institutionId: 1, courseId: 1, date: 1 });

module.exports = mongoose.model('Attendance', attendancesSchema);
