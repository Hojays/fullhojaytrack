"""
HojayTrack backend — Flask + SQLite.

Security features:
  - Passwords hashed with werkzeug's PBKDF2 (never stored or returned in plaintext)
  - Session-based auth via a secure, HTTP-only cookie (Flask's signed session,
    backed by a server-side secret key) — no tokens floating around in JS
  - Input validation on every route (type/shape/length checks before touching the DB)
  - CORS locked to the frontend's exact origin, with credentials allowed
  - Parameterized SQL everywhere (no string-built queries)

Run with:
    python app.py
Requires:
    pip install flask flask-cors
"""

from __future__ import annotations

import os
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

from flask import Flask, request, jsonify, session, send_file
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import io
import csv
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = Flask(__name__)

# The session cookie is signed with this key — without it, no one can forge
# a valid session. In production, set HOJAYTRACK_SECRET_KEY as a real env var
# instead of relying on the random fallback (which changes every restart and
# would log everyone out).
app.config["SECRET_KEY"] = os.environ.get("HOJAYTRACK_SECRET_KEY", secrets.token_hex(32))

# Cookie hardening
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,      # JS on the page can't read the cookie
    SESSION_COOKIE_SAMESITE="None",    # allows cross-origin cookie sending (required for ngrok/proxy setups)
    SESSION_COOKIE_SECURE=True,        # required when SameSite=None — only sent over HTTPS
)

# Origins allowed to call the API, with credentials (cookies) enabled.
# Supports multiple comma-separated origins so you can use the app from
# your PC (localhost) and your phone (ngrok/LAN IP) at the same time, e.g.:
#   FRONTEND_ORIGIN=http://localhost:3000,https://abc123.ngrok-free.app
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "http://localhost:3000")
ALLOWED_ORIGINS = [origin.strip() for origin in FRONTEND_ORIGIN.split(",") if origin.strip()]
CORS(app, supports_credentials=True, origins=ALLOWED_ORIGINS, allow_headers=["Content-Type"], methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])

DB_PATH = Path(__file__).resolve().parent / "hojaytrack.db"

def parse_timestamp(value: str) -> datetime:
    """
    Parses a stored ISO timestamp into a timezone-aware UTC datetime.
    Handles both the new format (with a +00:00/Z offset) and any older rows
    that were written before this fix, which were naive UTC strings with no
    offset at all — those get treated as UTC rather than crashing or, worse,
    being silently misinterpreted as local time.
    """
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
VALID_ROLES = {"employee", "manager", "admin"}
VALID_BREAK_TYPES = {"short", "lunch"}

# Unpaid allowance per break type. Minutes within this allowance cost the
# employee nothing; minutes beyond it are deducted from paid time.
BREAK_ALLOWANCE_MINUTES = {"short": 20, "lunch": 30}

# Safety ceiling so a forgotten, never-ended break doesn't silently erase an
# entire shift's pay if a manager looks at it days later. Anything beyond
# this is treated as the cap for deduction purposes (the raw start/end times
# are still stored as-is for transparency).
MAX_BREAK_DEDUCTION_MINUTES = 240


def is_late_arrival(clock_in_dt: datetime, expected_start_time: str) -> bool:
    """
    True if a shift's clock-in happened after the org-wide expected start
    time, compared in the EMPLOYEE'S local time (clock_in_dt.astimezone()
    with no explicit zone converts to whatever zone this process is
    running in — for a flag like this, comparing in local wall-clock time
    is what "arrived late" actually means to a person, not a UTC offset).
    """
    hour_str, minute_str = expected_start_time.split(":")
    expected_hour, expected_minute = int(hour_str), int(minute_str)
    local_dt = clock_in_dt.astimezone()
    return (local_dt.hour, local_dt.minute) > (expected_hour, expected_minute)


def compute_shift_hours(clock_in_dt: datetime, clock_out_dt: datetime, breaks: list[dict], daily_threshold: float) -> dict:
    """
    Given a shift's clock-in/out and its breaks, returns the billable hour
    breakdown. Break minutes beyond each break's unpaid allowance are
    deducted from paid time before regular/overtime is split.
    """
    raw_hours = (clock_out_dt - clock_in_dt).total_seconds() / 3600

    break_minutes_total = 0.0
    unpaid_deduction_minutes = 0.0
    for b in breaks:
        if b["end_time"] is None:
            continue  # still active; ignore for a completed-shift calculation
        start = parse_timestamp(b["start_time"])
        end = parse_timestamp(b["end_time"])
        duration_minutes = max(0.0, (end - start).total_seconds() / 60)
        break_minutes_total += duration_minutes

        allowance = BREAK_ALLOWANCE_MINUTES.get(b["break_type"], 0)
        excess = max(0.0, duration_minutes - allowance)
        excess = min(excess, MAX_BREAK_DEDUCTION_MINUTES)
        unpaid_deduction_minutes += excess

    paid_hours = max(0.0, raw_hours - (unpaid_deduction_minutes / 60))
    regular_hours = round(min(paid_hours, daily_threshold), 2)
    overtime_hours = round(max(0.0, paid_hours - daily_threshold), 2)

    return {
        "rawHours": round(raw_hours, 2),
        "breakMinutes": round(break_minutes_total, 1),
        "unpaidBreakMinutes": round(unpaid_deduction_minutes, 1),
        "regularHours": regular_hours,
        "overtimeHours": overtime_hours,
        "totalHours": round(regular_hours + overtime_hours, 2),
    }


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with get_db_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                email TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                name TEXT NOT NULL,
                role TEXT NOT NULL,
                department TEXT NOT NULL DEFAULT '',
                employee_id TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS admin_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                daily_threshold INTEGER NOT NULL,
                weekly_threshold INTEGER NOT NULL,
                overtime_multiplier REAL NOT NULL,
                double_time_threshold INTEGER NOT NULL,
                double_time_multiplier REAL NOT NULL,
                enable_weekend_overtime INTEGER NOT NULL,
                enable_holiday_overtime INTEGER NOT NULL,
                auto_approve_regular_hours INTEGER NOT NULL,
                require_manager_approval INTEGER NOT NULL,
                max_weekly_hours INTEGER NOT NULL,
                break_deduction_minutes INTEGER NOT NULL,
                expected_start_time TEXT NOT NULL DEFAULT '09:00'
            )
            """
        )
        existing_settings_cols = {row["name"] for row in conn.execute("PRAGMA table_info(admin_settings)")}
        if "expected_start_time" not in existing_settings_cols:
            # The hour a shift is considered "late" if clocked in after —
            # one org-wide cutoff, same for every employee, in 24-hour
            # "HH:MM" format compared against the employee's own local time.
            conn.execute(
                "ALTER TABLE admin_settings ADD COLUMN expected_start_time TEXT NOT NULL DEFAULT '09:00'"
            )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS clock_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                clock_in_time TEXT NOT NULL,
                clock_out_time TEXT,
                status TEXT NOT NULL,
                approval_status TEXT NOT NULL DEFAULT 'pending',
                auto_capped INTEGER NOT NULL DEFAULT 0,
                archived_at TEXT
            )
            """
        )
        # No FOREIGN KEY constraint on email by design: when an employee is
        # removed (DELETE /employees/<id>), their past shift records are
        # deliberately kept rather than deleted, per the "preserve history,
        # orphan the link" behavior this app intentionally provides. A real
        # foreign key would have blocked that deletion outright with an
        # integrity error the moment someone with any shift history was
        # removed — which is exactly what happened before this was caught.
        #
        # Migration for databases created before the foreign key on
        # clock_records.email was removed: SQLite can't drop a constraint
        # with ALTER TABLE, so if one is still present, rebuild the table
        # without it. sql will be None for a table that was never created
        # with a foreign key in the first place, which is the normal case
        # going forward — this block only ever fires once, for old data.
        table_sql_row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='clock_records'"
        ).fetchone()
        if table_sql_row and "FOREIGN KEY" in (table_sql_row["sql"] or ""):
            conn.execute("ALTER TABLE clock_records RENAME TO clock_records_old")
            conn.execute(
                """
                CREATE TABLE clock_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    clock_in_time TEXT NOT NULL,
                    clock_out_time TEXT,
                    status TEXT NOT NULL,
                    approval_status TEXT NOT NULL DEFAULT 'pending',
                    auto_capped INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            old_cols = {row["name"] for row in conn.execute("PRAGMA table_info(clock_records_old)")}
            copy_cols = [c for c in ["id", "email", "clock_in_time", "clock_out_time", "status", "approval_status", "auto_capped"] if c in old_cols]
            conn.execute(f"INSERT INTO clock_records ({', '.join(copy_cols)}) SELECT {', '.join(copy_cols)} FROM clock_records_old")
            conn.execute("DROP TABLE clock_records_old")

        # Migration safety net: if an older DB already has this table without
        # a given column, add it rather than crashing on startup.
        existing_cols = {row["name"] for row in conn.execute("PRAGMA table_info(clock_records)")}
        if "approval_status" not in existing_cols:
            conn.execute(
                "ALTER TABLE clock_records ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending'"
            )
        if "auto_capped" not in existing_cols:
            conn.execute(
                "ALTER TABLE clock_records ADD COLUMN auto_capped INTEGER NOT NULL DEFAULT 0"
            )
        if "archived_at" not in existing_cols:
            # NULL means "visible in the default Hours History view".
            # A timestamp means "manually archived" — the shift still
            # exists and still counts toward reports, it's just hidden
            # from the default (current-week) table view.
            conn.execute(
                "ALTER TABLE clock_records ADD COLUMN archived_at TEXT"
            )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS breaks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                clock_record_id INTEGER NOT NULL,
                break_type TEXT NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                FOREIGN KEY (clock_record_id) REFERENCES clock_records(id)
            )
            """
        )
        conn.commit()
    seed_default_data()


