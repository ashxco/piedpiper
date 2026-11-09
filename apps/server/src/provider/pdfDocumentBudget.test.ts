import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildClaudePdfDocumentBlock,
  CLAUDE_SESSION_ATTACHMENT_MAX_BYTES,
  CLAUDE_SESSION_ATTACHMENT_MAX_PAGES,
  claudeBase64RetainedBytes,
  estimateClaudePdfPages,
  makeClaudeAttachmentBudget,
} from "./pdfDocumentBudget.ts";

function pdfWithPages(pages: number, count = pages): Buffer {
  const pageObjects = Array.from(
    { length: pages },
    (_, index) => `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`,
  ).join("");
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `2 0 obj\n<< /Type /Pages /Kids [] /Count ${count} >>\nendobj\n${pageObjects}%%EOF\n`,
    "latin1",
  );
}

describe("estimateClaudePdfPages", () => {
  it("counts an explicit page tree", () => {
    expect(estimateClaudePdfPages(pdfWithPages(3))).toBe(3);
    expect(estimateClaudePdfPages(new Uint8Array(pdfWithPages(2)))).toBe(2);
  });

  it("ignores page-like text inside streams and strings", () => {
    const pdf = Buffer.from(
      `%PDF-1.4\n<< /Type /Catalog >>\n<< /Type /Pages /Kids [] /Count 1 >>\n<< /Type /Page >>\n` +
        `(/Type /Page)\n<< /Length 9 >>\nstream\n/Type /Page\nendstream\n%%EOF\n`,
      "latin1",
    );
    expect(estimateClaudePdfPages(pdf)).toBe(1);
  });

  it("returns null whenever the count cannot be trusted", () => {
    expect(estimateClaudePdfPages(pdfWithPages(3, 4))).toBeNull();
    expect(estimateClaudePdfPages(Buffer.from("not a pdf %%EOF"))).toBeNull();
    expect(estimateClaudePdfPages(Buffer.from("%PDF-1.4\n<< /Type /Page >>\n"))).toBeNull();
    const compressed = Buffer.concat([pdfWithPages(1), Buffer.from("<< /Type /ObjStm >>\n%%EOF")]);
    expect(estimateClaudePdfPages(compressed)).toBeNull();
    const encrypted = Buffer.concat([pdfWithPages(1), Buffer.from("<< /Encrypt 9 0 R >>\n%%EOF")]);
    expect(estimateClaudePdfPages(encrypted)).toBeNull();
    const indirect = Buffer.from(
      "%PDF-1.4\n<< /Type /Catalog >>\n<< /Type /Pages /Count 1 0 R >>\n<< /Type /Page >>\n%%EOF",
    );
    expect(estimateClaudePdfPages(indirect)).toBeNull();
    const tooLarge = Buffer.alloc(PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1);
    pdfWithPages(1).copy(tooLarge);
    expect(estimateClaudePdfPages(tooLarge)).toBeNull();
  });
});

