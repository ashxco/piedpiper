import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StartTruncatedPath } from "./StartTruncatedPath";

const path = "apps/web/src/components/very/long/GitActionsControl.tsx";

describe("StartTruncatedPath", () => {
  it("keeps the filename at the visible end by truncating from the start", () => {
    const markup = renderToStaticMarkup(<StartTruncatedPath path={path} />);

    expect(markup).toContain('dir="rtl"');
    expect(markup).toMatch(
      /<bdi[^>]*>apps\/web\/src\/components\/very\/long\/GitActionsControl\.tsx<\/bdi>/,
    );
    for (const className of ["overflow-hidden", "text-ellipsis", "whitespace-nowrap", "min-w-0"]) {
      expect(markup).toContain(className);
    }
  });

  it("renders as a tooltip trigger so the full path shows on hover", () => {
    const markup = renderToStaticMarkup(<StartTruncatedPath path={path} />);

    expect(markup).toContain('data-slot="tooltip-trigger"');
  });
});
