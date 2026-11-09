import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, type ComponentProps } from "react";

import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { serializeTableElementToCsv, serializeTableElementToMarkdown } from "../markdown-clipboard";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { toastManager } from "./ui/toast";

type TableCopyFormat = "markdown" | "csv";

/** A chat table in its own horizontal scroll area, with a footer to copy it as Markdown or CSV. */
export function ChatMarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<TableCopyFormat>({
    timeout: 1200,
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Could not copy table",
        description: error.message,
      }),
  });
  const copyLabel = isCopied ? "Copied" : "Copy table";

  const handleCopy = (format: TableCopyFormat) => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    copyToClipboard(
      format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table),
      format,
    );
  };

  return (
    <div ref={containerRef} className="chat-markdown-table-container">
      <div className="chat-markdown-table-scroll max-w-full overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
      <div className="mt-0.5 flex items-center justify-end select-none">
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={copyLabel}
                title={copyLabel}
              />
            }
          >
            {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
