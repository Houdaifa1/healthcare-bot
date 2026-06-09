# API Reference — Healthcare Bot Backend

> **NestJS Backend** | Base URL: `http://localhost:3000` (dev) | JWT tokens expire in **7 days**

---

## Table of Contents

1. [Authentication (Admin)](#1-authentication-admin)
2. [Dashboard Statistics](#2-dashboard-statistics)
3. [Clinic Settings](#3-clinic-settings)
4. [Bot Messages](#4-bot-messages)
5. [Doctors](#5-doctors)
6. [Specialties](#6-specialties)
7. [FAQs](#7-faqs)
8. [Time Slots](#8-time-slots)
9. [Appointments](#9-appointments)
10. [Handoff Sessions](#10-handoff-sessions)
11. [WhatsApp Webhook (Meta Cloud API)](#11-whatsapp-webhook-meta-cloud-api)
12. [Root Health](#12-root-health)

---

## 1. Authentication (Admin)

### POST /api/admin/v1/auth/login

Authenticate an admin user and obtain a JWT access token.

**Authentication:** No (public)

**Request Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Content-Type | `application/json` | Yes |

**Request Body (`LoginDto`):**
```json
{
  "email": "admin@clinic.com",
  "password": "securePassword123"
}
```

**Validation Rules:**
| Field | Type | Validator | Notes |
|-------|------|-----------|-------|
| `email` | string | `@IsEmail()` | Must be a valid email format |
| `password` | string | `@IsString()` | Plain-text, compared against `passwordHash` via bcrypt |

**Response (200 OK):**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "admin": {
    "id": "clx...",
    "email": "admin@clinic.com",
    "role": "CLINIC_ADMIN",
    "clinicId": "clx..."
  }
}
```

**Error Responses:**
| Status | Body | Condition |
|--------|------|-----------|
| 401 | `{ "message": "Invalid credentials", "statusCode": 401 }` | Email not found or password mismatch |

**Prisma Model:** `AdminUser`
- Lookup: `findUnique({ where: { email } })`
- Fields used: `id`, `email`, `passwordHash`, `role`, `clinicId`
- JWT payload: `{ sub: id, email, role, clinicId }`

---

## 2. Dashboard Statistics

### GET /api/admin/v1/stats

Get aggregate appointment counts for the admin dashboard.

**Authentication:** Yes — `JwtAuthGuard`

**Request Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Authorization | `Bearer <token>` | Yes |

**Query Parameters:** None

**Path Parameters:** None

**Response (200 OK):**
```json
{
  "totalAppointments": 150,
  "todayAppointments": 8,
  "pendingAppointments": 12
}
```

| Field | Type | Description |
|-------|------|-------------|
| `totalAppointments` | number | Count of all appointments ever created |
| `todayAppointments` | number | Count of appointments where `appointmentDate` is today |
| `pendingAppointments` | number | Count of appointments with status `PENDING` |

**Error Responses:**
| Status | Body | Condition |
|--------|------|-----------|
| 401 | `{ "message": "Unauthorized", "statusCode": 401 }` | Missing/invalid JWT |

**Prisma Model:** `Appointment`
- Queries: Three concurrent `count()` calls with different `where` filters
- Filters: `appointmentDate` (gte today, lt tomorrow), `status` (PENDING)

### GET /api/admin/v1/health

Simple health-check endpoint.

**Authentication:** No

**Response (200 OK):**
```json
{
  "status": "ok",
  "timestamp": "2026-06-09T20:30:00.000Z"
}
```

---

## 3. Clinic Settings

All endpoints under this module are guarded by `JwtAuthGuard`.

### GET /api/admin/v1/clinics

Get the current clinic's configuration.

**Authentication:** Yes — `JwtAuthGuard`

**Request Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Authorization | `Bearer <token>` | Yes |

**Path Parameters:** None (clinicId extracted from JWT payload)

**Query Parameters:** None

**Response (200 OK):**
```json
{
  "id": "clx...",
  "name": "Clinique Al Amal",
  "phone": "+212600000000",
  "address": "123 Rue de la Santé, Casablanca",
  "timezone": "Africa/Casablanca",
  "defaultLanguage": "FR",
  "supportedLangs": ["FR", "EN"],
  "isActive": true,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-06-09T00:00:00.000Z"
}
```

**Error Responses:**
| Status | Body | Condition |
|--------|------|-----------|
| 401 | `{ "message": "Unauthorized", "statusCode": 401 }` | Missing/invalid JWT |
| 404 | `{ "message": "Not Found", "statusCode": 404 }` | Clinic not found for the JWT's clinicId |

**Prisma Model:** `Clinic`
- Lookup: `findUnique({ where: { id: user.clinicId } })`

### PATCH /api/admin/v1/clinics

Update the current clinic's configuration.

**Authentication:** Yes — `JwtAuthGuard`

**Request Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Authorization | `Bearer <token>` | Yes |
| Content-Type | `application/json` | Yes |

**Request Body (`UpdateClinicDto`):**
```json
{
  "name": "Clinique Al Amal — Nouveau Nom",
  "phone": "+212600000001",
  "address": "456 Avenue Hassan II, Rabat",
  "timezone": "Africa/Casablanca",
  "defaultLanguage": "FR",
  "supportedLangs": ["FR", "EN", "AR"],
  "isActive": true
}
```

**Validation Rules:**
| Field | Type | Validator | Notes |
|-------|------|-----------|-------|
| `name` | string | `@IsOptional() @IsString()` | — |
| `phone` | string | `@IsOptional() @IsString()` | — |
| `address` | string | `@IsOptional() @IsString()` | — |
| `timezone` | string | `@IsOptional() @IsString()` | IANA timezone string |
| `defaultLanguage` | enum (Language) | `@IsOptional() @IsEnum(Language)` | `FR`, `EN`, `AR` |
| `supportedLangs` | array | `@IsOptional() @IsArray() @IsEnum(Language, { each: true })` | Must be valid Language enum values |
| `isActive` | boolean | `@IsOptional() @IsBoolean()` | — |

All fields are optional; only provided fields will be updated.

**Response (200 OK):**
```json
{
  "id": "clx...",
  "name": "Clinique Al Amal — Nouveau Nom",
  "phone": "+212600000001",
  "address": "456 Avenue Hassan II, Rabat",
  "timezone": "Africa/Casablanca",
  "defaultLanguage": "FR",
  "supportedLangs": ["FR", "EN", "AR"],
  "isActive": true,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-06-09T00:00:00.000Z"
}
```

**Prisma Model:** `Clinic`
- Operation: `update({ where: { id }, data: dto })`

---

## 4. Bot Messages

All endpoints under this module are guarded by `JwtAuthGuard`.

### GET /api/admin/v1/clinic/:clinicId/messages

Get all bot message templates for a clinic, optionally filtered by language.

**Authentication:** Yes — `JwtAuthGuard`

**Request Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Authorization | `Bearer <token>` | Yes |

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `clinicId` | string | The clinic's UUID |

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `language` | enum (Language) | No | Filter by language: `FR`, `EN`, `AR` |

**Response (200 OK):**
```json
[
  {
    "id": "clx...",
    "clinicId": "clx...",
    "key": "WELCOME",
    "body": "Bonjour {{patientName}}, bienvenue à la Clinique Al Amal. 🏥",
    "language": "FR",
    "updatedAt": "2026-06-09T00:00:00.000Z"
  },
  {
    "id": "clx...",
    "clinicId": "clx...",
    "key": "WELCOME",
    "body": "Hello {{patientName}}, welcome to Clinique Al Amal. 🏥",
    "language": "EN",
    "updatedAt": "2026-06-09T00:00:00.000Z"
  }
]
```

**Possible `key` Values (MessageKey enum):**
| Key | Description |
|-----|-------------|
| `WELCOME` | First message sent to the user |
| `LANGUAGE_PROMPT` | Ask user to choose language |
| `ASK_NAME` | Prompt for patient's name |
| `SELECT_SPECIALTY` | Show specialty selection |
| `SELECT_DOCTOR` | Show doctor selection |
| `SELECT_DATE` | Prompt for appointment date |
| `SELECT_TIME` | Prompt for appointment time |
| `CONFIRM_BOOKING` | Show booking confirmation summary |
| `BOOKING_SUCCESS` | Booking confirmed successfully |
| `BOOKING_CANCELLED` | Booking was cancelled |
| `FAQ_INTRO` | Introduction to FAQ browsing |
| `FAQ_NOT_FOUND` | No FAQ matched the user's question |
| `FALLBACK` | Bot didn't understand the input |
| `HANDOFF_TRIGGERED` | Handoff to human agent initiated |
| `SESSION_EXPIRED` | Session timed out after 30 min of inactivity |
| `NO_SLOTS_AVAILABLE` | No time slots available for selected date/doctor |
| `OUTSIDE_HOURS` | User messaged outside clinic operating hours |

**Template Variables:**
Messages support `{{patientName}}`, `{{doctorName}}`, `{{date}}`, `{{time}}`, `{{specialty}}` placeholders.

**Error Responses:**
| Status | Body | Condition |
|--------|------|-----------|
| 401 | `{ "message": "Unauthorized", "statusCode": 401 }` | Missing/invalid JWT |

**Prisma Model:** `BotMessage`
- Unique constraint: `@@unique([clinicId, key, language])`
- Query: `findMany({ where: { clinicId, ...(language && { language }) } })`

### PATCH /api/admin/v1/clinic/:clinicId/messages/:key/:language

Update a specific bot message template.

**Authentication:** Yes — `JwtAuthGuard`

**Request Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Authorization | `Bearer <token>` | Yes |
| Content-Type | `application/json` | Yes |

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `clinicId` | string | The clinic's UUID |
| `key` | string | MessageKey enum value (e.g. `WELCOME`, `FALLBACK`) |
| `language` | enum (Language) | `FR`, `EN`, `AR` |

**Request Body (`UpdateBotMessageDto`):**
```json
{
  "body": "Bonjour {{patientName}}, bienvenue à la Clinique Al Amal. Comment puis-je vous aider aujourd'hui ? 🏥"
}
```

**Validation Rules:**
| Field | Type | Validator | Notes |
|-------|------|-----------|-------|
| `body` | string | `@IsString() @IsNotEmpty()` | Cannot be empty |

**Response (200 OK):**
```json
{
  "id": "clx...",
  "clinicId": "clx...",
  "key": "WELCOME",
  "body": "Bonjour {{patientName}}, bienvenue à la Clinique Al Amal. Comment puis-je vous aider aujourd'hui ? 🏥",
  "language": "FR",
  "updatedAt": "2026-06-09T00:00:00.000Z"
}
```

**Error Responses:**
| Status | Body | Condition |
|--------|------|-----------|
| 400 | `{ "message": "Invalid message key \"...\"...", "statusCode": 400 }` | `key` is not a valid MessageKey enum value |
| 401 | `{ "message": "Unauthorized", "statusCode": 401 }` | Missing/invalid JWT |
| 404 | `{ "message": "No message found for key \"...\" and language \"...\"", "statusCode": 404 }` | The key+language combination does not exist |

**Prisma Model:** `BotMessage`
- Unique constraint lookup: `findUnique({ where: { clinicId_key_language } })`
- Operation: `update({ where: { clinicId_key_language }, data })`

---

## 5. Doctors

Full CRUD. All endpoints under this module are guarded by `JwtAuthGuard`.

### POST /api/admin/v1/doctors

Create a new doctor.

**Authentication:** Yes — `JwtAuthGuard`

**Request Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Authorization | `Bearer <token>` | Yes |
| Content-Type | `application/json` | Yes |

**Request Body (`CreateDoctorDto`):**
```json
{
  "name": "Dr. Ahmed Benali",
  "specialtyId": "clx...",
  "bio": "Spécialiste en médecine générale avec 15 ans d'expérience.",
  "isActive": true,
  "displayOrder": 1
}
```

**Validation Rules:**
| Field | Type | Validator | Notes |
|-------|------|-----------|-------|
| `name` | string | `@IsString() @IsNotEmpty()` | Required |
| `specialtyId` | string | `@IsString() @IsNotEmpty()` | Must belong to same clinic (validated by `ClinicGuardService`) |
| `bio` | string | `@IsOptional() @IsString()` | — |
| `isActive` | boolean | `@IsOptional() @IsBoolean()` | Defaults to `true` in Prisma |
| `displayOrder` | number | `@IsOptional() @IsInt()` | Sort order |

**Response (201 Created):**
```json
{
  "id": "clx...",
  "clinicId": "clx...",
  "specialtyId": "clx...",
  "name": "Dr. Ahmed Benali",
  "bio": "Spécialiste en médecine générale avec 15 ans d'expérience.",
  "isActive": true,
  "displayOrder": 1,
  "createdAt": "2026-06-09T20:30:00.000Z"
}
```

**Error Responses:**
| Status | Body | Condition |
|--------|------|-----------|
| 401 | `{ "message": "Unauthorized", "statusCode": 401 }` | Missing/invalid JWT |
| 404 | `{ "message": "Specialty not found in this clinic", "statusCode": 404 }` | `specialtyId` does not belong to this clinic |

**Prisma Model:** `Doctor`
- Relation: belongs to `Clinic` and `Specialty`
- Guard: validates `specialtyId` belongs to clinic before creation

### GET /api/admin/v1/doctors

List all doctors for the clinic with optional filters.

**Authentication:** Yes — `JwtAuthGuard`

**Request Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Authorization | `Bearer <token>` | Yes |

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `specialtyId` | string | No | Filter by specialty UUID |
| `isActive` | string (`"true"`/`"false"`) | No | Filter by active status (string parsed to boolean) |

**Response (200 OK):**
```json
[
  {
    "id": "clx...",
    "clinicId": "clx...",
    "specialtyId": "clx...",
    "name": "Dr. Ahmed Benali",
    "bio": "Spécialiste en médecine générale...",
    "isActive": true,
    "displayOrder": 1,
    "createdAt": "2026-06-09T20:30:00.000Z"
  }
]
```

**Prisma Model:** `Doctor`
- Query: `findMany({ where: { clinicId, specialtyId?, isActive? } })`

### PATCH /api/admin/v1/doctors/:id

Update a doctor.

**Authentication:** Yes — `JwtAuthGuard`

**Request Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Authorization | `Bearer <token>` | Yes |
| Content-Type | `application/json` | Yes |

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Doctor UUID |

**Request Body (`UpdateDoctorDto`):**
```json
{
  "name": "Dr. Ahmed Benali — Mis à jour",
  "specialtyId": "clx...",
  "bio": "Nouvelle biographie",
  "isActive": true,
  "displayOrder": 2
}
```

**Validation Rules:**
| Field | Type | Validator | Notes |
|-------|------|-----------|-------|
| `name` | string | `@IsOptional() @IsString()` | — |
| `specialtyId` | string | `@IsOptional() @IsString()` | Validated to belong to same clinic if provided |
| `bio` | string | `@IsOptional() @IsString()` | — |
| `isActive` | boolean | `@IsOptional() @IsBoolean()` | — |
| `displayOrder` | number | `@IsOptional() @IsInt()` | — |

All fields optional.

**Response (200 OK):**
```json
{
  "id": "clx...",
  "clinicId": "clx...",
  "specialtyId": "clx...",
  "name": "Dr. Ahmed Benali — Mis à jour",
  "bio": "Nouvelle biographie",
  "isActive": true,
  "displayOrder": 2,
  "createdAt": "2026-06-09T20:30:00.000Z"
}
```

**Error Responses:**
| Status | Body | Condition |
|--------|------|-----------|
| 401 | `{ "message": "Unauthorized", "statusCode": 401 }` | Missing/invalid JWT |
| 404 | `{ "message": "Doctor not found in this clinic", "statusCode": 404 }` | Doctor ID not in this clinic |
| 404 | `{ "message": "Specialty not found in this clinic", "statusCode": 404 }` | New `specialtyId` not in this clinic |

**Prisma Model:** `Doctor`
- Guard: validates doctor belongs to clinic, validates new specialty if provided
- Operation: `update({ where: { id }, data: dto })`

### DELETE /api/admin/v1/doctors/:id

Soft-delete a doctor (sets `isActive = false`).

**Authentication:** Yes — `JwtAuthGuard`

**Request Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Authorization | `Bearer <token>` | Yes |

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Doctor UUID |

**Response (200 OK):**
```json
{
  "id": "clx...",
  "clinicId": "clx...",
  "specialtyId": "clx...",
  "name": "Dr. Ahmed Benali",
  "bio": "...",
  "isActive": false,
  "displayOrder": 1,
  "createdAt": "2026-06-09T20:30:00.000Z"
}
```

**Note:** This does NOT delete the record — it sets `isActive = false`.

**Prisma Model:** `Doctor`
- Operation: `update({ where: { id }, data: { isActive: false } })`

---

## 6. Specialties

Full CRUD. All endpoints guarded by `JwtAuthGuard`.

### POST /api/admin/v1/specialties

Create or upsert a specialty (surgeon pattern: upsert by `[clinicId, slug, language]` uniqueness).

**Authentication:** Yes — `JwtAuthGuard`

**Request Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Authorization | `Bearer <token>` | Yes |
| Content-Type | `application/json` | Yes |

**Request Body (`CreateSpecialtyDto`):**
```json
{
  "label": "Médecine Générale",
  "language": "FR",
  "slug": "general",
  "isActive": true,
  "displayOrder": 1
}
```

**Validation Rules:**
| Field | Type | Validator |
|-------|------|-----------|
| `label` | string | `@IsString() @IsNotEmpty()` |
| `language` | enum | `@IsEnum(Language) @IsNotEmpty()` |
| `slug` | string | `@IsString() @IsNotEmpty()` |
| `isActive` | boolean | `@IsOptional() @IsBoolean()` |
| `displayOrder` | number | `@IsOptional() @IsInt()` |

**Response (200/201):**
```json
{
  "id": "clx...",
  "clinicId": "clx...",
  "label": "Médecine Générale",
  "language": "FR",
  "slug": "general",
  "isActive": true,
  "displayOrder": 1,
  "createdAt": "2026-06-09T20:30:00.000Z"
}
```

**Error Responses:**
| Status | Body | Condition |
|--------|------|-----------|
| 401 | `{ "message": "Unauthorized", "statusCode": 401 }` | Missing/invalid JWT |

**Prisma Model:** `Specialty`
- Unique constraint: `@@unique([clinicId, slug, language])`
- Operation: `upsert` using composite unique key

### GET /api/admin/v1/specialties

List all specialties for the clinic, optionally filtered by language.

**Authentication:** Yes — `JwtAuthGuard`

**Request Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Authorization | `Bearer <token>` | Yes |

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `language` | enum (Language) | No | Filter: `FR`, `EN`, `AR` |

**Response (200 OK):**
```json
[
  {
    "id": "clx...",
    "clinicId": "clx...",
    "label": "Médecine Générale",
    "language": "FR",
    "slug": "general",
    "isActive": true,
    "displayOrder": 1,
    "createdAt": "2026-06-09T20:30:00.000Z"
  }
]
```

Results ordered by `displayOrder` ascending.

**Prisma Model:** `Specialty`
- Query: `findMany({ where: { clinicId, language? }, orderBy: { displayOrder: 'asc' } })`

### PATCH /api/admin/v1/specialties/:id

Update a specialty.

**Authentication:** Yes — `JwtAuthGuard`

**Request Body (`UpdateSpecialtyDto`):**
```json
{
  "label": "Médecine Générale - Mise à jour",
  "language": "FR",
  "slug": "general",
  "isActive": true,
  "displayOrder": 2
}
```

All fields optional.

**Prisma Model:** `Specialty`
- Operation: `update({ where: { id }, data: dto })`

### DELETE /api/admin/v1/specialties/:id

Soft-delete a specialty (sets `isActive = false`).

**Authentication:** Yes — `JwtAuthGuard`

**Prisma Model:** `Specialty`
- Operation: `update({ where: { id }, data: { isActive: false } })`

---

## 7. FAQs

Full CRUD. All endpoints guarded by `JwtAuthGuard`.

### POST /api/admin/v1/faqs

Create a new FAQ.

**Authentication:** Yes — `JwtAuthGuard`

**Request Body (`CreateFaqDto`):**
```json
{
  "question": "Quels sont vos horaires d'ouverture ?",
  "answer": "Nous sommes ouverts du lundi au vendredi de 8h à 18h.",
  "language": "FR",
  "keywords": ["horaires", "heures", "ouverture"],
  "displayOrder": 1
}
```

**Validation Rules:**
| Field | Type | Validator |
|-------|------|-----------|
| `question` | string | `@IsString() @IsNotEmpty()` |
| `answer` | string | `@IsString() @IsNotEmpty()` |
| `language` | string | `@IsString() @IsNotEmpty()` |
| `keywords` | string[] | `@IsOptional() @IsString({ each: true })` |
| `displayOrder` | number | `@IsOptional() @IsInt()` |

**Prisma Model:** `FAQ`

### GET /api/admin/v1/faqs

List all FAQs for the clinic, filtered by language.

**Authentication:** Yes — `JwtAuthGuard`

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `language` | enum (Language) | No | Filter: `FR`, `EN`, `AR` |

**Response:** Array of `FAQ` objects. Only returns `isActive: true` FAQs. Ordered by `displayOrder` ascending.

### PATCH /api/admin/v1/faqs/:id

Update a FAQ.

**Request Body (`UpdateFaqDto`):** All fields optional.

### DELETE /api/admin/v1/faqs/:id

Soft-delete a FAQ (sets `isActive = false`).

---

## 8. Time Slots

Full CRUD nested under `/doctors/:doctorId/timeslots`. All endpoints guarded by `JwtAuthGuard`.

### POST /api/admin/v1/doctors/:doctorId/timeslots

Create a weekly time slot for a doctor.

**Authentication:** Yes — `JwtAuthGuard`

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `doctorId` | string | Doctor UUID |

**Request Body (`CreateTimeSlotDto`):**
```json
{
  "dayOfWeek": 1,
  "startTime": "09:00",
  "endTime": "17:00",
  "slotDurationMinutes": 30,
  "isActive": true
}
```

**Validation Rules:**
| Field | Type | Validator | Notes |
|-------|------|-----------|-------|
| `dayOfWeek` | number | `@IsInt() @Min(0) @Max(6)` | 0=Sunday, 1=Monday, ..., 6=Saturday |
| `startTime` | string | `@IsString() @IsNotEmpty()` | Format `"HH:mm"` |
| `endTime` | string | `@IsString() @IsNotEmpty()` | Format `"HH:mm"` |
| `slotDurationMinutes` | number | `@IsOptional() @IsInt()` | Defaults to `30` |
| `isActive` | boolean | `@IsOptional() @IsBoolean()` | Defaults to `true` |

**Prisma Model:** `TimeSlot`
- Operation: `create({ data: { doctorId, ... } })`

### GET /api/admin/v1/doctors/:doctorId/timeslots

List all time slots for a doctor.

**Authentication:** Yes — `JwtAuthGuard`

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `doctorId` | string | Doctor UUID |

**Response (200 OK):**
```json
[
  {
    "id": "clx...",
    "doctorId": "clx...",
    "dayOfWeek": 1,
    "startTime": "09:00",
    "endTime": "17:00",
    "slotDurationMinutes": 30,
    "isActive": true
  }
]
```

**Prisma Model:** `TimeSlot`
- Query: `findMany({ where: { doctorId } })`

### PATCH /api/admin/v1/doctors/:doctorId/timeslots/:id

Update a time slot. All fields optional.

**Prisma Model:** `TimeSlot`
- Operation: `update({ where: { id }, data: dto })`

### DELETE /api/admin/v1/doctors/:doctorId/timeslots/:id

Hard-delete a time slot.

**Response (200 OK):** Returns the deleted object.

**Prisma Model:** `TimeSlot`
- Operation: `delete({ where: { id } })`

---

## 9. Appointments

All endpoints guarded by `JwtAuthGuard`.

### GET /api/admin/v1/appointments

List appointments with optional filters. Includes related `doctor` and `specialty` data.

**Authentication:** Yes — `JwtAuthGuard`

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string (ISO date) | No | Filter by exact date: `"2026-06-10"` |
| `doctorId` | string | No | Filter by doctor UUID |
| `status` | enum (AppointmentStatus) | No | `PENDING`, `CONFIRMED`, `CANCELLED`, `COMPLETED`, `NO_SHOW` |

**Response (200 OK):**
```json
[
  {
    "id": "clx...",
    "clinicId": "clx...",
    "doctorId": "clx...",
    "specialtyId": "clx...",
    "patientName": "Houdaifa Fadrahm",
    "patientPhone": "+212600000000",
    "appointmentDate": "2026-06-10T00:00:00.000Z",
    "appointmentTime": "10:30",
    "status": "PENDING",
    "notes": null,
    "createdAt": "2026-06-09T20:30:00.000Z",
    "updatedAt": "2026-06-09T20:30:00.000Z",
    "doctor": {
      "id": "clx...",
      "clinicId": "clx...",
      "specialtyId": "clx...",
      "name": "Dr. Ahmed Benali",
      "bio": "...",
      "isActive": true,
      "displayOrder": 1,
      "createdAt": "..."
    },
    "specialty": {
      "id": "clx...",
      "clinicId": "clx...",
      "label": "Médecine Générale",
      "language": "FR",
      "slug": "general",
      "isActive": true,
      "displayOrder": 1,
      "createdAt": "..."
    }
  }
]
```

Results ordered by `appointmentDate` ascending.

**Prisma Model:** `Appointment`
- Includes: `doctor`, `specialty` relations

### PATCH /api/admin/v1/appointments/:id/status

Update an appointment's status.

**Authentication:** Yes — `JwtAuthGuard`

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Appointment UUID |

**Request Body (`UpdateStatusDto`):**
```json
{
  "status": "CONFIRMED"
}
```

**Validation Rules:**
| Field | Type | Validator |
|-------|------|-----------|
| `status` | enum | `@IsEnum(AppointmentStatus)` |

**Allowed Status Values:** `PENDING`, `CONFIRMED`, `CANCELLED`, `COMPLETED`, `NO_SHOW`

**Response (200 OK):**
```json
{
  "id": "clx...",
  "clinicId": "clx...",
  "doctorId": "clx...",
  "specialtyId": "clx...",
  "patientName": "...",
  "patientPhone": "...",
  "appointmentDate": "2026-06-10T00:00:00.000Z",
  "appointmentTime": "10:30",
  "status": "CONFIRMED",
  "notes": null,
  "createdAt": "...",
  "updatedAt": "..."
}
```

**Error Responses:**
| Status | Body | Condition |
|--------|------|-----------|
| 401 | `{ "message": "Unauthorized", "statusCode": 401 }` | Missing/invalid JWT |
| generic | Error thrown | Appointment not found in this clinic |

**Prisma Model:** `Appointment`
- Guard: verifies appointment belongs to clinic
- Operation: `update({ where: { id }, data: { status } })`

### Internal — CREATE (Bot Flow)

**Note:** The `POST` endpoint for creating appointments exists in the service (`AppointmentsService.createAppointment`) but is **not exposed as an admin controller endpoint**. It is used internally by the WhatsApp bot orchestration flow.

**Request Body (`CreateAppointmentDto`):**
```json
{
  "clinicId": "clx...",
  "doctorId": "clx...",
  "specialtyId": "clx...",
  "patientName": "Houdaifa Fadrahm",
  "patientPhone": "+212600000000",
  "appointmentDate": "2026-06-10",
  "appointmentTime": "10:30"
}
```

**Validation:**
- All fields required: `@IsString() @IsNotEmpty()`
- `appointmentDate`: `@IsDateString()`
- Service validates doctor belongs to clinic, specialty belongs to clinic, doctor-specialty match
- Conflict check: no existing `PENDING` or `CONFIRMED` appointment for same doctor/date/time

**Prisma Model:** `Appointment`
- Concept: `create({ data: { ...dto, clinicId, appointmentDate: new Date(date) } })`

---

## 10. Handoff Sessions

### POST /api/admin/v1/handoff/resolve

Resolve a human handoff session and return the patient to the bot flow.

**Authentication:** Yes — `JwtAuthGuard`

**Request Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Authorization | `Bearer <token>` | Yes |
| Content-Type | `application/json` | Yes |

**Request Body (`ResolveHandoffDto`):**
```json
{
  "phone": "+212600000000"
}
```

**Validation Rules:**
| Field | Type | Validator |
|-------|------|-----------|
| `phone` | string | `@IsString() @IsNotEmpty()` |

**Response (200 OK):**
```json
{
  "message": "Handoff resolved successfully."
}
```

**Behavior:**
1. Fetches or creates the session for the given phone number
2. If session state is `AWAITING_HANDOFF`, sets state to `IDLE` and saves
3. If session is not in handoff state, logs a warning and returns without action

**Error Responses:**
| Status | Body | Condition |
|--------|------|-----------|
| 401 | `{ "message": "Unauthorized", "statusCode": 401 }` | Missing/invalid JWT |

**Prisma/Redis Model:** Session (Redis-based, not Prisma)
- Session state machine: `AWAITING_HANDOFF → IDLE`
- Redis TTL: 30 minutes

---

## 11. WhatsApp Webhook (Meta Cloud API)

### GET /webhook

Verification endpoint called by Meta during webhook setup.

**Authentication:** No (uses a shared verify token)

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `hub.mode` | string | Yes | Must be `"subscribe"` |
| `hub.verify_token` | string | Yes | Checked against `META_VERIFY_TOKEN` env var |
| `hub.challenge` | string | Yes | Echoed back on success |

**Response (200):** Returns `challenge` string value on success.

**Response (401):** `{ "message": "Verification failed", "statusCode": 401 }` on token mismatch.

### POST /webhook

Receive incoming WhatsApp messages via Meta Cloud API.

**Authentication:** Signature verification (HMAC-SHA256)

**Request Headers:**
| Header | Value | Required |
|--------|-------|----------|
| Content-Type | `application/json` | Yes |
| `x-hub-signature-256` | `sha256=...` | Yes (enforced in production) |

**Request Body (WebhookDto):**
```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WHATSAPP_BUSINESS_ACCOUNT_ID",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "+212600000000",
              "phone_number_id": "PHONE_NUMBER_ID"
            },
            "contacts": [
              {
                "profile": { "name": "Houdaifa" },
                "wa_id": "+212600000001"
              }
            ],
            "messages": [
              {
                "from": "+212600000001",
                "id": "wamid.xxx",
                "timestamp": "1717959600",
                "type": "text",
                "text": { "body": "Bonjour, je veux prendre un rendez-vous" }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
```

**Response (200):**
```json
{
  "status": "ok"
}
```

**Internal Flow:**
1. Signature is verified (skipped in development mode)
2. Message payload is extracted (text body or interactive button/list reply)
3. A `MessageJob` is enqueued to BullMQ `MESSAGES` queue with `PROCESS_MESSAGE` job name
4. Job includes: `from`, `name`, `text`, `messageId`, `timestamp`
5. Queue config: 3 attempts, exponential backoff, keep last 100 completed / 50 failed

**Error Responses:**
| Status | Body | Condition |
|--------|------|-----------|
| 401 | `{ "message": "Invalid signature", "statusCode": 401 }` | Signature verification fails (production only) |

**Prisma Model:** None (data flows into Redis sessions and BullMQ queue)

---

## 12. Root Health

### GET /

Simple hello-world check.

**Authentication:** No

**Response:** `"Hello World!"` (plain text)