def seed_default_data() -> None:
    with get_db_connection() as conn:
        user_count = conn.execute("SELECT COUNT(*) AS cnt FROM users").fetchone()["cnt"]
        if user_count == 0:
            seed_users = [
                ("admin@company.com", "adminpassword", "Hojay Admin", "admin", "IT", "EMP-0001"),
                ("jane@company.com", "managerpassword", "Jane Smith", "manager", "Operations", "EMP-0089"),
                ("jerry@company.com", "mysecurepassword", "Jerry", "employee", "Engineering", "EMP-1042"),
            ]
            conn.executemany(
                """
                INSERT INTO users (email, password_hash, name, role, department, employee_id)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    (email, generate_password_hash(pw), name, role, dept, emp_id)
                    for email, pw, name, role, dept, emp_id in seed_users
                ],
            )

        settings_count = conn.execute("SELECT COUNT(*) AS cnt FROM admin_settings").fetchone()["cnt"]
        if settings_count == 0:
            conn.execute(
                """
                INSERT INTO admin_settings (
                    id, daily_threshold, weekly_threshold, overtime_multiplier,
                    double_time_threshold, double_time_multiplier,
                    enable_weekend_overtime, enable_holiday_overtime,
                    auto_approve_regular_hours, require_manager_approval,
                    max_weekly_hours, break_deduction_minutes
                ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (8, 40, 1.5, 12, 2.0, 1, 1, 0, 1, 60, 30),
            )
        conn.commit()


def fetch_admin_settings() -> dict:
    with get_db_connection() as conn:
        row = conn.execute("SELECT * FROM admin_settings WHERE id = 1").fetchone()
        if not row:
            seed_default_data()
            row = conn.execute("SELECT * FROM admin_settings WHERE id = 1").fetchone()
    return {
        "dailyThreshold": row["daily_threshold"],
        "weeklyThreshold": row["weekly_threshold"],
        "overtimeMultiplier": row["overtime_multiplier"],
        "doubleTimeThreshold": row["double_time_threshold"],
        "doubleTimeMultiplier": row["double_time_multiplier"],
        "enableWeekendOvertime": bool(row["enable_weekend_overtime"]),
        "enableHolidayOvertime": bool(row["enable_holiday_overtime"]),
        "autoApproveRegularHours": bool(row["auto_approve_regular_hours"]),
        "requireManagerApproval": bool(row["require_manager_approval"]),
        "maxWeeklyHours": row["max_weekly_hours"],
        "breakDeductionMinutes": row["break_deduction_minutes"],
        "expectedStartTime": row["expected_start_time"],
    }


def fetch_breaks_for_record(conn: sqlite3.Connection, clock_record_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT id, break_type, start_time, end_time, status FROM breaks WHERE clock_record_id = ? ORDER BY id",
        (clock_record_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_active_clock_record(conn: sqlite3.Connection, email: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT id, clock_in_time FROM clock_records WHERE email = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
        (email,),
    ).fetchone()


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def validation_error(message: str, field: str | None = None):
    body = {"success": False, "error": message}
    if field:
        body["field"] = field
    return jsonify(body), 400


def is_valid_email(value) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= 254 and bool(EMAIL_RE.match(value))


def is_valid_password(value) -> bool:
    """
    At least 8 characters, with at least one letter and one digit. This
    only applies going forward — at registration, and whenever a password
    is changed — it never re-checks or invalidates passwords already set
    on existing accounts, so nobody gets locked out retroactively by a
    rule that didn't exist when their account was created.
    """
    if not isinstance(value, str) or not (8 <= len(value) <= 128):
        return False
    has_letter = any(c.isalpha() for c in value)
    has_digit = any(c.isdigit() for c in value)
    return has_letter and has_digit


def is_valid_name(value) -> bool:
    return isinstance(value, str) and 1 <= len(value.strip()) <= 100


def enforce_auto_clock_out_guardrail(conn: sqlite3.Connection) -> None:
    """
    Closes out any active shift that has run longer than the admin's
    configured "Max Daily Hours" guardrail. This runs opportunistically (on
    login, clock-status checks, and history fetches) rather than via a
    background scheduler, since plain Flask dev mode has no task runner.
    It's cheap and idempotent, so calling it often is fine.
    """
    settings = fetch_admin_settings()
    max_hours = settings["dailyThreshold"]  # "Max Daily Hours" guardrail ceiling
    now = datetime.now(timezone.utc)

    active_shifts = conn.execute(
        "SELECT id, email, clock_in_time FROM clock_records WHERE status = 'active'"
    ).fetchall()

    for shift in active_shifts:
        clock_in_dt = parse_timestamp(shift["clock_in_time"])
        elapsed_hours = (now - clock_in_dt).total_seconds() / 3600
        if elapsed_hours > max_hours:
            capped_clock_out = clock_in_dt + timedelta(hours=max_hours)
            conn.execute(
                """
                UPDATE clock_records
                SET status = 'completed', clock_out_time = ?, auto_capped = 1
                WHERE id = ?
                """,
                (capped_clock_out.isoformat(), shift["id"]),
            )
            # Also close out any break that got left open on this shift, at
            # the same capped timestamp, so totals don't include a dangling
            # active break.
            conn.execute(
                """
                UPDATE breaks SET end_time = ?, status = 'completed'
                WHERE clock_record_id = ? AND status = 'active'
                """,
                (capped_clock_out.isoformat(), shift["id"]),
            )
    if active_shifts:
        conn.commit()


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "user_email" not in session:
            return jsonify({"success": False, "error": "Not authenticated"}), 401
        return f(*args, **kwargs)
    return wrapper


def role_required(*allowed_roles: str):
    def decorator(f):
        @wraps(f)
        @login_required
        def wrapper(*args, **kwargs):
            if session.get("user_role") not in allowed_roles:
                return jsonify({"success": False, "error": "Insufficient permissions"}), 403
            return f(*args, **kwargs)
        return wrapper
    return decorator


def current_user_row(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT email, name, role, department, employee_id FROM users WHERE email = ?",
        (session.get("user_email"),),
    ).fetchone()


def user_to_dict(row: sqlite3.Row) -> dict:
    return {
        "email": row["email"],
        "name": row["name"],
        "role": row["role"],
        "department": row["department"],
        "employeeId": row["employee_id"],
    }


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------

@app.route("/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    email = data.get("email")
    password = data.get("password")

    if not is_valid_email(email):
        return validation_error("A valid email is required.", "email")
    if not isinstance(password, str) or not password:
        return validation_error("Password is required.", "password")

    email = email.strip().lower()

    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT email, password_hash, name, role, department, employee_id FROM users WHERE email = ?",
            (email,),
        ).fetchone()

    # Same generic message whether the email doesn't exist or the password is
    # wrong — this avoids leaking which emails are registered.
    if not row or not check_password_hash(row["password_hash"], password):
        return jsonify({"success": False, "error": "Invalid email or password."}), 401

    session.clear()
    session["user_email"] = row["email"]
    session["user_role"] = row["role"]
    session.permanent = True

    return jsonify({"success": True, "user": user_to_dict(row)}), 200


@app.route("/register", methods=["POST"])
@role_required("admin")
def register():
    data = request.get_json(silent=True) or {}
    email = data.get("email")
    name = data.get("name")
    password = data.get("password")
    role = data.get("role", "employee")
    department = data.get("department", "")
    employee_id = data.get("employeeId", "")

    if not is_valid_email(email):
        return validation_error("A valid email is required.", "email")
    if not is_valid_name(name):
        return validation_error("Name must be between 1 and 100 characters.", "name")
    if not is_valid_password(password):
        return validation_error("Password must be 8-128 characters and include at least one letter and one number.", "password")
    if not isinstance(role, str) or role.lower() not in VALID_ROLES:
        return validation_error("Role must be employee, manager, or admin.", "role")
    if not isinstance(department, str) or len(department) > 100:
        return validation_error("Department must be 100 characters or fewer.", "department")
    if not isinstance(employee_id, str) or len(employee_id) > 50:
        return validation_error("Employee ID must be 50 characters or fewer.", "employeeId")

    email = email.strip().lower()
    role = role.lower()

    with get_db_connection() as conn:
        existing = conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone()
        if existing:
            return jsonify({"success": False, "error": "An account with that email already exists."}), 409

        conn.execute(
            """
            INSERT INTO users (email, password_hash, name, role, department, employee_id)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (email, generate_password_hash(password), name.strip(), role, department.strip(), employee_id.strip()),
        )
        conn.commit()

    return jsonify({"success": True, "message": "Account created successfully."}), 201


@app.route("/employees", methods=["GET"])
@role_required("manager", "admin")
def list_employees():
    """Every employee account — for the Manage Employees search/filter table."""
    with get_db_connection() as conn:
        rows = conn.execute(
            "SELECT email, name, role, department, employee_id FROM users ORDER BY name"
        ).fetchall()
    return jsonify({"success": True, "employees": [user_to_dict(r) for r in rows]}), 200


@app.route("/employees/<string:identifier>", methods=["DELETE"])
@role_required("admin")
def delete_employee(identifier: str):
    """
    Removes an employee's account. Their historical shift/break records
    are deliberately left in place — orphaned (no longer joinable to a
    live user row) but never deleted, since that history may matter for
    payroll/compliance long after someone has left. The lookup accepts
    either an employee_id (e.g. "EMP-1042") or a raw email, since the
    frontend form historically asked for the employee ID.
    """
    identifier = identifier.strip()

    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT email, name, role FROM users WHERE employee_id = ? OR email = ?",
            (identifier, identifier.lower()),
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "No employee found with that ID."}), 404

        if row["email"] == session.get("user_email"):
            return jsonify({"success": False, "error": "You can't remove your own account while logged in as it."}), 409

        # Guardrail: never let the very last admin account remove itself
        # into a state with zero admins left and no way back in.
        if row["role"] == "admin":
            admin_count = conn.execute("SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin'").fetchone()["cnt"]
            if admin_count <= 1:
                return jsonify({"success": False, "error": "Can't remove the last remaining admin account."}), 409

        conn.execute("DELETE FROM users WHERE email = ?", (row["email"],))
        conn.commit()

    return jsonify({"success": True, "removedName": row["name"]}), 200


@app.route("/users/<string:target_email>", methods=["PUT"])
@role_required("admin")
def update_user(target_email: str):
    """
    Edit an existing employee's name, role, or department. Admin only —
    this can promote/demote anyone, including changing their own role, so
    it's intentionally restricted tighter than viewing the list.
    """
    target_email = target_email.strip().lower()
    data = request.get_json(silent=True) or {}

    with get_db_connection() as conn:
        existing = conn.execute("SELECT email FROM users WHERE email = ?", (target_email,)).fetchone()
        if not existing:
            return jsonify({"success": False, "error": "No employee found with that email."}), 404

        name = data.get("name")
        role = data.get("role")
        department = data.get("department")
        employee_id = data.get("employeeId")

        if name is not None and not is_valid_name(name):
            return validation_error("Name must be between 1 and 100 characters.", "name")
        if role is not None and (not isinstance(role, str) or role.lower() not in VALID_ROLES):
            return validation_error("Role must be employee, manager, or admin.", "role")
        if department is not None and (not isinstance(department, str) or len(department) > 100):
            return validation_error("Department must be 100 characters or fewer.", "department")
        if employee_id is not None and (not isinstance(employee_id, str) or len(employee_id) > 50):
            return validation_error("Employee ID must be 50 characters or fewer.", "employeeId")

        updates = {}
        if name is not None:
            updates["name"] = name.strip()
        if role is not None:
            updates["role"] = role.lower()
        if department is not None:
            updates["department"] = department.strip()
        if employee_id is not None:
            updates["employee_id"] = employee_id.strip()

        if updates:
            set_clause = ", ".join(f"{col} = :{col}" for col in updates)
            conn.execute(
                f"UPDATE users SET {set_clause} WHERE email = :email",
                {**updates, "email": target_email},
            )
            conn.commit()

        row = conn.execute(
            "SELECT email, name, role, department, employee_id FROM users WHERE email = ?",
            (target_email,),
        ).fetchone()

    return jsonify({"success": True, "user": user_to_dict(row)}), 200


@app.route("/users/<string:target_email>/password", methods=["PUT"])
@role_required("admin")
def change_password(target_email: str):
    """
    Changes a password — admin only. This is intentional: employees and
    managers have no self-service way to change their own password at
    all; only an admin can do it, whether it's their own account or
    someone else's. Either way, the rule is the same: you must supply
    that account's CURRENT password to set a new one. There's no
    backdoor reset that skips this — the admin needs the employee to
    tell them their current password directly (in person, out loud,
    however) rather than the system handing one out.
    """
    target_email = target_email.strip().lower()
    data = request.get_json(silent=True) or {}
    current_password = data.get("currentPassword")
    new_password = data.get("newPassword")

    if not isinstance(current_password, str) or not current_password:
        return validation_error("Current password is required.", "currentPassword")
    if not is_valid_password(new_password):
        return validation_error("New password must be 8-128 characters and include at least one letter and one number.", "newPassword")

    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT email, password_hash FROM users WHERE email = ?",
            (target_email,),
        ).fetchone()
        if not row:
            return jsonify({"success": False, "error": "No account found with that email."}), 404

        if not check_password_hash(row["password_hash"], current_password):
            return jsonify({"success": False, "error": "Current password is incorrect."}), 401

        conn.execute(
            "UPDATE users SET password_hash = ? WHERE email = ?",
            (generate_password_hash(new_password), target_email),
        )
        conn.commit()

    return jsonify({"success": True}), 200


@app.route("/users/<string:target_email>/history", methods=["GET"])
@role_required("manager", "admin")
def employee_history(target_email: str):
    """
    One specific employee's full completed-shift log — the manager/admin
    equivalent of /clock-history, which is always scoped to "me". Supports
    the same ?week= filtering as /clock-history so the same week-navigator
    UI pattern can be reused here.
    """
    target_email = target_email.strip().lower()
    settings = fetch_admin_settings()
    daily_threshold = settings["dailyThreshold"]

    with get_db_connection() as conn:
        user_row = conn.execute(
            "SELECT email, name, role, department, employee_id FROM users WHERE email = ?",
            (target_email,),
        ).fetchone()
        if not user_row:
            return jsonify({"success": False, "error": "No employee found with that email."}), 404

        week_param = request.args.get("week")
        if week_param:
            try:
                reference_date = datetime.fromisoformat(week_param)
                if reference_date.tzinfo is None:
                    reference_date = reference_date.replace(tzinfo=timezone.utc)
            except ValueError:
                return validation_error("week must be an ISO date like 2026-06-23.", "week")
            week_start, week_end = get_week_bounds(reference_date)
        else:
            week_start, week_end = None, None

        rows = conn.execute(
            """
            SELECT id, clock_in_time, clock_out_time, auto_capped
            FROM clock_records
            WHERE email = ? AND status = 'completed' AND clock_out_time IS NOT NULL
            ORDER BY id DESC
            """,
            (target_email,),
        ).fetchall()

        history = []
        for row in rows:
            clock_in_dt = parse_timestamp(row["clock_in_time"])
            if week_start and not (week_start <= clock_in_dt < week_end):
                continue
            clock_out_dt = parse_timestamp(row["clock_out_time"])
            breaks = fetch_breaks_for_record(conn, row["id"])
            hours = compute_shift_hours(clock_in_dt, clock_out_dt, breaks, daily_threshold)
            history.append({
                "id": row["id"],
                "clockIn": clock_in_dt.isoformat(),
                "clockOut": clock_out_dt.isoformat(),
                "regularHours": hours["regularHours"],
                "overtimeHours": hours["overtimeHours"],
                "totalHours": hours["totalHours"],
                "autoCapped": bool(row["auto_capped"]),
                "isLate": is_late_arrival(clock_in_dt, settings["expectedStartTime"]),
            })

    return jsonify({
        "success": True,
        "employee": user_to_dict(user_row),
        "history": history,
    }), 200


@app.route("/dashboard-summary", methods=["GET"])
@role_required("manager", "admin")
def dashboard_summary():
    """Total employees, who's currently clocked in, total hours this week — for the Manage Employees overview cards."""
    settings = fetch_admin_settings()
    daily_threshold = settings["dailyThreshold"]
    week_start, week_end = get_week_bounds(datetime.now(timezone.utc))

    with get_db_connection() as conn:
        enforce_auto_clock_out_guardrail(conn)

        total_employees = conn.execute("SELECT COUNT(*) AS cnt FROM users").fetchone()["cnt"]

        active_rows = conn.execute(
            "SELECT cr.email, u.name FROM clock_records cr JOIN users u ON u.email = cr.email WHERE cr.status = 'active'"
        ).fetchall()

        completed_rows = conn.execute(
            "SELECT id, email, clock_in_time, clock_out_time FROM clock_records WHERE status = 'completed' AND clock_out_time IS NOT NULL"
        ).fetchall()

        total_hours_this_week = 0.0
        for row in completed_rows:
            clock_in_dt = parse_timestamp(row["clock_in_time"])
            if not (week_start <= clock_in_dt < week_end):
                continue
            clock_out_dt = parse_timestamp(row["clock_out_time"])
            breaks = fetch_breaks_for_record(conn, row["id"])
            hours = compute_shift_hours(clock_in_dt, clock_out_dt, breaks, daily_threshold)
            total_hours_this_week += hours["totalHours"]

    return jsonify({
        "success": True,
        "totalEmployees": total_employees,
        "currentlyClockedIn": [{"email": r["email"], "name": r["name"]} for r in active_rows],
        "currentlyClockedInCount": len(active_rows),
        "totalHoursThisWeek": round(total_hours_this_week, 2),
    }), 200


@app.route("/export/backup", methods=["GET"])
@role_required("admin")
def export_backup():
    """
    A spreadsheet-friendly CSV of every shift across every employee within
    a chosen date range — meant as a manual backup/export, since the live
    database has no automatic backup of its own. Query params:
      from — ISO date (YYYY-MM-DD), inclusive. Required.
      to   — ISO date (YYYY-MM-DD), inclusive. Required.
    """
    from_param = request.args.get("from")
    to_param = request.args.get("to")
    if not from_param or not to_param:
        return validation_error("Both 'from' and 'to' dates are required, e.g. ?from=2026-01-01&to=2026-12-31.", "from")

    try:
        range_start = datetime.fromisoformat(from_param).replace(tzinfo=timezone.utc)
        range_end = (datetime.fromisoformat(to_param) + timedelta(days=1)).replace(tzinfo=timezone.utc)
    except ValueError:
        return validation_error("Dates must be in YYYY-MM-DD format.", "from")

    if range_end <= range_start:
        return validation_error("'to' must be on or after 'from'.", "to")

    settings = fetch_admin_settings()
    daily_threshold = settings["dailyThreshold"]

    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT cr.id, cr.email, cr.clock_in_time, cr.clock_out_time, cr.status,
                   cr.approval_status, cr.auto_capped,
                   u.name, u.department, u.employee_id
            FROM clock_records cr
            LEFT JOIN users u ON u.email = cr.email
            ORDER BY cr.clock_in_time
            """
        ).fetchall()

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            "Employee Name", "Employee ID", "Department", "Email",
            "Date", "Clock In", "Clock Out", "Status",
            "Regular Hours", "Overtime Hours", "Total Hours", "Break Minutes",
            "Auto-Capped", "Approval Status",
        ])

        for row in rows:
            clock_in_dt = parse_timestamp(row["clock_in_time"])
            if not (range_start <= clock_in_dt < range_end):
                continue

            if row["clock_out_time"]:
                clock_out_dt = parse_timestamp(row["clock_out_time"])
                breaks = fetch_breaks_for_record(conn, row["id"])
                hours = compute_shift_hours(clock_in_dt, clock_out_dt, breaks, daily_threshold)
                clock_out_display = clock_out_dt.isoformat()
                reg, ot, tot, brk = hours["regularHours"], hours["overtimeHours"], hours["totalHours"], hours["breakMinutes"]
            else:
                clock_out_display, reg, ot, tot, brk = "", "", "", "", ""

            writer.writerow([
                row["name"] or "(removed employee)",
                row["employee_id"] or "",
                row["department"] or "",
                row["email"],
                clock_in_dt.strftime("%Y-%m-%d"),
                clock_in_dt.isoformat(),
                clock_out_display,
                row["status"],
                reg, ot, tot, brk,
                "yes" if row["auto_capped"] else "no",
                row["approval_status"],
            ])

    csv_bytes = io.BytesIO(output.getvalue().encode("utf-8-sig"))  # BOM so Excel opens it correctly
    filename = f"hojaytrack-backup-{from_param}-to-{to_param}.csv"
    return send_file(csv_bytes, mimetype="text/csv", as_attachment=True, download_name=filename)


@app.route("/export/employees", methods=["GET"])
@role_required("admin")
def export_employees():
    """A spreadsheet-friendly CSV of the current employee directory — the Manage Employees table, exported."""
    with get_db_connection() as conn:
        rows = conn.execute(
            "SELECT name, employee_id, email, role, department FROM users ORDER BY name"
        ).fetchall()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Name", "Employee ID", "Email", "Role", "Department"])
    for row in rows:
        writer.writerow([row["name"], row["employee_id"] or "", row["email"], row["role"], row["department"] or ""])

    csv_bytes = io.BytesIO(output.getvalue().encode("utf-8-sig"))
    filename = f"hojaytrack-employees-{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.csv"
    return send_file(csv_bytes, mimetype="text/csv", as_attachment=True, download_name=filename)


@app.route("/logout", methods=["POST"])
@login_required
def logout():
    session.clear()
    return jsonify({"success": True}), 200


@app.route("/me", methods=["GET"])
@login_required
def me():
    with get_db_connection() as conn:
        row = current_user_row(conn)
    if not row:
        session.clear()
        return jsonify({"success": False, "error": "User no longer exists."}), 401
    return jsonify({"success": True, "user": user_to_dict(row)}), 200


# ---------------------------------------------------------------------------
# Clock in / out routes — all scoped to the logged-in user via the session,
# never to an email passed in by the client. This stops user A from clocking
# user B in or out by guessing their email.
# ---------------------------------------------------------------------------

@app.route("/clock-in", methods=["POST"])
@login_required
def clock_in():
    email = session["user_email"]
    now = datetime.now(timezone.utc).isoformat()

    with get_db_connection() as conn:
        enforce_auto_clock_out_guardrail(conn)

        active = get_active_clock_record(conn, email)
        if active:
            return jsonify({"success": False, "error": "You're already clocked in."}), 409

        conn.execute(
            "INSERT INTO clock_records (email, clock_in_time, status) VALUES (?, ?, 'active')",
            (email, now),
        )
        conn.commit()

    return jsonify({"success": True, "clockInTime": now}), 201


@app.route("/clock-out", methods=["POST"])
@login_required
def clock_out():
    email = session["user_email"]
    now = datetime.now(timezone.utc).isoformat()

    with get_db_connection() as conn:
        enforce_auto_clock_out_guardrail(conn)

        active = get_active_clock_record(conn, email)
        if not active:
            return jsonify({"success": False, "error": "No active clock-in found. Your shift may have already been auto-ended by the daily hours guardrail."}), 404

        # Close out any break the employee forgot to end before clocking out.
        conn.execute(
            "UPDATE breaks SET end_time = ?, status = 'completed' WHERE clock_record_id = ? AND status = 'active'",
            (now, active["id"]),
        )

        conn.execute(
            "UPDATE clock_records SET clock_out_time = ?, status = 'completed' WHERE id = ?",
            (now, active["id"]),
        )
        conn.commit()

    return jsonify({"success": True, "clockOutTime": now}), 200


@app.route("/clock-status", methods=["GET"])
@login_required
def clock_status():
    email = session["user_email"]
    with get_db_connection() as conn:
        enforce_auto_clock_out_guardrail(conn)

        active = get_active_clock_record(conn, email)
        if not active:
            return jsonify({"success": True, "active": False}), 200

        active_break_row = conn.execute(
            "SELECT id, break_type, start_time FROM breaks WHERE clock_record_id = ? AND status = 'active'",
            (active["id"],),
        ).fetchone()
        active_break = (
            {"id": active_break_row["id"], "type": active_break_row["break_type"], "startTime": active_break_row["start_time"]}
            if active_break_row else None
        )

    return jsonify({
        "success": True,
        "active": True,
        "clockInTime": active["clock_in_time"],
        "activeBreak": active_break,
    }), 200


@app.route("/start-break", methods=["POST"])
@login_required
def start_break():
    email = session["user_email"]
    data = request.get_json(silent=True) or {}
    break_type = data.get("type")

    if break_type not in VALID_BREAK_TYPES:
        return validation_error("type must be 'short' or 'lunch'.", "type")

    now = datetime.now(timezone.utc).isoformat()

    with get_db_connection() as conn:
        enforce_auto_clock_out_guardrail(conn)

        active = get_active_clock_record(conn, email)
        if not active:
            return jsonify({"success": False, "error": "You must be clocked in to start a break."}), 409

        existing_break = conn.execute(
            "SELECT id FROM breaks WHERE clock_record_id = ? AND status = 'active'",
            (active["id"],),
        ).fetchone()
        if existing_break:
            return jsonify({"success": False, "error": "A break is already in progress."}), 409

        conn.execute(
            "INSERT INTO breaks (clock_record_id, break_type, start_time, status) VALUES (?, ?, ?, 'active')",
            (active["id"], break_type, now),
        )
        conn.commit()

    return jsonify({"success": True, "type": break_type, "startTime": now}), 201


@app.route("/end-break", methods=["POST"])
@login_required
def end_break():
    email = session["user_email"]
    now = datetime.now(timezone.utc).isoformat()

    with get_db_connection() as conn:
        active = get_active_clock_record(conn, email)
        if not active:
            return jsonify({"success": False, "error": "You are not currently clocked in."}), 409

        active_break = conn.execute(
            "SELECT id, break_type, start_time FROM breaks WHERE clock_record_id = ? AND status = 'active'",
            (active["id"],),
        ).fetchone()
        if not active_break:
            return jsonify({"success": False, "error": "No break is currently in progress."}), 404

        conn.execute(
            "UPDATE breaks SET end_time = ?, status = 'completed' WHERE id = ?",
            (now, active_break["id"]),
        )
        conn.commit()

        start = parse_timestamp(active_break["start_time"])
        end = parse_timestamp(now)
        duration_minutes = round((end - start).total_seconds() / 60, 1)
        allowance = BREAK_ALLOWANCE_MINUTES.get(active_break["break_type"], 0)
        unpaid_minutes = min(max(0.0, duration_minutes - allowance), MAX_BREAK_DEDUCTION_MINUTES)

    return jsonify({
        "success": True,
        "type": active_break["break_type"],
        "startTime": active_break["start_time"],
        "endTime": now,
        "durationMinutes": duration_minutes,
        "unpaidMinutes": unpaid_minutes,
    }), 200


@app.route("/breaks/today", methods=["GET"])
@login_required
def breaks_today():
    """
    Every completed break the logged-in user has taken today, across all
    of today's shifts. This exists because the frontend's break-history
    list previously lived only in React state — it looked fine while you
    stayed on the page, but vanished completely on sign-out, on logging
    back in, or even just navigating away and back, even though every
    break was (and always had been) safely saved in the database. This
    route is what lets the dashboard show that real, persisted history
    again instead of relying on memory that resets on every page load.
    "Today" is the employee's own local calendar day, not server-side UTC
    — comparing in UTC would show yesterday's breaks as "today's" (or vice
    versa) for anyone not in the same timezone as the server.
    """
    email = session["user_email"]
    now_local = datetime.now(timezone.utc).astimezone()
    today_start_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)

    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT b.id, b.break_type, b.start_time, b.end_time
            FROM breaks b
            JOIN clock_records cr ON cr.id = b.clock_record_id
            WHERE cr.email = ? AND b.status = 'completed' AND b.end_time IS NOT NULL
            ORDER BY b.start_time
            """,
            (email,),
        ).fetchall()

    today_breaks = []
    for row in rows:
        start_dt = parse_timestamp(row["start_time"])
        if start_dt.astimezone() < today_start_local:
            continue
        end_dt = parse_timestamp(row["end_time"])
        duration_minutes = round((end_dt - start_dt).total_seconds() / 60, 1)
        today_breaks.append({
            "id": row["id"],
            "type": row["break_type"],
            "startTime": row["start_time"],
            "endTime": row["end_time"],
            "durationMinutes": duration_minutes,
        })

    return jsonify({"success": True, "breaks": today_breaks}), 200


def get_week_bounds(reference_date: datetime) -> tuple[datetime, datetime]:
    """
    Given any datetime, returns (week_start, week_end) as UTC datetimes
    spanning Monday 00:00 through the following Monday 00:00 (exclusive).
    Used everywhere "current week" or "a specific week" needs computing,
    so every route agrees on what a "week" means.
    """
    start = (reference_date - timedelta(days=reference_date.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    end = start + timedelta(days=7)
    return start, end


@app.route("/clock-history", methods=["GET"])
@login_required
def clock_history():
    """
    Returns completed shifts for the logged-in user for a given week, most
    recent first, with regular/overtime hours computed using the
    admin-configured daily threshold and break deductions applied. Active
    (still clocked-in) shifts are excluded — they show up via
    /clock-status instead, since they don't have a total yet.

    Query params:
      week — any date (YYYY-MM-DD) inside the desired week. Defaults to
             today, i.e. the current week.
      include_archived — "true" to include manually archived shifts.
             Defaults to excluding them, since the whole point of
             archiving is to keep old weeks out of the default view.
    """
    email = session["user_email"]
    settings = fetch_admin_settings()
    daily_threshold = settings["dailyThreshold"]

    week_param = request.args.get("week")
    try:
        reference_date = datetime.fromisoformat(week_param) if week_param else datetime.now(timezone.utc)
        if reference_date.tzinfo is None:
            reference_date = reference_date.replace(tzinfo=timezone.utc)
    except ValueError:
        return validation_error("week must be an ISO date like 2026-06-23.", "week")

    week_start, week_end = get_week_bounds(reference_date)
    include_archived = request.args.get("include_archived", "false").lower() == "true"

    with get_db_connection() as conn:
        enforce_auto_clock_out_guardrail(conn)

        rows = conn.execute(
            """
            SELECT id, clock_in_time, clock_out_time, auto_capped, archived_at
            FROM clock_records
            WHERE email = ? AND status = 'completed' AND clock_out_time IS NOT NULL
            ORDER BY id DESC
            """,
            (email,),
        ).fetchall()

        history = []
        for row in rows:
            clock_in_dt = parse_timestamp(row["clock_in_time"])
            if not (week_start <= clock_in_dt < week_end):
                continue
            if row["archived_at"] and not include_archived:
                continue

            clock_out_dt = parse_timestamp(row["clock_out_time"])
            breaks = fetch_breaks_for_record(conn, row["id"])
            hours = compute_shift_hours(clock_in_dt, clock_out_dt, breaks, daily_threshold)

            history.append({
                "id": row["id"],
                "date": clock_in_dt.strftime("%Y-%m-%d"),
                "clockIn": clock_in_dt.isoformat(),
                "clockOut": clock_out_dt.isoformat(),
                "regularHours": hours["regularHours"],
                "overtimeHours": hours["overtimeHours"],
                "totalHours": hours["totalHours"],
                "breakMinutes": hours["breakMinutes"],
                "unpaidBreakMinutes": hours["unpaidBreakMinutes"],
                "autoCapped": bool(row["auto_capped"]),
                "archived": bool(row["archived_at"]),
            })

    return jsonify({
        "success": True,
        "history": history,
        "weekStart": week_start.strftime("%Y-%m-%d"),
        "weekEnd": (week_end - timedelta(days=1)).strftime("%Y-%m-%d"),
    }), 200


@app.route("/clock-history/archive", methods=["POST"])
@login_required
def archive_week():
    """
    Marks every one of the logged-in user's completed shifts in a given
    week as archived — hidden from the default Hours History view, but
    never deleted. Reports and the week navigator can still reach them via
    include_archived=true or by selecting that week directly.
    """
    email = session["user_email"]
    data = request.get_json(silent=True) or {}
    week_param = data.get("week")

    try:
        reference_date = datetime.fromisoformat(week_param) if week_param else datetime.now(timezone.utc)
        if reference_date.tzinfo is None:
            reference_date = reference_date.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return validation_error("week must be an ISO date like 2026-06-23.", "week")

    week_start, week_end = get_week_bounds(reference_date)
    now = datetime.now(timezone.utc).isoformat()

    with get_db_connection() as conn:
        rows = conn.execute(
            "SELECT id, clock_in_time FROM clock_records WHERE email = ? AND status = 'completed' AND archived_at IS NULL",
            (email,),
        ).fetchall()
        ids_to_archive = [
            row["id"] for row in rows
            if week_start <= parse_timestamp(row["clock_in_time"]) < week_end
        ]
        if ids_to_archive:
            conn.executemany(
                "UPDATE clock_records SET archived_at = ? WHERE id = ?",
                [(now, rid) for rid in ids_to_archive],
            )
            conn.commit()

    return jsonify({"success": True, "archivedCount": len(ids_to_archive)}), 200


# ---------------------------------------------------------------------------
# Weekly reports — on-screen JSON view and PDF export. Both pull from the
# same underlying data and the same week-bounds logic as /clock-history, so
# what you see on screen always matches what downloads as a PDF.
# ---------------------------------------------------------------------------

def parse_week_param() -> tuple[datetime, datetime] | tuple[None, None]:
    week_param = request.args.get("week")
    try:
        reference_date = datetime.fromisoformat(week_param) if week_param else datetime.now(timezone.utc)
        if reference_date.tzinfo is None:
            reference_date = reference_date.replace(tzinfo=timezone.utc)
    except ValueError:
        return None, None
    return get_week_bounds(reference_date)


def build_employee_week_rows(conn: sqlite3.Connection, email: str, week_start: datetime, week_end: datetime, daily_threshold: float) -> list[dict]:
    """One row per completed shift for a single employee within the week."""
    rows = conn.execute(
        """
        SELECT id, clock_in_time, clock_out_time, auto_capped, approval_status
        FROM clock_records
        WHERE email = ? AND status = 'completed' AND clock_out_time IS NOT NULL
        ORDER BY clock_in_time
        """,
        (email,),
    ).fetchall()

    result = []
    for row in rows:
        clock_in_dt = parse_timestamp(row["clock_in_time"])
        if not (week_start <= clock_in_dt < week_end):
            continue
        clock_out_dt = parse_timestamp(row["clock_out_time"])
        breaks = fetch_breaks_for_record(conn, row["id"])
        hours = compute_shift_hours(clock_in_dt, clock_out_dt, breaks, daily_threshold)
        result.append({
            "date": clock_in_dt.strftime("%Y-%m-%d"),
            "clockIn": clock_in_dt.isoformat(),
            "clockOut": clock_out_dt.isoformat(),
            "regularHours": hours["regularHours"],
            "overtimeHours": hours["overtimeHours"],
            "totalHours": hours["totalHours"],
            "breakMinutes": hours["breakMinutes"],
            "autoCapped": bool(row["auto_capped"]),
            "approvalStatus": row["approval_status"],
        })
    return result


@app.route("/reports/weekly", methods=["GET"])
@login_required
def weekly_report():
    """
    The logged-in employee's own report for a given week — same data shape
    whether viewed on screen or exported as a PDF (see /reports/weekly/pdf).
    """
    week_start, week_end = parse_week_param()
    if week_start is None:
        return validation_error("week must be an ISO date like 2026-06-23.", "week")

    email = session["user_email"]
    settings = fetch_admin_settings()

    with get_db_connection() as conn:
        user_row = conn.execute("SELECT name, department, employee_id FROM users WHERE email = ?", (email,)).fetchone()
        shifts = build_employee_week_rows(conn, email, week_start, week_end, settings["dailyThreshold"])

    totals = {
        "regularHours": round(sum(s["regularHours"] for s in shifts), 2),
        "overtimeHours": round(sum(s["overtimeHours"] for s in shifts), 2),
        "totalHours": round(sum(s["totalHours"] for s in shifts), 2),
    }

    return jsonify({
        "success": True,
        "weekStart": week_start.strftime("%Y-%m-%d"),
        "weekEnd": (week_end - timedelta(days=1)).strftime("%Y-%m-%d"),
        "employee": {"name": user_row["name"], "department": user_row["department"], "employeeId": user_row["employee_id"]},
        "shifts": shifts,
        "totals": totals,
    }), 200


@app.route("/reports/weekly/team", methods=["GET"])
@role_required("manager", "admin")
def weekly_report_team():
    """Every employee's report for a given week, for managers/admins."""
    week_start, week_end = parse_week_param()
    if week_start is None:
        return validation_error("week must be an ISO date like 2026-06-23.", "week")

    settings = fetch_admin_settings()

    with get_db_connection() as conn:
        users = conn.execute("SELECT email, name, department, employee_id FROM users ORDER BY name").fetchall()
        employees = []
        for u in users:
            shifts = build_employee_week_rows(conn, u["email"], week_start, week_end, settings["dailyThreshold"])
            if not shifts:
                continue  # skip employees with nothing logged that week
            totals = {
                "regularHours": round(sum(s["regularHours"] for s in shifts), 2),
                "overtimeHours": round(sum(s["overtimeHours"] for s in shifts), 2),
                "totalHours": round(sum(s["totalHours"] for s in shifts), 2),
            }
            employees.append({
                "employee": {"name": u["name"], "department": u["department"], "employeeId": u["employee_id"]},
                "shifts": shifts,
                "totals": totals,
            })

    return jsonify({
        "success": True,
        "weekStart": week_start.strftime("%Y-%m-%d"),
        "weekEnd": (week_end - timedelta(days=1)).strftime("%Y-%m-%d"),
        "employees": employees,
    }), 200


def _render_pdf(title: str, subtitle: str, sections: list[dict], header_row: list[str] | None = None, col_widths: list[float] | None = None) -> io.BytesIO:
    """
    sections: list of {"heading": str, "rows": [[...], ...], "totals": [reg, ot, total]}
    header_row / col_widths let callers with a different column layout
    (e.g. an extra "Employee" column for a mixed-employee report) reuse
    this without being locked into the original 6-column "Date, Clock In,
    Clock Out, Regular, Overtime, Total" shape used by the weekly reports.
    The last 3 columns of any layout passed in must always be
    Regular/Overtime/Total, since the totals row below assumes that.
    """
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=letter, topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("TitleStyle", parent=styles["Heading1"], fontSize=18, spaceAfter=4)
    subtitle_style = ParagraphStyle("SubtitleStyle", parent=styles["Normal"], fontSize=11, textColor=colors.grey, spaceAfter=18)
    heading_style = ParagraphStyle("SectionHeading", parent=styles["Heading2"], fontSize=13, spaceBefore=16, spaceAfter=6)

    elements = [Paragraph(title, title_style), Paragraph(subtitle, subtitle_style)]

    header_row = header_row or ["Date", "Clock In", "Clock Out", "Regular", "Overtime", "Total"]
    num_cols = len(header_row)
    col_widths = col_widths or [5.4 * inch / num_cols] * num_cols

    for section in sections:
        elements.append(Paragraph(section["heading"], heading_style))
        table_data = [header_row] + section["rows"]
        totals_row = [""] * (num_cols - 3) + [f'{section["totals"][0]}h', f'{section["totals"][1]}h', f'{section["totals"][2]}h']
        totals_row[num_cols - 4] = "Total" if num_cols >= 4 else totals_row[num_cols - 4]
        table_data.append(totals_row)
        t = Table(table_data, colWidths=col_widths)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("GRID", (0, 0), (-1, -2), 0.5, colors.HexColor("#d1d5db")),
            ("LINEABOVE", (0, -1), (-1, -1), 1, colors.HexColor("#1f2937")),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("ALIGN", (3, 0), (-1, -1), "RIGHT"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -2), [colors.white, colors.HexColor("#f9fafb")]),
        ]))
        elements.append(t)

    doc.build(elements)
    buffer.seek(0)
    return buffer


