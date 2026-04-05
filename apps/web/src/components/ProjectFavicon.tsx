import { FolderIcon, FolderOpenIcon } from "lucide-react";
import { useState } from "react";
import { resolveServerUrl } from "~/lib/utils";

const loadedProjectFaviconSrcs = new Set<string>();

export function ProjectFavicon({
  cwd,
  className,
  expanded = false,
}: {
  cwd: string;
  className?: string;
  expanded?: boolean;
}) {
  const src = resolveServerUrl({
    protocol: "http",
    pathname: "/api/project-favicon",
    searchParams: { cwd },
  });
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading",
  );

  const FolderGlyph = expanded ? FolderOpenIcon : FolderIcon;

  return (
    <>
      {status !== "loaded" ? (
        <FolderGlyph className={`size-3.5 shrink-0 text-white/50 ${className ?? ""}`} />
      ) : null}
      <img
        src={src}
        alt=""
        className={`size-3.5 shrink-0 rounded-sm object-contain dark:brightness-100 brightness-0 dark:invert-0 ${status === "loaded" ? "" : "hidden"} ${className ?? ""}`}
        onLoad={() => {
          loadedProjectFaviconSrcs.add(src);
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}
