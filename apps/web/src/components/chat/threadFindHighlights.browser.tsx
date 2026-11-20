import { afterEach, expect, it, vi } from "vitest";

import { revealThreadFindMatch } from "./threadFindHighlights";

function wideTable(cellText: string): string {
  const columns = Array.from({ length: 12 }, (_, index) => `<td>DiagnosticsColumn${index}</td>`);
  return `<table style="white-space: nowrap"><tbody><tr><td>${cellText}</td>${columns.join("")}<td>${cellText}</td></tr></tbody></table>`;
}

function mount(html: string): { container: HTMLElement; scrollContainer: HTMLElement } {
  const scrollContainer = document.createElement("div");
  scrollContainer.style.cssText = "height: 400px; width: 320px; overflow: auto;";
  scrollContainer.innerHTML = `<div data-timeline-row-id="row"><div data-thread-find-text>${html}</div></div>`;
  document.body.append(scrollContainer);
  return { container: scrollContainer, scrollContainer };
}

const SCROLLER = 'class="chat-markdown-table-scroll" style="max-width: 100%; overflow-x: auto"';

afterEach(() => {
  document.body.replaceChildren();
});

it("scrolls a wide table to the match without scrolling a sibling table", async () => {
  const { container, scrollContainer } = mount(
    `<div ${SCROLLER}>${wideTable("needle")}</div><div ${SCROLLER}>${wideTable("needle")}</div>`,
  );
  const [table, sibling] = container.querySelectorAll<HTMLElement>(".chat-markdown-table-scroll");
  table!.scrollLeft = table!.scrollWidth;
  sibling!.scrollLeft = sibling!.scrollWidth;
  const siblingOffset = sibling!.scrollLeft;
  expect(siblingOffset).toBeGreaterThan(0);
  const clip = table!.getBoundingClientRect();
  const firstCell = table!.querySelector("td")!;
  expect(firstCell.getBoundingClientRect().right).toBeLessThan(clip.left);

  const stop = revealThreadFindMatch({
    container,
    scrollContainer,
    position: { rowId: "row", occurrence: 0 },
    foldedQuery: "needle",
    scrollRowIntoWindow: () => undefined,
  });
  try {
    await vi.waitFor(() => {
      expect(firstCell.getBoundingClientRect().left).toBeGreaterThanOrEqual(clip.left - 1);
    });
    expect(sibling!.scrollLeft).toBe(siblingOffset);
  } finally {
    stop();
  }
});

it("reveals a match in a nested table clipped by the outer table", async () => {
  const columns = Array.from({ length: 12 }, (_, index) => `<td>DiagnosticsColumn${index}</td>`);
  const { container, scrollContainer } = mount(
    `<div ${SCROLLER}><table style="white-space: nowrap"><tbody><tr>${columns.join("")}<td><div ${SCROLLER}><table><tbody><tr><td>needle</td></tr></tbody></table></div></td></tr></tbody></table></div>`,
  );
  const outer = container.querySelector<HTMLElement>(".chat-markdown-table-scroll")!;
  const nestedCell = outer.querySelector("table table td")!;
  const clip = outer.getBoundingClientRect();
  expect(nestedCell.getBoundingClientRect().left).toBeGreaterThan(clip.right);

  const stop = revealThreadFindMatch({
    container,
    scrollContainer,
    position: { rowId: "row", occurrence: 0 },
    foldedQuery: "needle",
    scrollRowIntoWindow: () => undefined,
  });
  try {
    await vi.waitFor(() => {
      const bounds = nestedCell.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(clip.left - 1);
      expect(bounds.right).toBeLessThanOrEqual(clip.right + 1);
    });
  } finally {
    stop();
  }
});