@app.route("/reports/weekly/pdf", methods=["GET"])
@login_required
def weekly_report_pdf():
    """PDF export of the logged-in employee's own week — same data as /reports/weekly."""
    week_start, week_end = parse_week_param()
    if week_start is None:
        return validation_error("week must be an ISO date like 2026-06-23.", "week")

    email = session["user_email"]
    settings = fetch_admin_settings()

    with get_db_connection() as conn:
        user_row = conn.execute("SELECT name, department, employee_id FROM users WHERE email = ?", (email,)).fetchone()
        shifts = build_employee_week_rows(conn, email, week_start, week_end, settings["dailyThreshold"])

    rows = [[
        s["date"],
        datetime.fromisoformat(s["clockIn"]).astimezone().strftime("%I:%M %p"),
        datetime.fromisoformat(s["clockOut"]).astimezone().strftime("%I:%M %p"),
        f'{s["regularHours"]}h', f'{s["overtimeHours"]}h', f'{s["totalHours"]}h',
    ] for s in shifts]
    totals = [
        round(sum(s["regularHours"] for s in shifts), 2),
        round(sum(s["overtimeHours"] for s in shifts), 2),
        round(sum(s["totalHours"] for s in shifts), 2),
    ]

    period = f'{week_start.strftime("%b %d")} – {(week_end - timedelta(days=1)).strftime("%b %d, %Y")}'
    buffer = _render_pdf(
        "Weekly Hours Report",
        f'{user_row["name"]} · {user_row["department"] or "—"} · {period}',
        [{"heading": user_row["name"], "rows": rows, "totals": totals}],
    )
    filename = f'hojaytrack-report-{week_start.strftime("%Y-%m-%d")}.pdf'
    return send_file(buffer, mimetype="application/pdf", as_attachment=True, download_name=filename)


