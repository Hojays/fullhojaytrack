"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { 
  Settings, 
  Clock, 
  CalendarDays, 
  AlertTriangle, 
  Save, 
  RotateCcw,
  Info,
  Shield,
  Bell
} from "lucide-react"
import { DashboardHeader } from "@/components/dashboard-header"
import { DEFAULT_OVERTIME_CONFIG, type OvertimeConfig } from "@/lib/mock-data"

const API_BASE = "/api"

export function SystemConfiguration() {
  const [config, setConfig] = useState<OvertimeConfig>(DEFAULT_OVERTIME_CONFIG)
  const [hasChanges, setHasChanges] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState("")
  const [saveMessage, setSaveMessage] = useState("")

  const fetchSettings = useCallback(async () => {
    setError("")
    try {
      const res = await fetch(`${API_BASE}/admin-settings`, { credentials: "include" })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.error ?? "Could not load the current settings.")
        return
      }
      setConfig(data.settings)
      setHasChanges(false)
    } catch {
      setError("Could not reach the server to load settings.")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const handleInputChange = (field: keyof OvertimeConfig, value: number | boolean) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setHasChanges(true)
    setSaveMessage("")
  }

  const handleSave = async () => {
    setIsSaving(true)
    setError("")
    setSaveMessage("")
    try {
      const res = await fetch(`${API_BASE}/admin-settings`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.error ?? "Could not save these settings.")
        return
      }
      setConfig(data.settings)
      setHasChanges(false)
      setSaveMessage("Configuration saved. These rules now apply to every employee's hours.")
    } catch {
      setError("Could not reach the server to save settings.")
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = () => {
    // Resets the form back to whatever is actually saved on the server
    // right now — not a local mock default — so "Reset" means "undo my
    // unsaved edits," not "wipe the real configuration."
    fetchSettings()
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <DashboardHeader
        title="System Configuration"
        description="Configure overtime rules and system thresholds for payroll calculations"
      >
        {hasChanges && (
          <Badge variant="secondary" className="bg-warning/20 text-warning-foreground">
            Unsaved Changes
          </Badge>
        )}
      </DashboardHeader>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading current settings…</p>
      ) : (
        <>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              {error}
            </div>
          )}
          {saveMessage && (
            <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-sm text-success">
              {saveMessage}
            </div>
          )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Configuration Panel */}
        <div className="space-y-6 lg:col-span-2">
          {/* Overtime Rules */}
          <Card className="transition-all duration-200 hover:shadow-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <Clock className="h-5 w-5 text-primary" aria-hidden="true" />
                Overtime Rules Configuration
              </CardTitle>
              <CardDescription>Set the thresholds that determine when overtime pay applies</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="dailyThreshold" className="text-foreground">Daily Overtime Threshold</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="dailyThreshold"
                      type="number"
                      min={1}
                      max={24}
                      value={config.dailyThreshold}
                      onChange={(e) => handleInputChange("dailyThreshold", Number(e.target.value))}
                      className="bg-background text-foreground transition-all duration-200 focus:ring-2 focus:ring-ring"
                      aria-describedby="dailyThreshold-description"
                    />
                    <span className="text-sm text-muted-foreground">hours/day</span>
                  </div>
                  <p id="dailyThreshold-description" className="text-xs text-muted-foreground">
                    Hours worked beyond this daily limit qualify as overtime
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="weeklyThreshold" className="text-foreground">Weekly Overtime Threshold</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="weeklyThreshold"
                      type="number"
                      min={1}
                      max={168}
                      value={config.weeklyThreshold}
                      onChange={(e) => handleInputChange("weeklyThreshold", Number(e.target.value))}
                      className="bg-background text-foreground transition-all duration-200 focus:ring-2 focus:ring-ring"
                      aria-describedby="weeklyThreshold-description"
                    />
                    <span className="text-sm text-muted-foreground">hours/week</span>
                  </div>
                  <p id="weeklyThreshold-description" className="text-xs text-muted-foreground">
                    Hours worked beyond this weekly limit qualify as overtime
                  </p>
                </div>
              </div>

              <Separator />

              <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="overtimeMultiplier" className="text-foreground">Overtime Pay Multiplier</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="overtimeMultiplier"
                      type="number"
                      min={1}
                      max={5}
                      step={0.1}
                      value={config.overtimeMultiplier}
                      onChange={(e) => handleInputChange("overtimeMultiplier", Number(e.target.value))}
                      className="bg-background text-foreground transition-all duration-200 focus:ring-2 focus:ring-ring"
                      aria-describedby="overtimeMultiplier-description"
                    />
                    <span className="text-sm text-muted-foreground">x regular rate</span>
                  </div>
                  <p id="overtimeMultiplier-description" className="text-xs text-muted-foreground">
                    Standard overtime is paid at {config.overtimeMultiplier}x
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="doubleTimeThreshold" className="text-foreground">Double Time Threshold</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="doubleTimeThreshold"
                      type="number"
                      min={1}
                      max={24}
                      value={config.doubleTimeThreshold}
                      onChange={(e) => handleInputChange("doubleTimeThreshold", Number(e.target.value))}
                      className="bg-background text-foreground transition-all duration-200 focus:ring-2 focus:ring-ring"
                      aria-describedby="doubleTimeThreshold-description"
                    />
                    <span className="text-sm text-muted-foreground">hours/day</span>
                  </div>
                  <p id="doubleTimeThreshold-description" className="text-xs text-muted-foreground">
                    Hours beyond this qualify for double time ({config.doubleTimeMultiplier}x)
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* System Limits */}
          <Card className="transition-all duration-200 hover:shadow-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <AlertTriangle className="h-5 w-5 text-warning" aria-hidden="true" />
                System Limits
              </CardTitle>
              <CardDescription>Set maximum allowed hours and break deductions</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="maxWeeklyHours" className="text-foreground">Maximum Weekly Hours</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="maxWeeklyHours"
                      type="number"
                      min={40}
                      max={168}
                      value={config.maxWeeklyHours}
                      onChange={(e) => handleInputChange("maxWeeklyHours", Number(e.target.value))}
                      className="bg-background text-foreground transition-all duration-200 focus:ring-2 focus:ring-ring"
                      aria-describedby="maxWeeklyHours-description"
                    />
                    <span className="text-sm text-muted-foreground">hours</span>
                  </div>
                  <p id="maxWeeklyHours-description" className="text-xs text-muted-foreground">
                    Employees cannot log more than this per week
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="breakDeduction" className="text-foreground">Auto Break Deduction</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="breakDeduction"
                      type="number"
                      min={0}
                      max={120}
                      value={config.breakDeductionMinutes}
                      onChange={(e) => handleInputChange("breakDeductionMinutes", Number(e.target.value))}
                      className="bg-background text-foreground transition-all duration-200 focus:ring-2 focus:ring-ring"
                      aria-describedby="breakDeduction-description"
                    />
                    <span className="text-sm text-muted-foreground">minutes</span>
                  </div>
                  <p id="breakDeduction-description" className="text-xs text-muted-foreground">
                    Automatically deducted for shifts over 6 hours
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Toggle Settings */}
          <Card className="transition-all duration-200 hover:shadow-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <Settings className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                Policy Settings
              </CardTitle>
              <CardDescription>Enable or disable overtime policies and approval workflows</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="weekendOvertime" className="text-foreground">Weekend Overtime</Label>
                  <p className="text-xs text-muted-foreground">Apply overtime rates for Saturday and Sunday work</p>
                </div>
                <Switch
                  id="weekendOvertime"
                  checked={config.enableWeekendOvertime}
                  onCheckedChange={(checked) => handleInputChange("enableWeekendOvertime", checked)}
                  aria-label="Enable weekend overtime"
                />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="holidayOvertime" className="text-foreground">Holiday Overtime</Label>
                  <p className="text-xs text-muted-foreground">Apply overtime rates for designated holidays</p>
                </div>
                <Switch
                  id="holidayOvertime"
                  checked={config.enableHolidayOvertime}
                  onCheckedChange={(checked) => handleInputChange("enableHolidayOvertime", checked)}
                  aria-label="Enable holiday overtime"
                />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="autoApprove" className="text-foreground">Auto-Approve Regular Hours</Label>
                  <p className="text-xs text-muted-foreground">Automatically approve timesheets within regular hour limits</p>
                </div>
                <Switch
                  id="autoApprove"
                  checked={config.autoApproveRegularHours}
                  onCheckedChange={(checked) => handleInputChange("autoApproveRegularHours", checked)}
                  aria-label="Enable auto-approve for regular hours"
                />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="managerApproval" className="text-foreground">Require Manager Approval</Label>
                  <p className="text-xs text-muted-foreground">All overtime must be approved by a manager</p>
                </div>
                <Switch
                  id="managerApproval"
                  checked={config.requireManagerApproval}
                  onCheckedChange={(checked) => handleInputChange("requireManagerApproval", checked)}
                  aria-label="Require manager approval for overtime"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Actions Card */}
          <Card className="transition-all duration-200 hover:shadow-md">
            <CardHeader>
              <CardTitle className="text-foreground">Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button 
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground transition-all duration-200 focus:ring-2 focus:ring-primary focus:ring-offset-2" 
                onClick={handleSave}
                disabled={!hasChanges || isSaving}
                aria-label="Save configuration changes"
              >
                <Save className="mr-2 h-4 w-4" aria-hidden="true" />
                {isSaving ? "Saving…" : "Save Configuration"}
              </Button>
              <Button 
                variant="outline" 
                className="w-full transition-all duration-200 focus:ring-2 focus:ring-ring focus:ring-offset-2" 
                onClick={handleReset}
                aria-label="Reset configuration to defaults"
              >
                <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                Reset to Defaults
              </Button>
            </CardContent>
          </Card>

          {/* Current Settings Summary */}
          <Card className="transition-all duration-200 hover:shadow-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-foreground">
                <CalendarDays className="h-5 w-5" aria-hidden="true" />
                Current Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg bg-muted/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Daily Threshold</span>
                  <span className="font-medium text-foreground">{config.dailyThreshold}h</span>
                </div>
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Weekly Threshold</span>
                  <span className="font-medium text-foreground">{config.weeklyThreshold}h</span>
                </div>
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">OT Multiplier</span>
                  <span className="font-medium text-foreground">{config.overtimeMultiplier}x</span>
                </div>
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Max Weekly</span>
                  <span className="font-medium text-foreground">{config.maxWeeklyHours}h</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Info Cards */}
          <Card className="border-primary/30 bg-primary/5 transition-all duration-200 hover:shadow-md">
            <CardContent className="flex items-start gap-3 pt-6">
              <Info className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-foreground">Compliance Note</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  These settings must comply with local labor laws. Consult HR before making changes.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-accent/30 bg-accent/5 transition-all duration-200 hover:shadow-md">
            <CardContent className="flex items-start gap-3 pt-6">
              <Shield className="h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-foreground">Admin Only</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Changes to system configuration require administrator privileges.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-warning/30 bg-warning/5 transition-all duration-200 hover:shadow-md">
            <CardContent className="flex items-start gap-3 pt-6">
              <Bell className="h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-foreground">Notifications</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Managers will be notified when configuration changes are saved.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
        </>
      )}
    </div>
  )
}
