"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Clock, Coffee, AlertTriangle, Users, RefreshCw, Pencil, X } from "lucide-react"
import { DashboardHeader } from "@/components/dashboard-header"
import { Button } from "@/components/ui/button"
import { WeeklyReportPanel } from "@/components/weekly-report-panel"
import { formatLocalTime } from "@/lib/utils"

const API_BASE = "/api"

interface Timecard {
  id: number
  employeeId: string
  employeeName: string
  department: string
  date: string
  clockIn: string
  clockOut: string | null
  isActive: boolean
  onBreak: boolean
  regularHours: number
  overtimeHours: number
  totalHours: number
  breakMinutes: number
  unpaidBreakMinutes: number
  autoCapped: boolean
  approvalStatus: "pending" | "approved" | "rejected"
  isLate: boolean
}

// Converts a stored ISO timestamp into the value a <input type="datetime-local">
// needs (local time, no timezone suffix), and back again.
function toDatetimeLocalValue(iso: string) {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromDatetimeLocalValue(value: string) {
  return new Date(value).toISOString()
}

export function AdminTimecards() {
  const [timecards, setTimecards] = useState<Timecard[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState("")

  const [editingId, setEditingId] = useState<number | null>(null)
  const [editClockIn, setEditClockIn] = useState("")
  const [editClockOut, setEditClockOut] = useState("")
  const [isSavingEdit, setIsSavingEdit] = useState(false)
  const [editError, setEditError] = useState("")

  const fetchTimecards = useCallback(async () => {
    setError("")
    try {
      const res = await fetch(`${API_BASE}/admin/timecards`, { credentials: "include" })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.error ?? "Could not load timecards.")
        return
      }
      setTimecards(data.timecards)
    } catch {
      setError("Could not reach the server to load timecards.")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTimecards()
  }, [fetchTimecards])

  const [filterEmployee, setFilterEmployee] = useState("")
  const [filterFrom, setFilterFrom] = useState("")
  const [filterTo, setFilterTo] = useState("")

  const filteredTimecards = timecards.filter((t) => {
    if (filterEmployee.trim()) {
      const q = filterEmployee.trim().toLowerCase()
      if (!t.employeeName.toLowerCase().includes(q) && !t.employeeId.toLowerCase().includes(q)) return false
    }
    if (filterFrom && t.date < filterFrom) return false
    if (filterTo && t.date > filterTo) return false
    return true
  })

  const activeCount = filteredTimecards.filter((t) => t.isActive).length
  const cappedCount = filteredTimecards.filter((t) => t.autoCapped).length
  const totalOvertime = filteredTimecards.reduce((sum, t) => sum + t.overtimeHours, 0)

  const startEditing = (card: Timecard) => {
    setEditingId(card.id)
    setEditClockIn(toDatetimeLocalValue(card.clockIn))
    setEditClockOut(card.clockOut ? toDatetimeLocalValue(card.clockOut) : "")
    setEditError("")
  }

  const cancelEditing = () => {
    setEditingId(null)
    setEditError("")
  }

  const saveEdit = async () => {
    if (editingId === null) return
    setIsSavingEdit(true)
    setEditError("")
    try {
      const body: { clockIn?: string; clockOut?: string } = {
        clockIn: fromDatetimeLocalValue(editClockIn),
      }
      if (editClockOut) body.clockOut = fromDatetimeLocalValue(editClockOut)

      const res = await fetch(`${API_BASE}/clock-records/${editingId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setEditError(data.error ?? "Could not save this correction.")
        return
      }
      setEditingId(null)
      fetchTimecards()
    } catch {
      setEditError("Could not reach the server.")
    } finally {
      setIsSavingEdit(false)
    }
  }

  const renderFlags = (card: Timecard) => (
    <div className="flex flex-wrap gap-1">
      {card.isLate && (
        <Badge variant="secondary" className="bg-destructive/15 text-destructive border-destructive/30">Late</Badge>
      )}
      {card.onBreak && (
        <Badge variant="secondary" className="bg-warning/15 text-warning border-warning/30">On break</Badge>
      )}
      {card.autoCapped && (
        <Badge variant="secondary" className="bg-destructive/15 text-destructive border-destructive/30">Auto-capped</Badge>
      )}
      {!card.isActive && (
        <Badge
          variant="secondary"
          className={
            card.approvalStatus === "approved"
              ? "bg-success/15 text-success border-success/30"
              : card.approvalStatus === "rejected"
                ? "bg-destructive/15 text-destructive border-destructive/30"
                : "bg-muted text-muted-foreground"
          }
        >
          {card.approvalStatus}
        </Badge>
      )}
    </div>
  )

  const renderEditForm = (card: Timecard) => (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
      {editError && (
        <p className="text-sm text-destructive">{editError}</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`edit-in-${card.id}`}>Clock in</Label>
          <Input
            id={`edit-in-${card.id}`}
            type="datetime-local"
            value={editClockIn}
            onChange={(e) => setEditClockIn(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`edit-out-${card.id}`}>Clock out {card.isActive && "(leave blank — still active)"}</Label>
          <Input
            id={`edit-out-${card.id}`}
            type="datetime-local"
            value={editClockOut}
            onChange={(e) => setEditClockOut(e.target.value)}
            disabled={card.isActive}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={saveEdit} disabled={isSavingEdit}>
          {isSavingEdit ? "Saving…" : "Save Correction"}
        </Button>
        <Button size="sm" variant="ghost" onClick={cancelEditing}>
          <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Cancel
        </Button>
      </div>
    </div>
  )

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <DashboardHeader
        title="Employee Timecards"
        description="Every clock-in across the team, with live status, break deductions, and guardrail activity"
      >
        <Button variant="outline" size="sm" onClick={fetchTimecards} disabled={isLoading} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} aria-hidden="true" />
          Refresh
        </Button>
      </DashboardHeader>

      {/* Summary stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Currently Clocked In</CardTitle>
            <Clock className="h-4 w-4 text-success" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold text-foreground">{activeCount}</p>
            <p className="text-xs text-muted-foreground">employees on shift right now</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Auto-Capped Shifts</CardTitle>
            <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold text-foreground">{cappedCount}</p>
            <p className="text-xs text-muted-foreground">ended by the daily hours guardrail</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Overtime</CardTitle>
            <Users className="h-4 w-4 text-accent" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold text-foreground">{totalOvertime.toFixed(2)}h</p>
            <p className="text-xs text-muted-foreground">across all shifts shown below</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Clock Records</CardTitle>
          <CardDescription>Active and completed shifts across every employee, most recent first</CardDescription>
        </CardHeader>
        <div className="flex flex-wrap items-end gap-3 px-6 pb-4">
          <div className="space-y-1">
            <Label htmlFor="filter-employee" className="text-xs">Employee</Label>
            <Input
              id="filter-employee"
              placeholder="Name or ID…"
              value={filterEmployee}
              onChange={(e) => setFilterEmployee(e.target.value)}
              className="w-44"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="filter-from" className="text-xs">From</Label>
            <Input id="filter-from" type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} className="w-40" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="filter-to" className="text-xs">To</Label>
            <Input id="filter-to" type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} className="w-40" />
          </div>
          {(filterEmployee || filterFrom || filterTo) && (
            <Button variant="ghost" size="sm" onClick={() => { setFilterEmployee(""); setFilterFrom(""); setFilterTo("") }}>
              Clear filters
            </Button>
          )}
        </div>
        <CardContent>
          {isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading timecards…</p>
          ) : error ? (
            <p className="py-8 text-center text-sm text-destructive">{error}</p>
          ) : filteredTimecards.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No clock records yet. Once employees start clocking in, they'll show up here.
            </p>
          ) : (
            <>
              {/* Mobile: stacked cards, no sideways scrolling */}
              <div className="space-y-3 md:hidden">
                {filteredTimecards.map((card) => (
                  <div key={card.id} className="rounded-lg border border-border p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-foreground">{card.employeeName}</p>
                        <p className="text-xs text-muted-foreground">{card.employeeId} · {card.department}</p>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => startEditing(card)} className="shrink-0 gap-1">
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">Clock in</p>
                        <p className={card.isLate ? "font-medium text-destructive" : "text-foreground"}>
                          {formatLocalTime(card.clockIn)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Clock out</p>
                        {card.isActive ? (
                          <Badge className="bg-success/15 text-success border-success/30">On shift</Badge>
                        ) : (
                          <p className="text-foreground">{formatLocalTime(card.clockOut)}</p>
                        )}
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Total</p>
                        <p className="font-medium text-foreground">
                          {card.totalHours}h {card.overtimeHours > 0 && <span className="text-accent">(+{card.overtimeHours}h OT)</span>}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Breaks</p>
                        <p className="text-foreground">{card.breakMinutes > 0 ? `${card.breakMinutes}m` : "—"}</p>
                      </div>
                    </div>
                    <div className="mt-3">{renderFlags(card)}</div>
                    {editingId === card.id && <div className="mt-3">{renderEditForm(card)}</div>}
                  </div>
                ))}
              </div>

              {/* Desktop/tablet: real table */}
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border">
                      <TableHead>Employee</TableHead>
                      <TableHead className="hidden lg:table-cell">Department</TableHead>
                      <TableHead className="hidden lg:table-cell">Date</TableHead>
                      <TableHead>Clock In</TableHead>
                      <TableHead>Clock Out</TableHead>
                      <TableHead className="text-right hidden sm:table-cell">Breaks</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Flags</TableHead>
                      <TableHead className="text-right">Edit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredTimecards.map((card) => (
                      <>
                        <TableRow key={card.id} className="border-border">
                          <TableCell>
                            <div>
                              <p className="font-medium text-foreground">{card.employeeName}</p>
                              <p className="text-xs text-muted-foreground">{card.employeeId}</p>
                            </div>
                          </TableCell>
                          <TableCell className="text-foreground hidden lg:table-cell">{card.department}</TableCell>
                          <TableCell className="text-foreground hidden lg:table-cell">{card.date}</TableCell>
                          <TableCell className={card.isLate ? "font-medium text-destructive" : "text-foreground"}>
                            {formatLocalTime(card.clockIn)}
                          </TableCell>
                          <TableCell>
                            {card.isActive ? (
                              <Badge className="bg-success/15 text-success border-success/30">
                                <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-success animate-pulse inline-block" aria-hidden="true" />
                                On shift
                              </Badge>
                            ) : (
                              <span className="text-foreground">{formatLocalTime(card.clockOut)}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right hidden sm:table-cell">
                            {card.breakMinutes > 0 ? (
                              <span className="inline-flex items-center gap-1 text-sm text-foreground">
                                <Coffee className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                                {card.breakMinutes}m
                                {card.unpaidBreakMinutes > 0 && (
                                  <span className="text-warning text-xs">(−{card.unpaidBreakMinutes}m unpaid)</span>
                                )}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="font-medium text-foreground">{card.totalHours}h</div>
                            {card.overtimeHours > 0 && <div className="text-xs text-accent">+{card.overtimeHours}h OT</div>}
                          </TableCell>
                          <TableCell>{renderFlags(card)}</TableCell>
                          <TableCell className="text-right">
                            <Button size="sm" variant="ghost" onClick={() => startEditing(card)}>
                              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                            </Button>
                          </TableCell>
                        </TableRow>
                        {editingId === card.id && (
                          <TableRow className="border-border">
                            <TableCell colSpan={9} className="p-3">
                              {renderEditForm(card)}
                            </TableCell>
                          </TableRow>
                        )}
                      </>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <WeeklyReportPanel scope="team" />
    </div>
  )
}