@app.route("/reports/weekly/team/pdf", methods=["GET"])
@role_required("manager", "admin")
def weekly_report_team_pdf():
    """PDF export covering every employee's week — same data as /reports/weekly/team."""
    week_start, week_end = parse_week_param()
    if week_start is None:
        return validation_error("week must be an ISO date like 2026-06-23.", "week")

    settings = fetch_admin_settings()

    with get_db_connection() as conn:
        users = conn.execute("SELECT email, name, department FROM users ORDER BY name").fetchall()
        sections = []
        for u in users:
            shifts = build_employee_week_rows(conn, u["email"], week_start, week_end, settings["dailyThreshold"])
            if not shifts:
                continue
            rows = [[
                s["date"],
                datetime.fromisoformat(s["clockIn"]).astimezone().strftime("%I:%M %p"),
                datetime.fromisoformat(s["clockOut"]).astimezone().strftime("%I:%M %p"),
                f'{s["regularHours"]}h', f'{s["overtimeHours"]}h', f'{s["totalHours"]}h',
            ] for s in shifts]
            totals = [
                round(sum(s["regularHours"] for s in shifts), 2),
                round(sum(s["overtimeHours"] for s in shifts), 2),
                round(sum(s["totalHours"] for s in shifts), 2),
            ]
            sections.append({"heading": f'{u["name"]} — {u["department"] or "—"}', "rows": rows, "totals": totals})

    period = f'{week_start.strftime("%b %d")} – {(week_end - timedelta(days=1)).strftime("%b %d, %Y")}'
    buffer = _render_pdf("Team Weekly Hours Report", period, sections)
    filename = f'hojaytrack-team-report-{week_start.strftime("%Y-%m-%d")}.pdf'
    return send_file(buffer, mimetype="application/pdf", as_attachment=True, download_name=filename)


