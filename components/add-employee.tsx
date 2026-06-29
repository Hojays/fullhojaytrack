"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  UserPlus,
  UserMinus,
  CheckCircle2,
  AlertCircle,
  Search,
  Pencil,
  History,
  X,
  Users,
  Clock,
  CalendarClock,
  Download,
} from "lucide-react"
import { DashboardHeader } from "@/components/dashboard-header"

const API_BASE = "/api"

type Role = "employee" | "manager" | "admin"
type Tab = "add" | "remove"

interface Employee {
  email: string
  name: string
  role: Role
  department: string
  employeeId: string
}

interface HistoryShift {
  id: number
  clockIn: string
  clockOut: string
  regularHours: number
  overtimeHours: number
  totalHours: number
  autoCapped: boolean
  isLate: boolean
}

interface Summary {
  totalEmployees: number
  currentlyClockedIn: { email: string; name: string }[]
  currentlyClockedInCount: number
  totalHoursThisWeek: number
}

function formatLocalTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

function formatLocalDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function AddEmployee() {
  const [tab, setTab] = useState<Tab>("add")

  // Summary cards
  const [summary, setSummary] = useState<Summary | null>(null)

  // Employee directory (search/filter/edit/history)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeesLoading, setEmployeesLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [editingEmail, setEditingEmail] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editRole, setEditRole] = useState<Role>("employee")
  const [editDepartment, setEditDepartment] = useState("")
  const [isSavingEdit, setIsSavingEdit] = useState(false)
  const [editError, setEditError] = useState("")
  const [historyEmail, setHistoryEmail] = useState<string | null>(null)
  const [historyData, setHistoryData] = useState<{ employee: Employee; history: HistoryShift[] } | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)

  // Password change — admin only, always requires that account's CURRENT
  // password, even when an admin is changing their own. There's no
  // backdoor reset; the employee tells the admin their current password
  // directly, and the admin types it in here.
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [isSavingPassword, setIsSavingPassword] = useState(false)
  const [passwordError, setPasswordError] = useState("")
  const [passwordSuccess, setPasswordSuccess] = useState("")

  // Add employee state
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState<Role>("employee")
  const [department, setDepartment] = useState("")
  const [employeeId, setEmployeeId] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [successName, setSuccessName] = useState("")

  // Remove employee state
  const [removeId, setRemoveId] = useState("")
  const [removeConfirmName, setRemoveConfirmName] = useState("")
  const [isRemoving, setIsRemoving] = useState(false)
  const [removeError, setRemoveError] = useState("")
  const [removeSuccess, setRemoveSuccess] = useState("")

  const fetchEmployees = useCallback(async () => {
    setEmployeesLoading(true)
    try {
      const res = await fetch(`${API_BASE}/employees`, { credentials: "include" })
      const data = await res.json()
      if (res.ok && data.success && Array.isArray(data.employees)) {
        setEmployees(data.employees)
        return data.employees as Employee[]
      }
    } catch {
      // leave the list as-is on failure; the search box will just show stale data
    } finally {
      setEmployeesLoading(false)
    }
    return []
  }, [])

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/dashboard-summary`, { credentials: "include" })
      const data = await res.json()
      if (res.ok && data.success) setSummary(data)
    } catch {
      // summary cards just stay blank on failure — not worth a full-page error for this
    }
  }, [])

  const triggerCsvDownload = async (url: string, fallbackFilename: string) => {
    const res = await fetch(url, { credentials: "include" })
    if (!res.ok) {
      throw new Error("Export failed")
    }
    const disposition = res.headers.get("content-disposition") || ""
    const match = disposition.match(/filename="?([^"]+)"?/)
    const filename = match ? match[1] : fallbackFilename
    const blob = await res.blob()
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = blobUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)
  }

  const downloadEmployeeDirectory = async () => {
    try {
      await triggerCsvDownload(`${API_BASE}/export/employees`, "hojaytrack-employees.csv")
    } catch {
      setBackupError("Could not download the employee directory.")
    }
  }

  // Backup-by-date-range export
  const [backupFrom, setBackupFrom] = useState(() => {
    const d = new Date()
    d.setMonth(d.getMonth() - 1)
    return d.toISOString().slice(0, 10)
  })
  const [backupTo, setBackupTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [isExportingBackup, setIsExportingBackup] = useState(false)
  const [backupError, setBackupError] = useState("")

  const downloadBackup = async () => {
    setIsExportingBackup(true)
    setBackupError("")
    try {
      await triggerCsvDownload(
        `${API_BASE}/export/backup?from=${backupFrom}&to=${backupTo}`,
        `hojaytrack-backup-${backupFrom}-to-${backupTo}.csv`
      )
    } catch {
      setBackupError("Could not generate the backup export.")
    } finally {
      setIsExportingBackup(false)
    }
  }

  // Auto-generate employee ID on mount and after each successful add
  const generateEmployeeId = useCallback(async () => {
    const list = await fetchEmployees()
    const nums = list
      .map((e) => {
        const match = e.employeeId?.match(/^EMP-(\d+)$/)
        return match ? parseInt(match[1], 10) : 0
      })
      .filter(Boolean)
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1
    setEmployeeId(`EMP-${String(next).padStart(3, "0")}`)
  }, [fetchEmployees])

  useEffect(() => {
    generateEmployeeId()
    fetchSummary()
  }, [generateEmployeeId, fetchSummary])

  const resetForm = () => {
    setName("")
    setEmail("")
    setPassword("")
    setRole("employee")
    setDepartment("")
    generateEmployeeId()
    fetchSummary()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setSuccessName("")
    setIsSubmitting(true)

    try {
      const res = await fetch(`${API_BASE}/register`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          password,
          role,
          department: department.trim(),
          employeeId: employeeId.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.error ?? "Could not create this account.")
        return
      }
      setSuccessName(name.trim())
      resetForm()
    } catch {
      setError("Could not reach the server. Make sure the backend is running.")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleRemove = async (e: React.FormEvent) => {
    e.preventDefault()
    setRemoveError("")
    setRemoveSuccess("")
    setIsRemoving(true)

    try {
      const res = await fetch(`${API_BASE}/employees/${removeId.trim()}`, {
        method: "DELETE",
        credentials: "include",
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setRemoveError(data.error ?? "Could not remove this employee.")
        return
      }
      setRemoveSuccess(`${data.removedName} has been removed. Their past clock-in history is kept for your records.`)
      setRemoveId("")
      setRemoveConfirmName("")
      fetchEmployees()
      fetchSummary()
    } catch {
      setRemoveError("Could not reach the server. Make sure the backend is running.")
    } finally {
      setIsRemoving(false)
    }
  }

  const employeeBeingRemoved = employees.find(
    (e) => e.employeeId === removeId.trim() || e.email === removeId.trim().toLowerCase()
  )
  const removeConfirmMatches =
    employeeBeingRemoved && removeConfirmName.trim().toLowerCase() === employeeBeingRemoved.name.trim().toLowerCase()

  const startEditing = (emp: Employee) => {
    setEditingEmail(emp.email)
    setEditName(emp.name)
    setEditRole(emp.role)
    setEditDepartment(emp.department)
    setEditError("")
    setHistoryEmail(null)
    setCurrentPassword("")
    setNewPassword("")
    setPasswordError("")
    setPasswordSuccess("")
  }

  const cancelEditing = () => {
    setEditingEmail(null)
    setEditError("")
  }

  const saveEdit = async () => {
    if (!editingEmail) return
    setIsSavingEdit(true)
    setEditError("")
    try {
      const res = await fetch(`${API_BASE}/users/${editingEmail}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName.trim(), role: editRole, department: editDepartment.trim() }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setEditError(data.error ?? "Could not save these changes.")
        return
      }
      setEditingEmail(null)
      fetchEmployees()
    } catch {
      setEditError("Could not reach the server.")
    } finally {
      setIsSavingEdit(false)
    }
  }

  const savePassword = async () => {
    if (!editingEmail) return
    setIsSavingPassword(true)
    setPasswordError("")
    setPasswordSuccess("")
    try {
      const res = await fetch(`${API_BASE}/users/${editingEmail}/password`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setPasswordError(data.error ?? "Could not change this password.")
        return
      }
      setPasswordSuccess("Password changed successfully.")
      setCurrentPassword("")
      setNewPassword("")
    } catch {
      setPasswordError("Could not reach the server.")
    } finally {
      setIsSavingPassword(false)
    }
  }

  const viewHistory = async (emp: Employee) => {
    setHistoryEmail(emp.email)
    setEditingEmail(null)
    setHistoryLoading(true)
    setHistoryData(null)
    try {
      const res = await fetch(`${API_BASE}/users/${emp.email}/history`, { credentials: "include" })
      const data = await res.json()
      if (res.ok && data.success) {
        setHistoryData(data)
      }
    } catch {
      // panel just stays empty/loading-failed; not worth a full error banner here
    } finally {
      setHistoryLoading(false)
    }
  }

  const filteredEmployees = employees.filter((e) => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return true
    return e.name.toLowerCase().includes(q) || e.employeeId.toLowerCase().includes(q) || e.email.toLowerCase().includes(q)
  })

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <DashboardHeader
        title="Manage Employees"
        description="Add, edit, search, and remove employees across the organization"
      />

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Employees</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold text-foreground">{summary?.totalEmployees ?? "—"}</p>
            <p className="text-xs text-muted-foreground">across every role</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Currently Clocked In</CardTitle>
            <Clock className="h-4 w-4 text-success" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold text-foreground">{summary?.currentlyClockedInCount ?? "—"}</p>
            <p className="truncate text-xs text-muted-foreground">
              {summary && summary.currentlyClockedInCount > 0
                ? summary.currentlyClockedIn.map((p) => p.name).join(", ")
                : "no one right now"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Hours This Week</CardTitle>
            <CalendarClock className="h-4 w-4 text-accent" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold text-foreground">{summary?.totalHoursThisWeek ?? "—"}h</p>
            <p className="text-xs text-muted-foreground">across the whole team</p>
          </CardContent>
        </Card>
      </div>

      {/* Backup export by date range */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Download className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            Backup Data
          </CardTitle>
          <CardDescription>
            Download every shift across every employee for a chosen period, as a spreadsheet — nothing is deleted from the system either way.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {backupError && (
            <p className="mb-3 text-sm text-destructive">{backupError}</p>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="backup-from">From</Label>
              <Input id="backup-from" type="date" value={backupFrom} onChange={(e) => setBackupFrom(e.target.value)} className="w-40" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="backup-to">To</Label>
              <Input id="backup-to" type="date" value={backupTo} onChange={(e) => setBackupTo(e.target.value)} className="w-40" />
            </div>
            <Button onClick={downloadBackup} disabled={isExportingBackup} className="gap-2">
              <Download className="h-4 w-4" aria-hidden="true" />
              {isExportingBackup ? "Preparing…" : "Download Backup"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Employee directory: search, edit, history */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-foreground">Employee Directory</CardTitle>
            <CardDescription>Search by name or employee ID, edit details, or view someone's clock-in history</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={downloadEmployeeDirectory} className="shrink-0 gap-1.5">
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Export
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name or employee ID…"
              className="pl-9"
              aria-label="Search employees"
            />
          </div>

          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground">Name</TableHead>
                  <TableHead className="text-muted-foreground">ID</TableHead>
                  <TableHead className="text-muted-foreground">Role</TableHead>
                  <TableHead className="text-muted-foreground">Department</TableHead>
                  <TableHead className="text-right text-muted-foreground">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {employeesLoading ? (
                  <TableRow className="border-border">
                    <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">Loading…</TableCell>
                  </TableRow>
                ) : filteredEmployees.length === 0 ? (
                  <TableRow className="border-border">
                    <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                      {searchQuery ? "No employees match that search." : "No employees yet."}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredEmployees.map((emp) => (
                    <>
                      <TableRow key={emp.email} className="border-border">
                        <TableCell className="font-medium text-foreground">{emp.name}</TableCell>
                        <TableCell className="font-mono text-xs text-foreground">{emp.employeeId || "—"}</TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="capitalize">{emp.role}</Badge>
                        </TableCell>
                        <TableCell className="text-foreground">{emp.department || "—"}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" onClick={() => startEditing(emp)} className="gap-1.5">
                              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                              Edit
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => viewHistory(emp)} className="gap-1.5">
                              <History className="h-3.5 w-3.5" aria-hidden="true" />
                              History
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>

                      {editingEmail === emp.email && (
                        <TableRow className="border-border bg-muted/30">
                          <TableCell colSpan={5} className="p-4">
                            <div className="space-y-3">
                              {editError && (
                                <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                                  {editError}
                                </div>
                              )}
                              <div className="grid gap-3 sm:grid-cols-3">
                                <div className="space-y-1">
                                  <Label htmlFor={`edit-name-${emp.email}`}>Name</Label>
                                  <Input id={`edit-name-${emp.email}`} value={editName} onChange={(e) => setEditName(e.target.value)} />
                                </div>
                                <div className="space-y-1">
                                  <Label htmlFor={`edit-role-${emp.email}`}>Role</Label>
                                  <select
                                    id={`edit-role-${emp.email}`}
                                    value={editRole}
                                    onChange={(e) => setEditRole(e.target.value as Role)}
                                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                                  >
                                    <option value="employee">Employee</option>
                                    <option value="manager">Manager</option>
                                    <option value="admin">Admin</option>
                                  </select>
                                </div>
                                <div className="space-y-1">
                                  <Label htmlFor={`edit-dept-${emp.email}`}>Department</Label>
                                  <Input id={`edit-dept-${emp.email}`} value={editDepartment} onChange={(e) => setEditDepartment(e.target.value)} />
                                </div>
                              </div>
                              <div className="flex gap-2">
                                <Button size="sm" onClick={saveEdit} disabled={isSavingEdit}>
                                  {isSavingEdit ? "Saving…" : "Save Changes"}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={cancelEditing}>
                                  <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                                  Cancel
                                </Button>
                              </div>

                              <div className="space-y-2 border-t border-border pt-3">
                                <p className="text-sm font-medium text-foreground">Change Password</p>
                                <p className="text-xs text-muted-foreground">
                                  Ask {emp.name.split(" ")[0]} for their current password, then set a new one.
                                </p>
                                {passwordError && (
                                  <p className="text-xs text-destructive">{passwordError}</p>
                                )}
                                {passwordSuccess && (
                                  <p className="text-xs text-success">{passwordSuccess}</p>
                                )}
                                <div className="grid gap-2 sm:grid-cols-2">
                                  <Input
                                    type="password"
                                    placeholder="Current password"
                                    value={currentPassword}
                                    onChange={(e) => setCurrentPassword(e.target.value)}
                                  />
                                  <Input
                                    type="password"
                                    placeholder="New password (8+ chars, letters & numbers)"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                  />
                                </div>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={savePassword}
                                  disabled={isSavingPassword || !currentPassword || !newPassword}
                                >
                                  {isSavingPassword ? "Changing…" : "Change Password"}
                                </Button>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}

                      {historyEmail === emp.email && (
                        <TableRow className="border-border bg-muted/30">
                          <TableCell colSpan={5} className="p-4">
                            {historyLoading ? (
                              <p className="py-4 text-center text-sm text-muted-foreground">Loading history…</p>
                            ) : !historyData ? (
                              <p className="py-4 text-center text-sm text-destructive">Could not load history for this employee.</p>
                            ) : historyData.history.length === 0 ? (
                              <p className="py-4 text-center text-sm text-muted-foreground">No completed shifts yet.</p>
                            ) : (
                              <div className="overflow-x-auto">
                                <Table>
                                  <TableHeader>
                                    <TableRow className="border-border hover:bg-transparent">
                                      <TableHead className="text-muted-foreground">Date</TableHead>
                                      <TableHead className="text-muted-foreground">Clock In</TableHead>
                                      <TableHead className="text-muted-foreground">Clock Out</TableHead>
                                      <TableHead className="text-right text-muted-foreground">Total</TableHead>
                                      <TableHead className="text-muted-foreground">Flags</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {historyData.history.map((s) => (
                                      <TableRow key={s.id} className="border-border">
                                        <TableCell className="text-foreground">{formatLocalDate(s.clockIn)}</TableCell>
                                        <TableCell className={s.isLate ? "font-medium text-destructive" : "text-foreground"}>
                                          {formatLocalTime(s.clockIn)}
                                        </TableCell>
                                        <TableCell className="text-foreground">{formatLocalTime(s.clockOut)}</TableCell>
                                        <TableCell className="text-right font-medium text-foreground">{s.totalHours}h</TableCell>
                                        <TableCell>
                                          <div className="flex gap-1">
                                            {s.isLate && (
                                              <Badge variant="secondary" className="bg-destructive/15 text-destructive border-destructive/30">
                                                Late
                                              </Badge>
                                            )}
                                            {s.autoCapped && (
                                              <Badge variant="secondary" className="bg-warning/15 text-warning border-warning/30">
                                                Auto-capped
                                              </Badge>
                                            )}
                                          </div>
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => setHistoryEmail(null)} className="mt-2">
                              <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                              Close
                            </Button>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Tab switcher */}
      <div className="flex gap-2 border-b border-border">
        <button
          onClick={() => { setTab("add"); setError(""); setSuccessName("") }}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "add"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <UserPlus className="h-4 w-4" />
          Add Employee
        </button>
        <button
          onClick={() => { setTab("remove"); setRemoveError(""); setRemoveSuccess("") }}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "remove"
              ? "border-destructive text-destructive"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <UserMinus className="h-4 w-4" />
          Remove Employee
        </button>
      </div>

      {tab === "add" && (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <UserPlus className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              New Account
            </CardTitle>
            <CardDescription>
              They'll be able to log in immediately using the email and password set here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {successName && (
              <div className="mb-5 flex items-center gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-sm text-success" role="status">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                {successName}'s account was created successfully.
              </div>
            )}
            {error && (
              <div className="mb-5 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive" role="alert">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="name">Full name</Label>
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Jane Smith" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="jane@company.com" />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="At least 8 characters, with letters and numbers"
                />
                <p className="text-xs text-muted-foreground">
                  Share this with them directly — there's no email/reset flow yet, so this is the password they'll log in with.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="role">Role</Label>
                  <select
                    id="role"
                    value={role}
                    onChange={(e) => setRole(e.target.value as Role)}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="employee">Employee</option>
                    <option value="manager">Manager</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="department">Department</Label>
                  <Input id="department" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Engineering" />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="employeeId">Employee ID (auto-generated)</Label>
                <Input
                  id="employeeId"
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                  placeholder="EMP-001"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">Auto-generated — you can change it if needed.</p>
              </div>

              <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto">
                {isSubmitting ? "Creating account…" : "Create Account"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {tab === "remove" && (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <UserMinus className="h-5 w-5 text-destructive" aria-hidden="true" />
              Remove Employee
            </CardTitle>
            <CardDescription>
              Enter the employee ID to permanently remove their account. Their past clock-in history is kept for your records.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {removeSuccess && (
              <div className="mb-5 flex items-center gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-sm text-success" role="status">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                {removeSuccess}
              </div>
            )}
            {removeError && (
              <div className="mb-5 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive" role="alert">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {removeError}
              </div>
            )}

            <form onSubmit={handleRemove} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="removeId">Employee ID</Label>
                <Input
                  id="removeId"
                  value={removeId}
                  onChange={(e) => { setRemoveId(e.target.value); setRemoveConfirmName("") }}
                  required
                  placeholder="EMP-001"
                  className="font-mono max-w-xs"
                />
                <p className="text-xs text-muted-foreground">This is the ID assigned during registration, e.g. EMP-001.</p>
              </div>

              {employeeBeingRemoved && (
                <div className="space-y-1.5">
                  <Label htmlFor="removeConfirmName">
                    Type <span className="font-semibold text-foreground">{employeeBeingRemoved.name}</span> to confirm
                  </Label>
                  <Input
                    id="removeConfirmName"
                    value={removeConfirmName}
                    onChange={(e) => setRemoveConfirmName(e.target.value)}
                    placeholder={employeeBeingRemoved.name}
                    className="max-w-xs"
                  />
                </div>
              )}

              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                ⚠️ This removes their login permanently. Their clock-in history is kept, not deleted.
              </div>

              <Button
                type="submit"
                variant="destructive"
                disabled={isRemoving || !removeId.trim() || !removeConfirmMatches}
                className="w-full sm:w-auto"
              >
                {isRemoving ? "Removing…" : "Remove Employee"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
