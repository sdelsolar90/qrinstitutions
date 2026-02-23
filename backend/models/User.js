const mongoose = require('mongoose');

const usersSchema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: "Institution", required: true, index: true },
  name: String,
  email: { type: String, required: false, trim: true, lowercase: true },
  universityRollNo: { type: String, required: true },
  section: String,
  classRollNo: String,
  registeredAt: { type: Date, default: Date.now }
});

usersSchema.index(
  { institutionId: 1, universityRollNo: 1 },
  { unique: true, name: "institution_user_rollno_unique_idx" }
);

usersSchema.index(
  { institutionId: 1, email: 1 },
  { unique: true, sparse: true, name: "institution_user_email_unique_idx" }
);

module.exports = mongoose.model('User', usersSchema);