@app.route("/weekly-summary", methods=["GET"])
@login_required
def weekly_summary():
    """
    Live numbers for the "Weekly Target / Logged This Week / Remaining"
    stats shown on the clock-in screen. "This week" is Monday 00:00 through
    now, in UTC. Only completed shifts count toward "logged" — an
    in-progress shift isn't finished, so it isn't counted here (it shows up
    live via /clock-status instead).
    """
    email = session["user_email"]
    settings = fetch_admin_settings()
    daily_threshold = settings["dailyThreshold"]
    weekly_target = settings["weeklyThreshold"]  # defaults to 40 in admin_settings

    now = datetime.now(timezone.utc)
    week_start = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)

    with get_db_connection() as conn:
        enforce_auto_clock_out_guardrail(conn)

        rows = conn.execute(
            """
            SELECT id, clock_in_time, clock_out_time
            FROM clock_records
            WHERE email = ? AND status = 'completed' AND clock_out_time IS NOT NULL
            """,
            (email,),
        ).fetchall()

        logged_hours = 0.0
        for row in rows:
            clock_in_dt = parse_timestamp(row["clock_in_time"])
            if clock_in_dt < week_start:
                continue
            clock_out_dt = parse_timestamp(row["clock_out_time"])
            breaks = fetch_breaks_for_record(conn, row["id"])
            hours = compute_shift_hours(clock_in_dt, clock_out_dt, breaks, daily_threshold)
            logged_hours += hours["totalHours"]

    logged_hours = round(logged_hours, 2)
    remaining_hours = round(max(0.0, weekly_target - logged_hours), 1)

    return jsonify({
        "success": True,
        "weeklyTarget": weekly_target,
        "loggedThisWeek": logged_hours,
        "remaining": remaining_hours,
    }), 200


