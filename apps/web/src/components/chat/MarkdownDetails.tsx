import { ChevronRightIcon } from "lucide-react";
import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { THREAD_FIND_REVEAL_EVENT } from "./threadFindHighlights";

/** A `<details>` written in a chat message, drawn with the app's collapsible. */
export function MarkdownDetails({
  children,
  open = false,
  dir,
}: Pick<ComponentProps<"details">, "children" | "open" | "dir">) {
  const [isOpen, setIsOpen] = useState(open);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reveal = () => setIsOpen(true);
    root.addEventListener(THREAD_FIND_REVEAL_EVENT, reveal);
    return () => root.removeEventListener(THREAD_FIND_REVEAL_EVENT, reveal);
  }, []);
  const childNodes = Children.toArray(children);
  const summaryIndex = childNodes.findIndex(
    (child) => isValidElement(child) && child.type === "summary",
  );
  const summaryNode = summaryIndex >= 0 ? childNodes[summaryIndex] : null;
  const summary =
    isValidElement<{ children?: ReactNode }>(summaryNode) && summaryNode.props.children
      ? summaryNode.props.children
      : "Details";
  const content = childNodes.filter((_, index) => index !== summaryIndex);

  return (
    <div
      ref={rootRef}
      className="my-2 border-y border-border/60"
      dir={dir}
      data-thread-find-fold={isOpen ? undefined : ""}
    >
      <Collapsible open={isOpen} onOpenChange={setIsOpen} data-markdown-details="">
        <CollapsibleTrigger
          className="flex w-full items-center gap-2 py-2 text-start text-sm font-medium text-foreground data-panel-open:[&>svg]:rotate-90"
          data-markdown-details-summary=""
        >
          <ChevronRightIcon
            className="size-4 shrink-0 text-muted-foreground transition-transform rtl:-scale-x-100"
            aria-hidden
          />
          <span>{summary}</span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="pb-3 ps-6" data-markdown-details-content="">
            {content}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