describe("makeClaudeAttachmentBudget", () => {
  it("does not scan a PDF that cannot fit the remaining budget", () => {
    const estimatePages = vi.fn(estimateClaudePdfPages);
    const pdf = pdfWithPages(2);

    const resumed = makeClaudeAttachmentBudget({ resumed: true, estimatePages });
    expect(
      resumed.reserve({ textBytes: 0, imageBytes: [], pdfs: [pdf] }).documentIndexes.size,
    ).toBe(0);
    expect(estimatePages).not.toHaveBeenCalled();

    const fresh = makeClaudeAttachmentBudget({ estimatePages });
    expect(fresh.reserve({ textBytes: 0, imageBytes: [], pdfs: [pdf] }).documentIndexes.size).toBe(
      1,
    );
    expect(estimatePages).toHaveBeenCalledTimes(1);
  });

  it("reserves text and images before any PDF", () => {
    const budget = makeClaudeAttachmentBudget();
    const pdf = pdfWithPages(1);
    const reservation = budget.reserve({
      textBytes: 10,
      imageBytes: [CLAUDE_SESSION_ATTACHMENT_MAX_BYTES],
      pdfs: [pdf],
    });
    expect(reservation.documentIndexes.size).toBe(0);
  });

  it("takes each PDF that fits and skips the rest by pages", () => {
    const budget = makeClaudeAttachmentBudget();
    const reservation = budget.reserve({
      textBytes: 10,
      imageBytes: [],
      pdfs: [
        pdfWithPages(CLAUDE_SESSION_ATTACHMENT_MAX_PAGES - 1),
        pdfWithPages(2),
        pdfWithPages(1),
      ],
    });
    expect([...reservation.documentIndexes]).toEqual([0, 2]);
    expect(budget.remainingPages()).toBe(0);
  });

  it("leaves a PDF with an unknown page count path-only", () => {
    const budget = makeClaudeAttachmentBudget();
    const reservation = budget.reserve({
      textBytes: 0,
      imageBytes: [],
      pdfs: [Buffer.from("%PDF-1.4\nno page tree\n%%EOF")],
    });
    expect(reservation.documentIndexes.size).toBe(0);
    expect(budget.remainingPages()).toBe(CLAUDE_SESSION_ATTACHMENT_MAX_PAGES);
  });

  it("returns everything on rollback and ignores a late rollback after commit", () => {
    const budget = makeClaudeAttachmentBudget();
    const pdf = pdfWithPages(2);
    const rolledBack = budget.reserve({ textBytes: 5, imageBytes: [100], pdfs: [pdf] });
    rolledBack.rollback();
    rolledBack.rollback();
    expect(budget.remainingPages()).toBe(CLAUDE_SESSION_ATTACHMENT_MAX_PAGES);
    expect(budget.remainingBytes()).toBe(CLAUDE_SESSION_ATTACHMENT_MAX_BYTES);

    const committed = budget.reserve({ textBytes: 5, imageBytes: [], pdfs: [pdf] });
    committed.commit();
    committed.rollback();
    expect(budget.remainingPages()).toBe(CLAUDE_SESSION_ATTACHMENT_MAX_PAGES - 2);
    expect(budget.remainingBytes()).toBe(
      CLAUDE_SESSION_ATTACHMENT_MAX_BYTES - 5 - claudeBase64RetainedBytes(pdf.byteLength),
    );
  });

  it("releases only what a full compaction removed", () => {
    const budget = makeClaudeAttachmentBudget();
    budget.reserve({ textBytes: 0, imageBytes: [], pdfs: [pdfWithPages(4)] }).commit();

    budget.compactionStarted();
    budget.compactionFinished({ full: false });
    expect(budget.remainingPages()).toBe(CLAUDE_SESSION_ATTACHMENT_MAX_PAGES - 4);

    budget.compactionStarted();
    budget.reserve({ textBytes: 0, imageBytes: [], pdfs: [pdfWithPages(3)] }).commit();
    budget.compactionFinished({ full: true });
    expect(budget.remainingPages()).toBe(CLAUDE_SESSION_ATTACHMENT_MAX_PAGES - 3);
  });

  it("keeps the budget when compaction aborts", () => {
    const budget = makeClaudeAttachmentBudget();
    budget.reserve({ textBytes: 0, imageBytes: [], pdfs: [pdfWithPages(4)] }).commit();
    budget.compactionStarted();
    budget.compactionAborted();
    expect(budget.remainingPages()).toBe(CLAUDE_SESSION_ATTACHMENT_MAX_PAGES - 4);
  });

  it("keeps a resumed session path-only until a full compaction", () => {
    const budget = makeClaudeAttachmentBudget({ resumed: true });
    const pdf = pdfWithPages(1);
    expect(budget.reserve({ textBytes: 0, imageBytes: [], pdfs: [pdf] }).documentIndexes.size).toBe(
      0,
    );
    budget.compactionFinished({ full: true });
    expect(budget.reserve({ textBytes: 0, imageBytes: [], pdfs: [pdf] }).documentIndexes.size).toBe(
      1,
    );
  });
});

describe("buildClaudePdfDocumentBlock", () => {
  it("builds a base64 document block", () => {
    expect(buildClaudePdfDocumentBlock(Buffer.from("%PDF-"))).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
    });
  });
});