# ---------------------------------------------------------------------------
# Manager / admin: cross-employee timesheet review.
# Every completed shift, from every employee, surfaces here so a manager can
# approve or reject it. This is the aggregation the employee's own
# /clock-history route deliberately doesn't do (that one is scoped to "me").
# ---------------------------------------------------------------------------

@app.route("/admin/timecards", methods=["GET"])
@role_required("manager", "admin")
def admin_timecards():
    """
    Every clock record across every employee — both completed shifts and
    shifts still in progress right now — with computed hours and break
    deductions, plus whether the auto-clock-out guardrail capped it.
    """
    settings = fetch_admin_settings()
    daily_threshold = settings["dailyThreshold"]

    with get_db_connection() as conn:
        enforce_auto_clock_out_guardrail(conn)

        rows = conn.execute(
            """
            SELECT
                cr.id, cr.email, cr.clock_in_time, cr.clock_out_time, cr.status,
                cr.approval_status, cr.auto_capped,
                u.name, u.department, u.employee_id
            FROM clock_records cr
            JOIN users u ON u.email = cr.email
            ORDER BY cr.id DESC
            """
        ).fetchall()

        timecards = []
        now = datetime.now(timezone.utc)
        for row in rows:
            clock_in_dt = parse_timestamp(row["clock_in_time"])
            breaks = fetch_breaks_for_record(conn, row["id"])
            is_active = row["status"] == "active"

            if is_active:
                # Shift still running — show a live, provisional total using
                # "now" as a stand-in clock-out, but don't count it as final.
                clock_out_dt = now
                clock_out_display = None
            else:
                clock_out_dt = parse_timestamp(row["clock_out_time"])
                clock_out_display = clock_out_dt.isoformat()

            hours = compute_shift_hours(clock_in_dt, clock_out_dt, breaks, daily_threshold)
            active_break = next((b for b in breaks if b["status"] == "active"), None)

            timecards.append({
                "id": row["id"],
                "employeeId": row["employee_id"] or row["email"],
                "employeeName": row["name"],
                "department": row["department"] or "—",
                "date": clock_in_dt.strftime("%Y-%m-%d"),
                "clockIn": clock_in_dt.isoformat(),
                "clockOut": clock_out_display,
                "isActive": is_active,
                "onBreak": active_break is not None,
                "regularHours": hours["regularHours"],
                "overtimeHours": hours["overtimeHours"],
                "totalHours": hours["totalHours"],
                "breakMinutes": hours["breakMinutes"],
                "unpaidBreakMinutes": hours["unpaidBreakMinutes"],
                "autoCapped": bool(row["auto_capped"]),
                "approvalStatus": row["approval_status"],
                "isLate": is_late_arrival(clock_in_dt, settings["expectedStartTime"]),
            })

    return jsonify({"success": True, "timecards": timecards}), 200


