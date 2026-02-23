const express = require('express');
const router = express.Router();
const StudentProfile = require('../models/StudentProfile');
const User = require('../models/User');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get('/profile', async (req, res) => {
  try {
    const rollNo = String(req.query.rollNo || '').trim();
    const email = normalizeEmail(req.query.email);
    const institutionId = String(req.query.institutionId || '').trim();

    if (!rollNo && !email) {
      return res.status(400).json({ error: 'rollNo or email is required' });
    }

    const studentFilter = {};
    if (institutionId) studentFilter.institutionId = institutionId;

    if (email) {
      studentFilter.$or = [
        { universityRollNo: email },
        { universityRollNo: email.toUpperCase() },
        { 'personalInfo.email': new RegExp(`^${escapeRegex(email)}$`, 'i') },
      ];
    } else {
      studentFilter.universityRollNo = rollNo;
    }

    const student = await StudentProfile.findOne(studentFilter);
    if (student) {
      return res.json({ data: student });
    }

    const userFilter = {};
    if (institutionId) userFilter.institutionId = institutionId;

    if (email) {
      userFilter.$or = [
        { email },
        { universityRollNo: email },
        { universityRollNo: email.toUpperCase() },
      ];
    } else {
      userFilter.universityRollNo = rollNo;
    }

    const user = await User.findOne(userFilter);
    if (!user) {
      return res.status(404).json({ error: 'Student not found' });
    }

    return res.json({
      data: {
        institutionId: user.institutionId,
        universityRollNo: user.universityRollNo,
        personalInfo: {
          fullName: user.name || '',
          email: user.email || email || user.universityRollNo || '',
        },
        academicInfo: {
          universityRollNo: user.universityRollNo || '',
          section: user.section || 'N/A',
          classRollNo: user.classRollNo || 'N/A',
          attendancePercentage: 0,
        },
        skills: {},
        documents: {},
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
