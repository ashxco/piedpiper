import { FolderIcon, FolderOpenIcon } from "lucide-react";
import { useState } from "react";
import { resolveServerUrl } from "~/lib/utils";
import { appendAuthToken } from "~/rpc/authToken";
import { useStore } from "~/store";
import {
  projectFaviconSearchParams,
  projectFaviconToneClass,
  readProjectFaviconPath,
  readProjectFaviconVersion,
} from "./ProjectFavicon.logic";

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
  const faviconPath = useStore((state) =>
    readProjectFaviconPath(state.projects.find((project) => project.cwd === cwd)),
  );
  const faviconVersion = useStore((state) =>
    readProjectFaviconVersion(state.projects.find((project) => project.cwd === cwd)),
  );
  // `<img>` requests cannot set headers, and in desktop mode no auth cookie is
  // written, so carry the token as a query parameter.
  const src = appendAuthToken(
    resolveServerUrl({
      protocol: "http",
      pathname: "/api/project-favicon",
      searchParams: projectFaviconSearchParams(cwd, faviconPath, faviconVersion),
    }),
  );
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
        key={src}
        src={src}
        alt=""
        className={`size-3.5 shrink-0 rounded-sm object-contain ${projectFaviconToneClass(faviconPath)} ${status === "loaded" ? "" : "hidden"} ${className ?? ""}`}
        onLoad={() => {
          loadedProjectFaviconSrcs.add(src);
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}