@app.route("/clock-records/<int:record_id>", methods=["PUT"])
@role_required("manager", "admin")
def edit_clock_record(record_id: int):
    """
    Corrects a shift's clock-in and/or clock-out time directly. Built for
    the case where a real mistake happened — wrong tap time, forgot to
    clock out at the actual time they left, etc. — and approving or
    rejecting the shift as-is wouldn't actually fix the underlying numbers.
    Overwrites in place; no separate edit history is kept (by design, to
    keep this simple), so the corrected time becomes the only time on
    record going forward.
    """
    data = request.get_json(silent=True) or {}
    new_clock_in = data.get("clockIn")
    new_clock_out = data.get("clockOut")

    if new_clock_in is None and new_clock_out is None:
        return validation_error("Provide at least one of clockIn or clockOut to update.", "clockIn")

    def parse_or_error(value, field_name):
        try:
            dt = datetime.fromisoformat(value)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt, None
        except (ValueError, TypeError):
            return None, validation_error(f"{field_name} must be a valid ISO timestamp.", field_name)

    with get_db_connection() as conn:
        existing = conn.execute(
            "SELECT id, clock_in_time, clock_out_time, status FROM clock_records WHERE id = ?",
            (record_id,),
        ).fetchone()
        if not existing:
            return jsonify({"success": False, "error": "No shift found with that ID."}), 404

        clock_in_dt = parse_timestamp(existing["clock_in_time"])
        clock_out_dt = parse_timestamp(existing["clock_out_time"]) if existing["clock_out_time"] else None

        if new_clock_in is not None:
            clock_in_dt, err = parse_or_error(new_clock_in, "clockIn")
            if err:
                return err
        if new_clock_out is not None:
            clock_out_dt, err = parse_or_error(new_clock_out, "clockOut")
            if err:
                return err

        if clock_out_dt is not None and clock_out_dt <= clock_in_dt:
            return validation_error("Clock out time must be after clock in time.", "clockOut")

        conn.execute(
            "UPDATE clock_records SET clock_in_time = ?, clock_out_time = ? WHERE id = ?",
            (clock_in_dt.isoformat(), clock_out_dt.isoformat() if clock_out_dt else None, record_id),
        )
        conn.commit()

    return jsonify({"success": True}), 200


