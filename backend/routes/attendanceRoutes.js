const express = require('express');
const router = express.Router();
const Attendance = require('../models/Attendance');

function normalizeIdentifier(value) {
  return String(value || '').trim();
}

function buildIdentityOr(identifier) {
  const lower = identifier.toLowerCase();
  const upper = identifier.toUpperCase();
  return [
    { studentEmail: lower },
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
      return res.status(400).json({ error: 'rollNo or email is required' });
    }

    const attendanceFilter = { $or: buildIdentityOr(identifier) };
    if (institutionId) attendanceFilter.institutionId = institutionId;

    const attendance = await Attendance.find(attendanceFilter).sort({ date: -1, time: -1 });
    res.json(attendance);
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
