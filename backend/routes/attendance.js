const express = require('express');
const router = express.Router();
const Attendance = require('../models/Attendance');
const User = require('../models/User');

function normalizeIdentifier(value) {
  return String(value || '').trim();
}

function buildIdentityOr(identifier) {
  const lower = identifier.toLowerCase();
  const upper = identifier.toUpperCase();
  return [
    { studentEmail: lower },
    { email: lower },
    { universityRollNo: identifier },
    { universityRollNo: lower },
    { universityRollNo: upper },
  ];
}

router.get('/', async (req, res) => {
  try {
    const identifier = normalizeIdentifier(req.query.email || req.query.rollNo);
    const institutionId = String(req.query.institutionId || '').trim();

    if (!identifier) {
      return res.status(400).json({ message: 'rollNo or email is required' });
    }

    const studentFilter = { $or: buildIdentityOr(identifier) };
    if (institutionId) studentFilter.institutionId = institutionId;

    const student = await User.findOne(studentFilter);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    const attendanceFilter = { $or: buildIdentityOr(identifier) };
    if (institutionId) attendanceFilter.institutionId = institutionId;

    const attendance = await Attendance.find(attendanceFilter).sort({ date: -1, time: -1 });

    res.json({
      status: 'success',
      name: student.name,
      studentId: student.email || student.universityRollNo,
      universityRollNo: student.universityRollNo,
      attendance,
    });
  } catch (error) {
    console.error('Attendance fetch error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

module.exports = router;
