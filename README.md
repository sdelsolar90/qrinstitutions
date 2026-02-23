# QR Institutions Attendance System

Multi-institution attendance platform with:
- role-based staff access,
- academic structure (program -> version -> course -> section),
- teacher QR sessions,
- student attendance capture,
- per-course security policies for in-person and online classes.

Built with Node.js, Express, MongoDB, and Tailwind-based frontend pages.

## What Is Implemented

- Authentication and bootstrap:
  - First-run superadmin creation.
  - Login with JWT-based auth.
  - Role-based access control.
- Multi-institution layer:
  - Institutions CRUD.
  - Institution branding/logo support.
  - Institution-scoped data access.
- Academic module:
  - Programs and program versions.
  - Courses with schedule metadata.
  - Teacher-course assignment.
  - Enrollment roster per course.
- Teacher flow:
  - Course selector with search.
  - QR generation per selected course.
  - Teacher attendance dashboard.
- Student flow:
  - Scan QR.
  - Submit attendance with full name + email.
  - Optional signature (policy-driven).
  - Optional geolocation (policy-driven).
- Security enforcement at attendance time:
  - One attendance per student per course/day.
  - Optional one-device-per-course/day.
  - Optional enrollment requirement.
  - Optional IP allowlist (supports IPv4 and CIDR).
  - Optional geofence (lat/lng/radius).

## Roles

Supported roles:
- `superadmin`
- `admin`
- `institution_admin`
- `institution_user`
- `teacher`

High-level behavior:
- `teacher` is redirected to QR course selection.
- Other staff roles are redirected to admin dashboard.

## Course Delivery Modes and Policies

Each course supports:
- `deliveryMode`: `in_person` | `online` | `hybrid`
- `attendancePolicy`:
  - `singleDevicePerDay` (default: `true`)
  - `requireSignature` (default: `true`)
  - `requireEnrollment` (default from env `ATTENDANCE_REQUIRE_ENROLLMENT`)
  - `requireIpAllowlist` (default: `false`)
  - `ipAllowlist` (array of IP/CIDR)
  - `requireGeofence` (default: `false`)
  - `geofence.lat`
  - `geofence.lng`
  - `geofence.radiusMeters`

Recommended policy examples:
- In-person:
  - `requireGeofence=true`
  - `requireIpAllowlist=true` (campus ranges)
  - `singleDevicePerDay=true`
- Online:
  - `requireGeofence=false`
  - `requireIpAllowlist=false` (or stricter if needed)
  - `singleDevicePerDay=true`

## Main Pages

- Login: `http://localhost:5001/login.html`
- Admin dashboard: `http://localhost:5001/admin-dashboard.html`
- Teacher course select: `http://localhost:5001/qr-scanner.html`
- Teacher QR session: `http://localhost:5001/qr-session.html`
- Student attendance page (via QR): `http://localhost:5001/index.html?sessionId=...`
- Student dashboard: `http://localhost:5001/dashboard.html?rollNo=<email>`

## Quick Start (Docker Recommended)

### Prerequisites

- Docker Desktop
- Docker Compose

### Run

```bash
git clone https://github.com/sdelsolar90/qrinstitutions.git
cd qrinstitutions
docker compose up -d --build
```

Open:
- `http://localhost:5001/login.html`

Health check:

```bash
curl -sS http://127.0.0.1:5001/health
```

Stop:

```bash
docker compose down
```

## First Run Bootstrap

When there are no auth users:
- `login.html` automatically switches to "Create Superadmin" mode.
- It calls:
  - `GET /api/auth/bootstrap-status`
  - `POST /api/auth/bootstrap-superadmin`

After bootstrap, normal login uses:
- `POST /api/auth/login`

## Run Without Docker

### Prerequisites

- Node.js 20+
- MongoDB 7+
- Java runtime (OpenJDK 17+) for Java-backed helpers/fallback paths used in backend

### Backend

```bash
cd backend
npm install
```

Create `backend/.env`:

```env
PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017/attendance
QR_SECRET_KEY=change-me
APP_BASE_URL=http://localhost:5001
QR_CODE_DIR=../frontend/public/qrcodes
INSTITUTION_LOGO_DIR=../frontend/public/institution-logos
NODE_ENV=development
ATTENDANCE_REQUIRE_ENROLLMENT=true
```

Run backend:

```bash
node server.js
```

Serve frontend from same server (already configured by Express static middleware) and open:
- `http://localhost:5000/login.html`

## Project Structure

```text
QR-Based-Attendance-System/
├── backend/
│   ├── middleware/
│   ├── models/
│   ├── routes/
│   ├── qr-generator.js
│   └── server.js
├── frontend/
│   ├── login.html
│   ├── admin-dashboard.html
│   ├── course-editor.html
│   ├── assignment-manager.html
│   ├── staff-editor.html
│   ├── staff-view.html
│   ├── qr-scanner.html
│   ├── qr-session.html
│   ├── teacher-dashboard.html
│   ├── index.html
│   └── script.js
├── docker-compose.yml
├── Dockerfile
└── README.md
```

## Key API Areas

- Auth and institutions:
  - `/api/auth/*`
- Academic:
  - `/api/academic/programs`
  - `/api/academic/courses`
  - `/api/academic/courses/:courseId`
  - `/api/academic/teachers`
  - `/api/academic/assignments`
  - `/api/academic/courses/:courseId/enrollments`
- Attendance:
  - `POST /mark-attendance`
  - `POST /api/validate-session`
  - `GET /api/attendance*`

## Notes for Production

- Set a strong `QR_SECRET_KEY`.
- Put the app behind a reverse proxy and forward real client IP headers.
- Configure trusted campus CIDR blocks carefully when using IP allowlist.
- Keep logo storage and MongoDB storage in persistent volumes.
- Add proper backups and monitoring for MongoDB.

## Author

Enigma Developers.

## License

Proprietary software. All rights reserved.
This project is not open source and may not be used, copied, modified, or distributed without explicit written permission.
