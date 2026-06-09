# Frontend Requirements — Healthcare Bot Admin Dashboard

> **React Admin Dashboard** | Consumes the NestJS API documented in `API_REFERENCE.md`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Login / Auth](#2-login--auth)
3. [Dashboard (Stats)](#3-dashboard-stats)
4. [Clinic Settings](#4-clinic-settings)
5. [Doctors Management](#5-doctors-management)
6. [Specialties Management](#6-specialties-management)
7. [FAQs Management](#7-faqs-management)
8. [Time Slots Management](#8-time-slots-management)
9. [Bot Messages Management](#9-bot-messages-management)
10. [Appointments Management](#10-appointments-management)
11. [Handoff Sessions](#11-handoff-sessions)
12. [Navigation Structure](#12-navigation-structure)
13. [Global Concerns](#13-global-concerns)

---

## 1. Architecture Overview

### Tech Stack (Recommended)

| Layer | Technology |
|-------|-----------|
| Framework | React 18+ with TypeScript |
| Routing | React Router v6+ |
| State Management | React Query (TanStack Query) for server state |
| HTTP Client | Axios or Fetch API |
| UI Library | shadcn/ui, Material UI, or Ant Design |
| Forms | React Hook Form + Zod validation |
| Tables | TanStack Table (React Table) |
| Charts | Recharts or Chart.js |
| Auth | JWT stored in httpOnly cookies or localStorage |

### Base URL

```
API_BASE_URL = process.env.REACT_APP_API_URL || "http://localhost:3000"
```

### Auth Header

Every authenticated request must include:
```
Authorization: Bearer {access_token}
```

### Multi-Tenancy

The `clinicId` is embedded in the JWT. All admin CRUD endpoints automatically scope data to the authenticated admin's clinic. No manual clinicId selection is needed for single-clinic admins.

### Languages

The system supports `FR` (French), `EN` (English), and `AR` (Arabic). All language-filterable endpoints accept a `?language=` query parameter.

---

## 2. Login / Auth

### Endpoint

- **POST** `/api/admin/v1/auth/login`

### Required Actions

| Action | Type | Endpoint |
|--------|------|----------|
| Login | Create (session) | `POST /api/admin/v1/auth/login` |
| Logout | Delete (session) | Client-side only (clear token) |
| Auto-login | Read | Check stored JWT on app mount |

### Form Fields

| Field | Type | Validation | Component |
|-------|------|------------|-----------|
| Email | string (email) | Required, valid email format | Text input |
| Password | string | Required | Password input with show/hide toggle |

### Response Handling

1. On success → store `access_token` and `admin` profile in auth context
2. Decode JWT to extract: `admin.id`, `admin.email`, `admin.role`, `admin.clinicId`
3. Redirect to `/dashboard`
4. On 401 → show inline error message "Invalid credentials"

### Required Permissions

None (public endpoint).

---

## 3. Dashboard (Stats)

### Endpoint

- **GET** `/api/admin/v1/stats` (authenticated)

### Page Layout

```
┌──────────────────────────────────────────┐
│              Dashboard                    │
├──────────┬──────────┬────────────────────┤
│  Total   │  Today   │     Pending        │
│  150     │    8     │     12             │
│ Appts    │ Appts    │     Appts          │
├──────────┴──────────┴────────────────────┤
│                                          │
│     [Upcoming Appointments Today]        │
│     (use GET /api/admin/v1/appointments  │
│      with ?date=today)                   │
│                                          │
└──────────────────────────────────────────┘
```

### Required Data

| Stat Card | Source Field | Icon | Color |
|-----------|-------------|------|-------|
| Total Appointments | `totalAppointments` | Calendar | Blue |
| Today's Appointments | `todayAppointments` | Clock | Green |
| Pending Appointments | `pendingAppointments` | Hourglass | Amber |

### Additional Suggestions (Future Enhancement)

The backend returns only 3 aggregate counts. For a richer dashboard, optionally batch-call:
- `GET /api/admin/v1/appointments?date={today}` to show today's upcoming appointments list
- `GET /api/admin/v1/appointments?status=PENDING` to show pending items needing attention

### CRUD Actions

None (read-only stats endpoint).

### Required Permissions

Any authenticated admin (`CLINIC_ADMIN` or `SUPER_ADMIN`).

---

## 4. Clinic Settings

### Endpoints

| Action | Method | Route |
|--------|--------|-------|
| View settings | `GET` | `/api/admin/v1/clinics` |
| Update settings | `PATCH` | `/api/admin/v1/clinics` |

### Page Layout

Settings form page with sections:

**General Information:**
| Field | Key in DTO | Type | Component |
|-------|-----------|------|-----------|
| Clinic Name | `name` | text | Input |
| Phone | `phone` | tel | Input with country code |
| Address | `address` | text | Textarea |
| Timezone | `timezone` | select (IANA list) | Combobox searchable |
| Default Language | `defaultLanguage` | select | Radio group / Select: FR, EN, AR |
| Supported Languages | `supportedLangs` | multi-select | Checkbox group: FR, EN, AR |
| Active | `isActive` | boolean | Toggle switch |

### Form Behavior

1. **GET** on mount → populate form
2. **PATCH** on save → send only changed fields (all optional)
3. Show success/error toast after update
4. Disable `isActive` toggle with confirmation dialog: "Deactivating the clinic will pause all bot interactions. Continue?"

### CRUD Actions

| Action | Endpoint | Notes |
|--------|----------|-------|
| Read | `GET /api/admin/v1/clinics` | Load on page mount |
| Update | `PATCH /api/admin/v1/clinics` | Partial update (PATCH) |

### Required Modals/Dialogs

- **Deactivate Confirmation Modal:** "Are you sure you want to deactivate this clinic?"

### Required Permissions

Any authenticated admin.

---

## 5. Doctors Management

### Endpoints

| Action | Method | Route |
|--------|--------|-------|
| List | `GET` | `/api/admin/v1/doctors?specialtyId=&isActive=` |
| Create | `POST` | `/api/admin/v1/doctors` |
| Update | `PATCH` | `/api/admin/v1/doctors/:id` |
| Delete | `DELETE` | `/api/admin/v1/doctors/:id` (soft-delete → `isActive=false`) |

### Required Table Columns

| Column | Field | Type | Sortable | Filterable |
|--------|-------|------|----------|------------|
| Name | `name` | string | Yes | Yes (text search) |
| Specialty | `specialtyId` → resolve via specialty label | string | Yes | Yes (dropdown) |
| Bio | `bio` | string (truncated) | No | No |
| Active | `isActive` | boolean (badge) | Yes | Yes (toggle filter) |
| Display Order | `displayOrder` | number | Yes | No |
| Created | `createdAt` | date | Yes | No |

### Required Filters

| Filter | Source | Component | Behavior |
|--------|--------|-----------|----------|
| Specialty | `specialtyId` | Dropdown (load from `GET /api/admin/v1/specialties`) | Filters doctors by specialty |
| Active Status | `isActive` | Radio / Toggle: All, Active, Inactive | Sends `?isActive=true\|false` |

### Required Forms

**Create / Edit Doctor Form:**
| Field | Key | Type | Validation | Required |
|-------|-----|------|------------|----------|
| Name | `name` | Text input | `@IsString() @IsNotEmpty()` | Yes |
| Specialty | `specialtyId` | Select from specialties list | `@IsString() @IsNotEmpty()` | Yes |
| Bio | `bio` | Textarea | `@IsOptional() @IsString()` | No |
| Active | `isActive` | Toggle | `@IsOptional() @IsBoolean()` | No (defaults true) |
| Display Order | `displayOrder` | Number input | `@IsOptional() @IsInt()` | No |

### Required Modals/Dialogs

- **Create Doctor Modal:** Opens form in a modal/drawer
- **Edit Doctor Modal:** Opens pre-filled form in a modal/drawer
- **Delete Confirmation Dialog:** "Are you sure you want to deactivate Dr. {name}? This will soft-delete the doctor."
- **Time Slots Drawer:** Button in table row → navigates to nested Time Slots page for that doctor

### CRUD Actions

| Action | Implementation |
|--------|---------------|
| List | Table with pagination (future: backend doesn't paginate yet) |
| Create | Modal form → POST → refetch list |
| Edit | Modal form (pre-filled) → PATCH → refetch list |
| Delete | Confirmation dialog → DELETE (soft-delete) → refetch list |
| View Slots | Button → navigate to `/doctors/:id/timeslots` |

### Required Permissions

Any authenticated admin.

### Notes

- `specialtyId` must be validated: specialty must exist and belong to the same clinic (backend enforces this)
- Fetch specialties list once and cache it for the dropdown

---

## 6. Specialties Management

### Endpoints

| Action | Method | Route |
|--------|--------|-------|
| List | `GET` | `/api/admin/v1/specialties?language=` |
| Create | `POST` | `/api/admin/v1/specialties` |
| Update | `PATCH` | `/api/admin/v1/specialties/:id` |
| Delete | `DELETE` | `/api/admin/v1/specialties/:id` (soft-delete → `isActive=false`) |

### Required Table Columns

| Column | Field | Type | Sortable | Filterable |
|--------|-------|------|----------|------------|
| Label | `label` | string | Yes | Yes (text search) |
| Slug | `slug` | string | Yes | Yes |
| Language | `language` | badge | Yes | Yes (dropdown) |
| Active | `isActive` | badge | Yes | Yes (toggle) |
| Display Order | `displayOrder` | number | Yes | No |
| Created | `createdAt` | date | Yes | No |

### Required Filters

| Filter | Source | Component | Behavior |
|--------|--------|-----------|----------|
| Language | `language` | Dropdown: All, FR, EN, AR | Sends `?language=FR` |

### Required Forms

**Create / Edit Specialty Form:**
| Field | Key | Type | Validation |
|-------|-----|------|------------|
| Label | `label` | Text input | `@IsString() @IsNotEmpty()` |
| Language | `language` | Select: FR, EN, AR | `@IsEnum(Language) @IsNotEmpty()` |
| Slug | `slug` | Text input | `@IsString() @IsNotEmpty()` |
| Active | `isActive` | Toggle | `@IsOptional()` |
| Display Order | `displayOrder` | Number input | `@IsOptional() @IsInt()` |

### Required Modals/Dialogs

- **Create Specialty Modal**
- **Edit Specialty Modal**
- **Delete Confirmation Dialog**

### CRUD Actions

| Action | Implementation |
|--------|---------------|
| List | Table with language filter |
| Create | Modal form → POST (upsert by slug+language) → refetch |
| Edit | Modal form → PATCH → refetch |
| Delete | Confirmation → DELETE (soft-delete) → refetch |

### Required Permissions

Any authenticated admin.

### Notes

- Upsert behavior: creating a specialty with the same `slug` + `language` for the clinic will UPDATE it instead of creating a duplicate
- Deleting a specialty that has doctors assigned may cause FK issues — backend does NOT check this currently (consider adding warning in UI)

---

## 7. FAQs Management

### Endpoints

| Action | Method | Route |
|--------|--------|-------|
| List | `GET` | `/api/admin/v1/faqs?language=` |
| Create | `POST` | `/api/admin/v1/faqs` |
| Update | `PATCH` | `/api/admin/v1/faqs/:id` |
| Delete | `DELETE` | `/api/admin/v1/faqs/:id` (soft-delete → `isActive=false`) |

### Required Table Columns

| Column | Field | Type | Sortable | Filterable |
|--------|-------|------|----------|------------|
| Question | `question` | string (truncated to 80 chars) | Yes | Yes (text search) |
| Answer | `answer` | string (truncated to 100 chars) | No | No |
| Language | `language` | badge | Yes | Yes (dropdown) |
| Keywords | `keywords` | tags/array | No | Yes (by keyword) |
| Display Order | `displayOrder` | number | Yes | No |
| Active | `isActive` | badge | Yes | Yes (toggle) |

### Required Filters

| Filter | Source | Component | Behavior |
|--------|--------|-----------|----------|
| Language | `language` | Dropdown: All, FR, EN, AR | Sends `?language=FR` |

### Required Forms

**Create / Edit FAQ Form:**
| Field | Key | Type | Validation |
|-------|-----|------|------------|
| Question | `question` | Textarea | `@IsString() @IsNotEmpty()` |
| Answer | `answer` | Rich text or Textarea | `@IsString() @IsNotEmpty()` |
| Language | `language` | Select: FR, EN, AR | `@IsString() @IsNotEmpty()` |
| Keywords | `keywords` | Tag input / chips | `@IsOptional()` |
| Display Order | `displayOrder` | Number input | `@IsOptional() @IsInt()` |

### Required Modals/Dialogs

- **Create FAQ Modal**
- **Edit FAQ Modal** (pre-filled with existing values)
- **Delete Confirmation Dialog**

### CRUD Actions

| Action | Implementation |
|--------|---------------|
| List | Table with language filter |
| Create | Modal form → POST → refetch |
| Edit | Modal form (pre-filled) → PATCH → refetch |
| Delete | Confirmation → DELETE (soft-delete) → refetch |

### Required Permissions

Any authenticated admin.

---

## 8. Time Slots Management

This is a **nested resource** under a specific doctor. Access via:
- Navigate to **Doctors** list → click "Time Slots" action on a row
- Or route: `/doctors/:doctorId/timeslots`

### Endpoints

| Action | Method | Route |
|--------|--------|-------|
| List | `GET` | `/api/admin/v1/doctors/:doctorId/timeslots` |
| Create | `POST` | `/api/admin/v1/doctors/:doctorId/timeslots` |
| Update | `PATCH` | `/api/admin/v1/doctors/:doctorId/timeslots/:id` |
| Delete | `DELETE` | `/api/admin/v1/doctors/:doctorId/timeslots/:id` (hard-delete) |

### Page Header

Display: **"Time Slots for Dr. {doctorName}"** with a back button to `/doctors`.

### Required Table Columns

| Column | Field | Type | Sortable | Notes |
|--------|-------|------|----------|-------|
| Day of Week | `dayOfWeek` | string (mapped to name) | Yes | 0=Sun, 1=Mon, ... 6=Sat |
| Start Time | `startTime` | string "HH:mm" | Yes | — |
| End Time | `endTime` | string "HH:mm" | Yes | — |
| Slot Duration | `slotDurationMinutes` | number (minutes) | Yes | Default: 30 |
| Active | `isActive` | badge | Yes | — |

### Required Filters

None. List is scoped to a single doctor.

### Required Forms

**Create / Edit Time Slot Form:**
| Field | Key | Type | Validation |
|-------|-----|------|------------|
| Day of Week | `dayOfWeek` | Select: Sun(0) → Sat(6) | `@IsInt() @Min(0) @Max(6)` |
| Start Time | `startTime` | Time picker "HH:mm" | `@IsString() @IsNotEmpty()` |
| End Time | `endTime` | Time picker "HH:mm" | `@IsString() @IsNotEmpty()` |
| Slot Duration | `slotDurationMinutes` | Number input | `@IsOptional() @IsInt()` (default 30) |
| Active | `isActive` | Toggle | `@IsOptional() @IsBoolean()` |

### Validation (Form-Side)

- `startTime` must be before `endTime`
- `slotDurationMinutes` should be positive (e.g., 15, 20, 30, 45, 60)
- Warn if overlap with existing slot for the same `dayOfWeek` (backend does NOT check overlap)

### Required Modals/Dialogs

- **Create Time Slot Modal**
- **Edit Time Slot Modal**
- **Delete Confirmation Dialog:** "Permanently delete this time slot?" (this is a HARD delete)

### CRUD Actions

| Action | Implementation |
|--------|---------------|
| List | Table scoped to doctor ID |
| Create | Modal form → POST → refetch |
| Edit | Modal form → PATCH → refetch |
| Delete | Confirmation dialog → DELETE (hard-delete) → refetch |

### Required Permissions

Any authenticated admin.

### Notes

- Unlike other resources, time slot delete is **hard delete** (`prisma.delete`)
- Display `dayOfWeek` as human-readable: Sunday, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday
- Display `slotDurationMinutes` as "30 min" format

---

## 9. Bot Messages Management

### Endpoints

| Action | Method | Route |
|--------|--------|-------|
| List | `GET` | `/api/admin/v1/clinic/:clinicId/messages?language=` |
| Update | `PATCH` | `/api/admin/v1/clinic/:clinicId/messages/:key/:language` |

### Required Table Columns

| Column | Field | Type | Sortable | Filterable |
|--------|-------|------|----------|------------|
| Key | `key` | badge (enum) | Yes | Yes (dropdown) |
| Body | `body` | string (truncated) | No | Yes (text search) |
| Language | `language` | badge | Yes | Yes (dropdown) |
| Last Updated | `updatedAt` | date | Yes | No |

### Required Filters

| Filter | Source | Component | Behavior |
|--------|--------|-----------|----------|
| Language | `language` | Dropdown: All, FR, EN, AR | Sends `?language=FR` |
| Key | `key` | Multi-select dropdown of MessageKey values | Client-side filter (backend doesn't support key filter) |

### Required Forms

**Edit Message Form:**
| Field | Key | Type | Validation |
|-------|-----|------|------------|
| Message Body | `body` | Rich text / Textarea (supports template variables) | `@IsString() @IsNotEmpty()` |
| Key | `key` | Read-only label | — |
| Language | `language` | Read-only badge | — |

### Template Variables Legend

Show a help panel listing available template variables that can be used in messages:
- `{{patientName}}` — Patient's first name
- `{{doctorName}}` — Selected doctor's name
- `{{date}}` — Appointment date
- `{{time}}` — Appointment time
- `{{specialty}}` — Selected specialty name

### Required Modals/Dialogs

- **Edit Message Drawer/Modal:** Shows the message body in a large textarea with the template variables legend
- **Preview Dialog:** Show a preview of the message with mock variable substitution

### CRUD Actions

| Action | Implementation |
|--------|---------------|
| List | Table with language filter |
| Edit | Click row → Open drawer/modal → PATCH → refetch |

**Note:** There is NO create or delete for bot messages. Messages are seeded by the backend (`prisma/fixtures/bot-messages.*.json`) and can only be edited.

### Required Permissions

Any authenticated admin.

---

## 10. Appointments Management

### Endpoints

| Action | Method | Route |
|--------|--------|-------|
| List | `GET` | `/api/admin/v1/appointments?date=&doctorId=&status=` |
| Update Status | `PATCH` | `/api/admin/v1/appointments/:id/status` |

### Required Table Columns

| Column | Field | Type | Sortable | Filterable |
|--------|-------|------|----------|------------|
| Patient Name | `patientName` | string | Yes | Yes (text search — client-side) |
| Patient Phone | `patientPhone` | string | Yes | Yes |
| Doctor | `doctor.name` | string (from included relation) | Yes | Yes (dropdown: load doctors list) |
| Specialty | `specialty.label` | string (from included relation) | No | No |
| Date | `appointmentDate` | date | Yes | Yes (date picker) |
| Time | `appointmentTime` | string "HH:mm" | Yes | No |
| Status | `status` | badge (colored) | Yes | Yes (multi-select dropdown) |
| Notes | `notes` | string (truncated) | No | No |
| Created | `createdAt` | date | Yes | No |

### Status Badge Colors

| Status | Color |
|--------|-------|
| PENDING | Amber / Yellow |
| CONFIRMED | Green |
| CANCELLED | Red |
| COMPLETED | Blue |
| NO_SHOW | Gray |

### Required Filters

| Filter | Source | Component | Behavior |
|--------|--------|-----------|----------|
| Date | `date` | Date picker | Sends `?date=2026-06-10` |
| Doctor | `doctorId` | Dropdown (load from `GET /api/admin/v1/doctors`) | Sends `?doctorId=...` |
| Status | `status` | Multi-select dropdown | Sends `?status=PENDING` |

### Required Actions per Row

| Action | Implementation | Endpoint |
|--------|---------------|----------|
| View Details | Expandable row or side panel | Data already in row + included relations |
| Confirm | Button / Action menu | `PATCH /:id/status` body: `{ "status": "CONFIRMED" }` |
| Cancel | Button / Action menu | `PATCH /:id/status` body: `{ "status": "CANCELLED" }` |
| Mark Completed | Button / Action menu | `PATCH /:id/status` body: `{ "status": "COMPLETED" }` |
| Mark No-Show | Button / Action menu | `PATCH /:id/status` body: `{ "status": "NO_SHOW" }` |

### Status Transition Logic (Frontend)

```
PENDING ──→ CONFIRMED ──→ COMPLETED
  │                          │
  ├──→ CANCELLED              │
  └──→ NO_SHOW ←─────────────┘
```

**Rules:**
- From `PENDING`: can go to `CONFIRMED`, `CANCELLED`, or `NO_SHOW`
- From `CONFIRMED`: can go to `COMPLETED`, `CANCELLED`, or `NO_SHOW`
- From `COMPLETED`: no further transitions
- From `CANCELLED`: no further transitions
- From `NO_SHOW`: no further transitions

Disable action buttons based on current status.

### Required Modals/Dialogs

- **Appointment Detail Drawer:** Expanded information including patient contact, assigned doctor, specialty, date/time, notes, and status history
- **Status Change Confirmation Dialog:** "Change appointment status from {current} to {new}?" for sensitive transitions like CANCELLED
- **Call Patient Action:** A button/link with `tel:+212xxxx` to call the patient directly

### CRUD Actions

| Action | Implementation |
|--------|---------------|
| List | Table with date, doctor, status filters |
| Update Status | Action menu → Confirmation → PATCH → refetch |

**Note:** There is NO create or delete for appointments from the admin panel. Appointments are created by the WhatsApp bot flow.

### Required Permissions

Any authenticated admin.

---

## 11. Handoff Sessions

### Endpoints

| Action | Method | Route |
|--------|--------|-------|
| Resolve Handoff | `POST` | `/api/admin/v1/handoff/resolve` |

### Required Table Columns

**Note:** There is currently no `GET /handoff` endpoint in the backend to list active handoff sessions. You will need one of:

**Option A (Recommended):** Add a backend endpoint `GET /api/admin/v1/handoff` that queries Redis for sessions with `state: AWAITING_HANDOFF`.

**Option B:** Build a simple input-based interface.

### Page Section

```
┌──────────────────────────────────────────┐
│         Active Handoffs                   │
├──────────────────────────────────────────┤
│                                          │
│  [Search by Phone: ___________]          │
│                                          │
│  Table (if Option A implemented)         │
│  ┌──────┬──────┬──────────┬──────────┐  │
│  │Phone │Patient│ Started  │ Action   │  │
│  ├──────┼──────┼──────────┼──────────┤  │
│  │+2126 │ Ahmed │ 10:30 AM │[Resolve] │  │
│  └──────┴──────┴──────────┴──────────┘  │
│                                          │
│  OR Simple Form (if no list endpoint):   │
│  Phone: [_________________] [Resolve]    │
│                                          │
└──────────────────────────────────────────┘
```

### Required Form (Minimum Viable)

| Field | Key | Type | Validation |
|-------|-----|------|------------|
| Patient Phone | `phone` | Tel input with country code | `@IsString() @IsNotEmpty()` |

### CRUD Actions

| Action | Implementation |
|--------|---------------|
| Resolve | Enter phone → POST resolve → show success toast |
| List | (Future) GET endpoint needed to fetch active handoffs |

### Required Permissions

Any authenticated admin.

---

## 12. Navigation Structure

```
Sidebar Navigation
─────────────────────
📊  Dashboard         → /dashboard
👨‍⚕️  Doctors           → /doctors
     └─ Time Slots    → /doctors/:id/timeslots
🏷️  Specialties       → /specialties
❓  FAQs              → /faqs
💬  Bot Messages      → /messages
📅  Appointments      → /appointments
🔄  Handoffs          → /handoff
⚙️  Clinic Settings   → /settings
```

### Route Definitions

```typescript
const routes = [
  { path: '/login', component: LoginPage, public: true },
  { path: '/dashboard', component: DashboardPage, protected: true },
  { path: '/doctors', component: DoctorsPage, protected: true },
  { path: '/doctors/:doctorId/timeslots', component: TimeSlotsPage, protected: true },
  { path: '/specialties', component: SpecialtiesPage, protected: true },
  { path: '/faqs', component: FaqsPage, protected: true },
  { path: '/messages', component: BotMessagesPage, protected: true },
  { path: '/appointments', component: AppointmentsPage, protected: true },
  { path: '/handoff', component: HandoffPage, protected: true },
  { path: '/settings', component: ClinicSettingsPage, protected: true },
  { path: '/', redirectTo: '/dashboard', protected: true },
];
```

---

## 13. Global Concerns

### 13.1 Authentication Flow

1. On app mount, check for stored JWT
2. If valid → decode token → set auth context → redirect to dashboard
3. If expired/missing → redirect to `/login`
4. On any 401 API response → clear token → redirect to `/login`
5. Axios interceptor to attach `Authorization: Bearer <token>` header to all requests

### 13.2 Error Handling

| HTTP Status | Frontend Behavior |
|-------------|-------------------|
| 400 | Show validation error from response |
| 401 | Redirect to login, clear session |
| 404 | Show "Not Found" toast/alert |
| 409 (Conflict) | Show conflict message (e.g., "Slot already booked") |
| 500 | Show generic error toast |
| Network Error | Show "Unable to connect to server" |

### 13.3 Loading States

Every page/data-fetch should handle:
- **Loading**: Skeleton loaders or spinner
- **Empty**: "No records found" illustration with CTA (e.g., "Create your first doctor")
- **Error**: Error message with retry button

### 13.4 Pagination

**Current Limitation:** None of the backend endpoints support pagination (`skip`/`take`). For initial release, use client-side pagination with 20-50 items per page. Consider adding server-side pagination as a future enhancement.

### 13.5 Language Support

The frontend UI itself should be internationalized (i18n) to match the clinic's `supportedLangs`:
- French (FR) — default
- English (EN)
- Arabic (AR) — RTL layout support

Use a library like `react-i18next`.

### 13.6 Multi-Tenancy

- The `clinicId` comes from the JWT
- All data operations are automatically scoped to the clinic
- No manual clinic switcher needed for single-clinic admins
- Future: SUPER_ADMIN may need a clinic switcher dropdown

### 13.7 Responsive Design

- Dashboard must be fully functional on tablet (768px+) and desktop (1024px+)
- Tables should horizontally scroll on smaller screens
- Forms/modals should be full-screen on mobile

### 13.8 Missing Endpoints (Backend Gaps)

For a complete admin experience, the following endpoints are missing:

| Missing Endpoint | Reason |
|-----------------|--------|
| `GET /api/admin/v1/handoff` | List active handoff sessions (Redis query for AWAITING_HANDOFF state) |
| `POST /api/admin/v1/appointments` | Admin-created appointments (currently bot-only) |
| `GET /api/admin/v1/audit-logs` | View audit trail of admin actions |
| Pagination support | All list endpoints need `?page=&limit=` parameters |
| `DELETE /api/admin/v1/appointments/:id` | Delete/cancel appointment from admin |
| Search endpoints | Text search for doctors, FAQs, appointments |

### 13.9 Endpoint Summary by Page

| Page | Endpoints Needed | CRUD |
|------|-----------------|------|
| Login | `POST /auth/login` | — |
| Dashboard | `GET /stats` | R |
| Clinic Settings | `GET /clinics`, `PATCH /clinics` | R, U |
| Doctors | `GET /doctors`, `POST /doctors`, `PATCH /doctors/:id`, `DELETE /doctors/:id` | R, C, U, D |
| Specialties | `GET /specialties`, `POST /specialties`, `PATCH /specialties/:id`, `DELETE /specialties/:id` | R, C, U, D |
| FAQs | `GET /faqs`, `POST /faqs`, `PATCH /faqs/:id`, `DELETE /faqs/:id` | R, C, U, D |
| Time Slots | `GET /doctors/:id/timeslots`, `POST /doctors/:id/timeslots`, `PATCH .../:id`, `DELETE .../:id` | R, C, U, D |
| Bot Messages | `GET /clinic/:clinicId/messages`, `PATCH /clinic/:clinicId/messages/:key/:lang` | R, U |
| Appointments | `GET /appointments`, `PATCH /appointments/:id/status` | R, U |
| Handoff | `POST /handoff/resolve` | U |