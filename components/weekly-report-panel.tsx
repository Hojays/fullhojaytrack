"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
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
import { FileText, Download, X } from "lucide-react"

const API_BASE = "/api"

interface ShiftRow {
  date: string
  clockIn: string
  clockOut: string
  regularHours: number
  overtimeHours: number
  totalHours: number
  autoCapped: boolean
}

interface EmployeeReport {
  weekStart: string
  weekEnd: string
  employee: { name: string; department: string; employeeId: string }
  shifts: ShiftRow[]
  totals: { regularHours: number; overtimeHours: number; totalHours: number }
}

interface TeamReport {
  weekStart: string
  weekEnd: string
  employees: { employee: EmployeeReport["employee"]; shifts: ShiftRow[]; totals: EmployeeReport["totals"] }[]
}

interface WeeklyReportPanelProps {
  scope: "own" | "team"
}

function formatLocalTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

function formatDisplayDate(isoDate: string) {
  return new Date(isoDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function WeeklyReportPanel({ scope }: WeeklyReportPanelProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")
  const [ownReport, setOwnReport] = useState<EmployeeReport | null>(null)
  const [teamReport, setTeamReport] = useState<TeamReport | null>(null)
  const [isDownloading, setIsDownloading] = useState(false)

  const fetchReport = async (week: string) => {
    setIsLoading(true)
    setError("")
    try {
      const endpoint = scope === "team" ? "/reports/weekly/team" : "/reports/weekly"
      const res = await fetch(`${API_BASE}${endpoint}?week=${week}`, { credentials: "include" })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.error ?? "Could not load that week's report.")
        return
      }
      if (scope === "team") {
        setTeamReport(data)
        setOwnReport(null)
      } else {
        setOwnReport(data)
        setTeamReport(null)
      }
    } catch {
      setError("Could not reach the server to load this report.")
    } finally {
      setIsLoading(false)
    }
  }

  const handleShowReport = () => {
    setIsOpen(true)
    fetchReport(selectedDate)
  }

  const handleDateChange = (value: string) => {
    setSelectedDate(value)
    fetchReport(value)
  }

  const handleDownloadPdf = async () => {
    setIsDownloading(true)
    try {
      const endpoint = scope === "team" ? "/reports/weekly/team/pdf" : "/reports/weekly/pdf"
      const res = await fetch(`${API_BASE}${endpoint}?week=${selectedDate}`, { credentials: "include" })
      if (!res.ok) {
        setError("Could not generate the PDF for this week.")
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `hojaytrack-report-${selectedDate}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      setError("Could not reach the server to download the PDF.")
    } finally {
      setIsDownloading(false)
    }
  }

  const renderShiftTable = (shifts: ShiftRow[], totals: EmployeeReport["totals"]) => (
    <Table>
      <TableHeader>
        <TableRow className="border-border hover:bg-transparent">
          <TableHead className="text-muted-foreground">Date</TableHead>
          <TableHead className="text-muted-foreground">Clock In</TableHead>
          <TableHead className="text-muted-foreground">Clock Out</TableHead>
          <TableHead className="text-right text-muted-foreground">Regular</TableHead>
          <TableHead className="text-right text-muted-foreground">Overtime</TableHead>
          <TableHead className="text-right text-muted-foreground">Total</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shifts.length === 0 ? (
          <TableRow className="border-border">
            <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
              No shifts logged this week.
            </TableCell>
          </TableRow>
        ) : (
          shifts.map((s, i) => (
            <TableRow key={i} className="border-border">
              <TableCell className="text-foreground">{s.date}</TableCell>
              <TableCell className="text-foreground">{formatLocalTime(s.clockIn)}</TableCell>
              <TableCell className="text-foreground">{formatLocalTime(s.clockOut)}</TableCell>
              <TableCell className="text-right text-foreground">{s.regularHours}h</TableCell>
              <TableCell className="text-right">
                {s.overtimeHours > 0 ? (
                  <Badge variant="secondary" className="bg-accent/20 text-accent">+{s.overtimeHours}h</Badge>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </TableCell>
              <TableCell className="text-right font-medium text-foreground">{s.totalHours}h</TableCell>
            </TableRow>
          ))
        )}
        {shifts.length > 0 && (
          <TableRow className="border-border bg-muted/30">
            <TableCell colSpan={3} className="font-medium text-foreground">Week total</TableCell>
            <TableCell className="text-right font-medium text-foreground">{totals.regularHours}h</TableCell>
            <TableCell className="text-right font-medium text-accent">{totals.overtimeHours > 0 ? `+${totals.overtimeHours}h` : "-"}</TableCell>
            <TableCell className="text-right font-semibold text-foreground">{totals.totalHours}h</TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <FileText className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          Weekly Report
        </CardTitle>
        <CardDescription>
          {scope === "team" ? "View and download hours for every employee, by week" : "View and download your own hours, by week"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!isOpen ? (
          <Button onClick={handleShowReport} className="gap-2">
            <FileText className="h-4 w-4" aria-hidden="true" />
            Show Weekly Report
          </Button>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="space-y-1.5">
                <label htmlFor="report-week-picker" className="text-xs font-medium text-muted-foreground">
                  Select any date in the week you want
                </label>
                <Input
                  id="report-week-picker"
                  type="date"
                  value={selectedDate}
                  onChange={(e) => handleDateChange(e.target.value)}
                  className="w-44"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={handleDownloadPdf}
                  disabled={isDownloading || isLoading}
                  className="gap-2"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  {isDownloading ? "Preparing…" : "Download PDF"}
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setIsOpen(false)} aria-label="Close report">
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>

            {isLoading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Loading report…</p>
            ) : error ? (
              <p className="py-8 text-center text-sm text-destructive">{error}</p>
            ) : scope === "team" && teamReport ? (
              <div className="space-y-6">
                <p className="text-sm text-muted-foreground">
                  {formatDisplayDate(teamReport.weekStart)} – {formatDisplayDate(teamReport.weekEnd)}
                </p>
                {teamReport.employees.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No one logged hours this week.</p>
                ) : (
                  teamReport.employees.map((e, i) => (
                    <div key={i} className="space-y-2">
                      <h4 className="text-sm font-semibold text-foreground">
                        {e.employee.name} <span className="font-normal text-muted-foreground">· {e.employee.department || "—"}</span>
                      </h4>
                      <div className="overflow-x-auto rounded-md border border-border">
                        {renderShiftTable(e.shifts, e.totals)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : ownReport ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {formatDisplayDate(ownReport.weekStart)} – {formatDisplayDate(ownReport.weekEnd)}
                </p>
                <div className="overflow-x-auto rounded-md border border-border">
                  {renderShiftTable(ownReport.shifts, ownReport.totals)}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
