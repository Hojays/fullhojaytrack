"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { User as UserIcon, Mail, Building2, Hash, ShieldCheck } from "lucide-react"
import { DashboardHeader } from "@/components/dashboard-header"

const API_BASE = "/api"

interface ProfileData {
  email: string
  name: string
  role: string
  department: string
  employeeId: string
}

export function MyProfile() {
  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const res = await fetch(`${API_BASE}/me`, { credentials: "include" })
        const data = await res.json()
        if (res.ok && data.success) {
          setProfile(data.user)
        } else {
          setError(data.error ?? "Could not load your profile.")
        }
      } catch {
        setError("Could not reach the server to load your profile.")
      } finally {
        setIsLoading(false)
      }
    }
    fetchProfile()
  }, [])

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <DashboardHeader title="My Profile" description="Your account details" />

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-foreground">Account Details</CardTitle>
          <CardDescription>
            Need something changed here? Only an admin can update these — ask them directly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : profile ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 pb-2">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                  <UserIcon className="h-6 w-6 text-primary" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-lg font-semibold text-foreground">{profile.name}</p>
                  <Badge variant="secondary" className="capitalize">{profile.role}</Badge>
                </div>
              </div>

              <div className="space-y-3 border-t border-border pt-4">
                <div className="flex items-center gap-3">
                  <Mail className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div>
                    <p className="text-xs text-muted-foreground">Email</p>
                    <p className="text-sm text-foreground">{profile.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Hash className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div>
                    <p className="text-xs text-muted-foreground">Employee ID</p>
                    <p className="text-sm text-foreground">{profile.employeeId || "—"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div>
                    <p className="text-xs text-muted-foreground">Department</p>
                    <p className="text-sm text-foreground">{profile.department || "—"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div>
                    <p className="text-xs text-muted-foreground">Role</p>
                    <p className="text-sm capitalize text-foreground">{profile.role}</p>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
