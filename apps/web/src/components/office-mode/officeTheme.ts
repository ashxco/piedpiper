export interface OfficeThemeColors {
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  secondary: string;
  border: string;
  wallColor: string;
  floorColor: string;
  hallwayColor: string;
  deskColor: string;
  chairColor: string;
  labelColor: string;
  sublabelColor: string;
}

const STATUS_COLORS_DARK: Record<string, string> = {
  "Pending Approval": "#fcd34d",
  "Awaiting Input": "#a5b4fc",
  Working: "#7dd3fc",
  Connecting: "#7dd3fc",
  "Plan Ready": "#c4b5fd",
  Completed: "#6ee7b7",
};

const STATUS_COLORS_LIGHT: Record<string, string> = {
  "Pending Approval": "#f59e0b",
  "Awaiting Input": "#6366f1",
  Working: "#0ea5e9",
  Connecting: "#0ea5e9",
  "Plan Ready": "#8b5cf6",
  Completed: "#10b981",
};

export function resolveStatusColor(
  label: string | null,
  isDark: boolean,
  fallback: string,
): string {
  if (!label) return fallback;
  const map = isDark ? STATUS_COLORS_DARK : STATUS_COLORS_LIGHT;
  return map[label] ?? fallback;
}

export function resolveOfficeTheme(isDark: boolean): OfficeThemeColors {
  if (isDark) {
    return {
      background: "#0a0a0b",
      foreground: "#f5f5f5",
      muted: "rgba(255,255,255,0.04)",
      mutedForeground: "rgba(255,255,255,0.4)",
      secondary: "rgba(255,255,255,0.06)",
      border: "rgba(255,255,255,0.08)",
      wallColor: "rgba(255,255,255,0.15)",
      floorColor: "rgba(255,255,255,0.03)",
      hallwayColor: "rgba(255,255,255,0.02)",
      deskColor: "rgba(255,255,255,0.08)",
      chairColor: "rgba(255,255,255,0.05)",
      labelColor: "rgba(255,255,255,0.9)",
      sublabelColor: "rgba(255,255,255,0.4)",
    };
  }
  return {
    background: "#ffffff",
    foreground: "#1a1a1a",
    muted: "rgba(0,0,0,0.04)",
    mutedForeground: "rgba(0,0,0,0.4)",
    secondary: "rgba(0,0,0,0.04)",
    border: "rgba(0,0,0,0.08)",
    wallColor: "rgba(0,0,0,0.2)",
    floorColor: "rgba(0,0,0,0.02)",
    hallwayColor: "rgba(0,0,0,0.015)",
    deskColor: "rgba(0,0,0,0.06)",
    chairColor: "rgba(0,0,0,0.04)",
    labelColor: "rgba(0,0,0,0.85)",
    sublabelColor: "rgba(0,0,0,0.4)",
  };
}
