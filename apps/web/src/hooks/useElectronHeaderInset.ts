import { useSidebar } from "../components/ui/sidebar";
import { isElectron } from "../env";
import {
  MACOS_TRAFFIC_LIGHTS_INSET,
  useMacosTrafficLightInset,
} from "./useDesktopWindowFullscreen";

// Where the fixed sidebar toggle starts when the traffic lights are hidden or absent.
const WINDOW_EDGE_INSET_PX = 16;
// The fixed 28px toggle plus the gap before the header content.
const SIDEBAR_TOGGLE_CLEARANCE_PX = 38;

export function resolveElectronHeaderInsetPx(input: {
  readonly isElectron: boolean;
  readonly sidebarState: "expanded" | "collapsed";
  readonly sidebarIsMobile: boolean;
  readonly reserveTrafficLights: boolean;
}): number | string | undefined {
  // A sheet sidebar is not docked, so the header must clear the window controls even when "expanded".
  if (!input.isElectron || (input.sidebarState !== "collapsed" && !input.sidebarIsMobile)) {
    return undefined;
  }
  return input.reserveTrafficLights
    ? `calc(${MACOS_TRAFFIC_LIGHTS_INSET} + ${SIDEBAR_TOGGLE_CLEARANCE_PX}px)`
    : WINDOW_EDGE_INSET_PX + SIDEBAR_TOGGLE_CLEARANCE_PX;
}

/** Left padding a header needs to clear the fixed Electron sidebar toggle, or undefined when docked. */
export function useElectronHeaderInsetPx(): number | string | undefined {
  const { state, isMobile } = useSidebar();
  const reserveTrafficLights = useMacosTrafficLightInset();
  return resolveElectronHeaderInsetPx({
    isElectron,
    sidebarState: state,
    sidebarIsMobile: isMobile,
    reserveTrafficLights,
  });
}
