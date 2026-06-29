"use client"

import { useEffect, useState } from "react"
import { Sun, Moon } from "lucide-react"
import { Button } from "@/components/ui/button"

const STORAGE_KEY = "hojaytrack-theme"

export function ThemeToggle() {
  // Starts null so we render nothing until we know the real saved
  // preference — avoids a flash of the wrong theme on first paint.
  const [isDark, setIsDark] = useState<boolean | null>(null)

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    const prefersDark = saved === "dark" || (saved === null && window.matchMedia("(prefers-color-scheme: dark)").matches)
    setIsDark(prefersDark)
    document.documentElement.classList.toggle("dark", prefersDark)
  }, [])

  const toggle = () => {
    const next = !isDark
    setIsDark(next)
    document.documentElement.classList.toggle("dark", next)
    localStorage.setItem(STORAGE_KEY, next ? "dark" : "light")
  }

  if (isDark === null) {
    // Reserve the same space so layout doesn't jump once it mounts.
    return <div className="h-9 w-9" aria-hidden="true" />
  }

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="shrink-0"
    >
      {isDark ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
    </Button>
  )
}