@app.route("/timesheet-submissions", methods=["GET"])
@role_required("manager", "admin")
def timesheet_submissions():
    settings = fetch_admin_settings()
    daily_threshold = settings["dailyThreshold"]

    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT
                cr.id, cr.email, cr.clock_in_time, cr.clock_out_time, cr.approval_status,
                u.name, u.department, u.employee_id
            FROM clock_records cr
            JOIN users u ON u.email = cr.email
            WHERE cr.status = 'completed' AND cr.clock_out_time IS NOT NULL
            ORDER BY cr.id DESC
            """
        ).fetchall()

    submissions = []
    for row in rows:
        clock_in_dt = parse_timestamp(row["clock_in_time"])
        clock_out_dt = parse_timestamp(row["clock_out_time"])
        total_hours = round((clock_out_dt - clock_in_dt).total_seconds() / 3600, 2)
        regular_hours = round(min(total_hours, daily_threshold), 2)
        overtime_hours = round(max(0.0, total_hours - daily_threshold), 2)

        submissions.append({
            "id": str(row["id"]),
            "employeeId": row["employee_id"] or row["email"],
            "employeeName": row["name"],
            "department": row["department"] or "—",
            "period": clock_in_dt.strftime("%Y-%m-%d"),
            "regularHours": regular_hours,
            "overtimeHours": overtime_hours,
            "totalHours": total_hours,
            "status": row["approval_status"],
            "submittedAt": row["clock_out_time"],
        })

    return jsonify({"success": True, "submissions": submissions}), 200


@app.route("/timesheet-submissions/pdf", methods=["GET"])
@role_required("manager", "admin")
def timesheet_submissions_pdf():
    """
    PDF export of every completed shift awaiting or already given a
    decision — same underlying data as GET /timesheet-submissions, just
    rendered as a document a manager can save or print.
    """
    settings = fetch_admin_settings()
    daily_threshold = settings["dailyThreshold"]

    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT
                cr.id, cr.email, cr.clock_in_time, cr.clock_out_time, cr.approval_status,
                u.name, u.department, u.employee_id
            FROM clock_records cr
            JOIN users u ON u.email = cr.email
            WHERE cr.status = 'completed' AND cr.clock_out_time IS NOT NULL
            ORDER BY cr.id DESC
            """
        ).fetchall()

    # Group rows by status so the PDF reads like a real approvals report —
    # pending items first (the ones that actually need attention), then
    # approved, then rejected.
    by_status: dict[str, list] = {"pending": [], "approved": [], "rejected": []}
    for row in rows:
        clock_in_dt = parse_timestamp(row["clock_in_time"])
        clock_out_dt = parse_timestamp(row["clock_out_time"])
        total_hours = round((clock_out_dt - clock_in_dt).total_seconds() / 3600, 2)
        regular_hours = round(min(total_hours, daily_threshold), 2)
        overtime_hours = round(max(0.0, total_hours - daily_threshold), 2)
        line = [
            f'{row["name"]} ({row["employee_id"] or row["email"]})',
            clock_in_dt.astimezone().strftime("%I:%M %p"),
            clock_out_dt.astimezone().strftime("%I:%M %p"),
            f"{regular_hours}h", f"{overtime_hours}h", f"{total_hours}h",
        ]
        by_status.setdefault(row["approval_status"], []).append((clock_in_dt.strftime("%Y-%m-%d"), line))

    sections = []
    status_labels = {"pending": "Pending Review", "approved": "Approved", "rejected": "Rejected"}
    for status_key, label in status_labels.items():
        entries = by_status.get(status_key, [])
        if not entries:
            continue
        table_rows = [[date] + line for date, line in entries]
        totals = [
            round(sum(float(line[3].rstrip("h")) for _, line in entries), 2),
            round(sum(float(line[4].rstrip("h")) for _, line in entries), 2),
            round(sum(float(line[5].rstrip("h")) for _, line in entries), 2),
        ]
        sections.append({"heading": label, "rows": table_rows, "totals": totals})

    today = datetime.now(timezone.utc).strftime("%B %d, %Y")
    buffer = _render_pdf(
        "Timesheet Approvals Report",
        f"Generated {today}",
        sections,
        header_row=["Date", "Employee", "Clock In", "Clock Out", "Regular", "Overtime", "Total"],
        col_widths=[0.75*inch, 1.7*inch, 0.85*inch, 0.85*inch, 0.7*inch, 0.7*inch, 0.65*inch],
    )
    filename = f'hojaytrack-approvals-{datetime.now(timezone.utc).strftime("%Y-%m-%d")}.pdf'
    return send_file(buffer, mimetype="application/pdf", as_attachment=True, download_name=filename)


@app.route("/timesheet-submissions/<int:record_id>/approve", methods=["POST"])
@role_required("manager", "admin")
def approve_submission(record_id: int):
    return _set_approval_status(record_id, "approved")


@app.route("/timesheet-submissions/<int:record_id>/reject", methods=["POST"])
@role_required("manager", "admin")
def reject_submission(record_id: int):
    return _set_approval_status(record_id, "rejected")


def _set_approval_status(record_id: int, new_status: str):
    with get_db_connection() as conn:
        existing = conn.execute(
            "SELECT id FROM clock_records WHERE id = ? AND status = 'completed'",
            (record_id,),
        ).fetchone()
        if not existing:
            return jsonify({"success": False, "error": "Submission not found."}), 404

        conn.execute(
            "UPDATE clock_records SET approval_status = ? WHERE id = ?",
            (new_status, record_id),
        )
        conn.commit()

    return jsonify({"success": True, "status": new_status}), 200


# ---------------------------------------------------------------------------
# Admin settings — manager/admin only
# ---------------------------------------------------------------------------

@app.route("/admin-settings", methods=["GET"])
@role_required("admin", "manager")
def get_admin_settings_route():
    return jsonify({"success": True, "settings": fetch_admin_settings()}), 200


@app.route("/admin-settings", methods=["POST"])
@role_required("admin")
def update_admin_settings_route():
    data = request.get_json(silent=True) or {}
    current = fetch_admin_settings()

    def as_int(key: str, lo: int, hi: int):
        value = data.get(key, current[key])
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not (lo <= value <= hi):
            raise ValueError(f"{key} must be a number between {lo} and {hi}.")
        return int(value)

    def as_float(key: str, lo: float, hi: float):
        value = data.get(key, current[key])
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not (lo <= value <= hi):
            raise ValueError(f"{key} must be a number between {lo} and {hi}.")
        return float(value)

    def as_bool(key: str):
        value = data.get(key, current[key])
        if not isinstance(value, bool):
            raise ValueError(f"{key} must be true or false.")
        return value

    def as_time(key: str):
        value = data.get(key, current[key])
        if not isinstance(value, str) or not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", value):
            raise ValueError(f"{key} must be a 24-hour time like '09:00'.")
        return value

    try:
        update_values = {
            "daily_threshold": as_int("dailyThreshold", 1, 24),
            "weekly_threshold": as_int("weeklyThreshold", 1, 168),
            "overtime_multiplier": as_float("overtimeMultiplier", 1.0, 5.0),
            "double_time_threshold": as_int("doubleTimeThreshold", 1, 24),
            "double_time_multiplier": as_float("doubleTimeMultiplier", 1.0, 5.0),
            "enable_weekend_overtime": 1 if as_bool("enableWeekendOvertime") else 0,
            "enable_holiday_overtime": 1 if as_bool("enableHolidayOvertime") else 0,
            "auto_approve_regular_hours": 1 if as_bool("autoApproveRegularHours") else 0,
            "require_manager_approval": 1 if as_bool("requireManagerApproval") else 0,
            "max_weekly_hours": as_int("maxWeeklyHours", 1, 168),
            "break_deduction_minutes": as_int("breakDeductionMinutes", 0, 240),
            "expected_start_time": as_time("expectedStartTime"),
        }
    except ValueError as exc:
        return validation_error(str(exc))

    with get_db_connection() as conn:
        conn.execute(
            """
            UPDATE admin_settings SET
                daily_threshold = :daily_threshold,
                weekly_threshold = :weekly_threshold,
                overtime_multiplier = :overtime_multiplier,
                double_time_threshold = :double_time_threshold,
                double_time_multiplier = :double_time_multiplier,
                enable_weekend_overtime = :enable_weekend_overtime,
                enable_holiday_overtime = :enable_holiday_overtime,
                auto_approve_regular_hours = :auto_approve_regular_hours,
                require_manager_approval = :require_manager_approval,
                max_weekly_hours = :max_weekly_hours,
                break_deduction_minutes = :break_deduction_minutes,
                expected_start_time = :expected_start_time
            WHERE id = 1
            """,
            update_values,
        )
        conn.commit()

    return jsonify({"success": True, "settings": fetch_admin_settings()}), 200


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

# Entry point
# ---------------------------------------------------------------------------

# Initialize the database unconditionally at import time — not just inside
# `if __name__ == "__main__"`. A production WSGI server (like the one
# PythonAnywhere uses) imports this module directly and never executes that
# block, so init_db() never ran there, leaving the database with no tables
# at all. Running it here means it works the same way whether the app is
# started with `python app.py` locally or imported by a WSGI process.
init_db()

if __name__ == "__main__":
    # host="0.0.0.0" makes this reachable from other devices on your local
    # network (e.g. your phone) at http://<your-pc-LAN-ip>:5050, not just
    # from this machine. Set FRONTEND_ORIGIN below to match.
    app.run(host="0.0.0.0", port=5050, debug=True)
